import { minMaxItemsForType } from "../../attributes/Constraints.js";
import type { Name } from "../../Naming.js";
import {
    type MultiWord,
    type Sourcelike,
    modifySource,
    parenIfNeeded,
    singleWord,
} from "../../Source.js";
import { camelCase, utf16StringEscape } from "../../support/Strings.js";
import {
    ArrayType,
    type ClassType,
    EnumType,
    ObjectType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import { isNamedType } from "../../Type/TypeUtils.js";
import type { JavaScriptTypeAnnotations } from "../JavaScript/index.js";

import { TypeScriptFlowBaseRenderer } from "./TypeScriptFlowBaseRenderer.js";
import { tsFlowTypeAnnotations } from "./utils.js";

// An array type with a huge `minItems` would otherwise expand into an
// equally huge tuple type, so beyond this limit we fall back to a plain
// array type.
const maxSpelledOutMinItems = 16;

// Whether values of `t` are checked against classes: if it's one, or a
// union or an array of one.
function hasClasses(t: Type, seen: Set<Type> = new Set()): boolean {
    if (seen.has(t)) return false;
    seen.add(t);

    if (t instanceof ObjectType) return true;
    if (t instanceof ArrayType) return hasClasses(t.items, seen);
    if (t instanceof UnionType) {
        return Array.from(t.members).some((m) => hasClasses(m, seen));
    }

    return false;
}

// Whether a union keeps classes apart: if it has several, or several arrays
// of classes.
function keepsClassesApart(u: UnionType): boolean {
    const members = Array.from(u.members);
    return (
        members.filter((m) => m instanceof ObjectType).length > 1 ||
        members.filter((m) => m instanceof ArrayType && hasClasses(m.items))
            .length > 1
    );
}

export class TypeScriptRenderer extends TypeScriptFlowBaseRenderer {
    // Whether the type map type of a union that keeps classes apart is being
    // made, see `typeMapTypeFor`.
    private _inUnionOfClasses = false;

    protected get emptyObjectType(): string {
        return "object";
    }

    protected anyType(): string {
        return this._tsFlowOptions.preferUnknown ? "unknown" : "any";
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return ["Array", "Date", "Convert"];
    }

    // A union only keeps classes apart that don't allow additional
    // properties, so an empty one only takes empty objects here.  Checking
    // it as any object, like other empty classes, would also take the values
    // of the other classes.  The same goes for the classes of the arrays a
    // union keeps apart, which their elements are checked against.
    protected typeMapTypeFor(t: Type): Sourcelike {
        if (
            this._inUnionOfClasses &&
            this.emptyObjectTypeFor(t) !== undefined
        ) {
            return "o([], false)";
        }

        if (
            !(t instanceof UnionType) ||
            this._inUnionOfClasses ||
            !keepsClassesApart(t)
        ) {
            return super.typeMapTypeFor(t);
        }

        this._inUnionOfClasses = true;
        try {
            return super.typeMapTypeFor(t);
        } finally {
            this._inUnionOfClasses = false;
        }
    }

    // An array with `minItems` >= 1 becomes a tuple that spells out the
    // guaranteed elements, followed by a rest element: `minItems: 2`
    // renders as `[T, T, ...T[]]`.  Otherwise only `minItems` shapes the
    // type: spelling out `maxItems` would enumerate every allowed arity as
    // its own tuple.  The exception is an exact length (`minItems` equal
    // to `maxItems`), which renders as `[T, T]`.
    protected sourceForArrayType(arrayType: ArrayType): MultiWord {
        const [minItems, maxItems] = minMaxItemsForType(arrayType) ?? [];
        if (
            minItems === undefined ||
            minItems < 1 ||
            minItems > maxSpelledOutMinItems
        ) {
            return super.sourceForArrayType(arrayType);
        }

        const itemType = this.sourceFor(arrayType.items);
        const source: Sourcelike[] = ["["];
        for (let i = 0; i < minItems; i++) {
            if (i > 0) source.push(", ");
            source.push(itemType.source);
        }

        if (maxItems !== minItems) {
            source.push(", ...", parenIfNeeded(itemType), "[]");
        }

        source.push("]");
        return singleWord(source);
    }

    protected uncheckedParsedJson(t: Type, parsedJson: Sourcelike): Sourcelike {
        // With `raw-type any` and `prefer-unknown` the deserializer's
        // parameter is `unknown`, which can't be returned as the target
        // type without a cast.
        if (
            this._tsFlowOptions.rawType !== "json" &&
            this._tsFlowOptions.preferUnknown
        ) {
            return [parsedJson, " as ", this.sourceFor(t).source];
        }

        return parsedJson;
    }

    protected deserializerFunctionLine(t: Type, name: Name): Sourcelike {
        const jsonType =
            this._tsFlowOptions.rawType === "json" ? "string" : this.anyType();
        return [
            "public static to",
            name,
            "(json: ",
            jsonType,
            "): ",
            this.sourceFor(t).source,
        ];
    }

    protected serializerFunctionLine(t: Type, name: Name): Sourcelike {
        const camelCaseName = modifySource(camelCase, name);
        const returnType =
            this._tsFlowOptions.rawType === "json" ? "string" : this.anyType();
        return [
            "public static ",
            camelCaseName,
            "ToJson(value: ",
            this.sourceFor(t).source,
            "): ",
            returnType,
        ];
    }

    protected get moduleLine(): string | undefined {
        return "export class Convert";
    }

    protected get typeAnnotations(): JavaScriptTypeAnnotations {
        return { never: ": never", ...tsFlowTypeAnnotations };
    }

    protected emitModuleExports(): void {}

    protected emitUsageImportComment(givenOutputFilename: string): void {
        const topLevelNames: Sourcelike[] = [];
        this.forEachTopLevel(
            "none",
            (_t, name) => {
                topLevelNames.push(", ", name);
            },
            isNamedType,
        );
        this.emitLine(
            "//   import { Convert",
            topLevelNames,
            ' } from "./',
            this.usageModuleName(givenOutputFilename),
            '";',
        );
    }

    // With `prefer-const-values` an enum with one case isn't declared (its
    // value is used instead), so a top-level of that type is an alias.
    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        if (
            this._tsFlowOptions.preferConstValues &&
            type instanceof EnumType &&
            type.cases.size === 1
        ) {
            return undefined;
        }

        return super.namedTypeToNameForTopLevel(type);
    }

    protected emitEnum(e: EnumType, enumName: Name): void {
        // enums with only one value are emitted as constants
        if (this._tsFlowOptions.preferConstValues && e.cases.size === 1) return;

        this.emitDescription(this.descriptionForType(e));

        if (this._tsFlowOptions.preferUnions) {
            let items = "";
            e.cases.forEach((item) => {
                if (items === "") {
                    items += `"${utf16StringEscape(item)}"`;
                    return;
                }

                items += ` | "${utf16StringEscape(item)}"`;
            });
            this.emitLine("export type ", enumName, " = ", items, ";");
        } else {
            this.emitBlock(["export enum ", enumName, " "], "", () => {
                this.forEachEnumCase(e, "none", (name, jsonName) => {
                    this.emitLine(name, ` = "${utf16StringEscape(jsonName)}",`);
                });
            });
        }
    }

    protected emitClassBlock(c: ClassType, className: Name): void {
        this.emitBlock(
            this._tsFlowOptions.preferTypes
                ? ["export type ", className, " = "]
                : ["export interface ", className, " "],
            "",
            () => {
                this.emitClassBlockBody(c);
            },
        );
    }
}
