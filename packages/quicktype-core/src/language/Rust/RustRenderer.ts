/* eslint-disable @typescript-eslint/naming-convention */
import { iterableSome, mapFirst } from "collection-utils";

import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import { minMaxValueForType } from "../../attributes/Constraints.js";
import { isDistinctObject } from "../../attributes/DistinctObjects.js";
import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer.js";
import type { Name, Namer } from "../../Naming.js";
import type { RenderContext } from "../../Renderer.js";
import type { OptionValues } from "../../RendererOptions/index.js";
import { type Sourcelike, maybeAnnotated } from "../../Source.js";
import { defined } from "../../support/Support.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    ClassType,
    type EnumType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import {
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";

import { keywords, preludeTypeNames } from "./constants.js";
import { IntegerType, type rustOptions } from "./language.js";
import {
    Density,
    type NamingStyleKey,
    Visibility,
    camelNamingFunction,
    getPreferredNamingStyle,
    listMatchingNamingStyles,
    nameWithNamingStyle,
    namingStyles,
    rustStringEscape,
    snakeNamingFunction,
} from "./utils.js";

export class RustRenderer extends ConvenienceRenderer {
    private _strictClasses: ReadonlySet<Type> | undefined;

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof rustOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected makeNamedTypeNamer(): Namer {
        return camelNamingFunction;
    }

    protected namerForObjectProperty(): Namer | null {
        return snakeNamingFunction;
    }

    protected makeUnionMemberNamer(): Namer | null {
        return camelNamingFunction;
    }

    protected makeEnumCaseNamer(): Namer | null {
        return camelNamingFunction;
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        return [...keywords, ...preludeTypeNames];
    }

    protected forbiddenForObjectProperties(
        _c: ClassType,
        _className: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForUnionMembers(
        _u: UnionType,
        _unionName: Name,
    ): ForbiddenWordsInfo {
        return { names: [...keywords], includeGlobalForbidden: false };
    }

    protected forbiddenForEnumCases(
        _e: EnumType,
        _enumName: Name,
    ): ForbiddenWordsInfo {
        return { names: [...keywords], includeGlobalForbidden: false };
    }

    protected get commentLineStart(): string {
        return "/// ";
    }

    private getIntegerType(integerType: Type): string {
        switch (this._options.integerType) {
            case IntegerType.ForceI32:
                return "i32";
            case IntegerType.ForceI64:
                return "i64";
            default: {
                // Conservative: use i32 only when the schema bounds the
                // integer on *both* sides and both bounds fit in i32.  A
                // one-sided bound (e.g. only `"minimum": 0`) leaves the
                // other side unbounded, so it must stay i64.
                const minMax = minMaxValueForType(integerType);
                if (minMax === undefined) return "i64";
                const [min, max] = minMax;
                if (min === undefined || max === undefined) return "i64";
                const i32Min = -2147483648;
                const i32Max = 2147483647;
                return min >= i32Min && max <= i32Max ? "i32" : "i64";
            }
        }
    }

    private nullableRustType(t: Type, withIssues: boolean): Sourcelike {
        return ["Option<", this.breakCycle(t, withIssues), ">"];
    }

    protected isImplicitCycleBreaker(t: Type): boolean {
        const kind = t.kind;
        return kind === "array" || kind === "map";
    }

    private rustType(t: Type, withIssues = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            (_anyType) =>
                maybeAnnotated(
                    withIssues,
                    anyTypeIssueAnnotation,
                    "Option<serde_json::Value>",
                ),
            (_nullType) =>
                maybeAnnotated(
                    withIssues,
                    nullTypeIssueAnnotation,
                    "Option<serde_json::Value>",
                ),
            (_boolType) => "bool",
            (integerType) => this.getIntegerType(integerType),
            (_doubleType) => "f64",
            (_stringType) => "String",
            (arrayType) => [
                "Vec<",
                this.rustType(arrayType.items, withIssues),
                ">",
            ],
            (classType) => this.nameForNamedType(classType),
            (mapType) => [
                "HashMap<String, ",
                this.rustType(mapType.values, withIssues),
                ">",
            ],
            (enumType) => this.nameForNamedType(enumType),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);

                if (nullable !== null)
                    return this.nullableRustType(nullable, withIssues);

                const [hasNull] = removeNullFromUnion(unionType);

                const isCycleBreaker = this.isCycleBreakerType(unionType);

                const name = isCycleBreaker
                    ? ["Box<", this.nameForNamedType(unionType), ">"]
                    : this.nameForNamedType(unionType);

                return hasNull !== null
                    ? (["Option<", name, ">"] as Sourcelike)
                    : name;
            },
            undefined,
            (tupleType) => {
                if (this.tupleNeedsName(tupleType)) {
                    return this.nameForNamedType(tupleType);
                }

                // A tuple with one element needs a trailing comma.
                const items = tupleType.items.map((item) =>
                    this.breakCycle(item, withIssues),
                );
                const source: Sourcelike[] = ["("];
                items.forEach((item, i) => {
                    if (i > 0) source.push(", ");
                    source.push(item);
                });
                source.push(items.length === 1 ? ",)" : ")");
                return source;
            },
        );
    }

    // Tuples are spelled out as `(A, B)` unless the schema names them or
    // they contain themselves.  Named tuples become tuple structs, since a
    // type alias can't refer to itself.
    protected tupleNeedsName(t: TupleType): boolean {
        return (
            this.hasGivenName(t) ||
            this.isInCycleThrough(
                t,
                (c) =>
                    !["class", "enum"].includes(c.kind) &&
                    !(c instanceof UnionType && this.unionNeedsName(c)) &&
                    !(c instanceof TupleType && this.hasGivenName(c)),
            )
        );
    }

    protected emitTupleStruct(t: TupleType, tupleName: Name): void {
        this.emitDescription(this.descriptionForType(t));
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            "Serialize, Deserialize)]",
        );
        const fields: Sourcelike[] = [];
        t.items.forEach((item, i) => {
            if (i > 0) fields.push(", ");
            fields.push(this.visibility, this.breakCycle(item, true));
        });
        this.emitLine("pub struct ", tupleName, "(", fields, ");");
    }

    private breakCycle(t: Type, withIssues: boolean): Sourcelike {
        const rustType = this.rustType(t, withIssues);
        const isCycleBreaker = this.isCycleBreakerType(t);

        if (isCycleBreaker && t instanceof UnionType) {
            const nullable = nullableFromUnion(t);
            if (nullable === null || this.isCycleBreakerType(nullable)) {
                return rustType;
            }
        }

        return isCycleBreaker ? ["Box<", rustType, ">"] : rustType;
    }

    private emitRenameAttribute(
        propName: Name,
        jsonName: string,
        defaultNamingStyle: NamingStyleKey,
        preferedNamingStyle: NamingStyleKey,
    ): void {
        const escapedName = rustStringEscape(jsonName);
        const name = namingStyles[defaultNamingStyle].fromParts(
            this.sourcelikeToString(propName).split(" "),
        );
        const styledName = nameWithNamingStyle(name, preferedNamingStyle);
        const namesDiffer = escapedName !== styledName;
        if (namesDiffer) {
            this.emitLine('#[serde(rename = "', escapedName, '")]');
        }
    }

    private emitSkipSerializeNone(t: Type): void {
        if (t instanceof UnionType) {
            const nullable = nullableFromUnion(t);
            if (nullable !== null)
                this.emitLine(
                    '#[serde(skip_serializing_if = "Option::is_none")]',
                );
        }
    }

    private get visibility(): string {
        if (this._options.visibility === Visibility.Crate) {
            return "pub(crate) ";
        }
        if (this._options.visibility === Visibility.Public) {
            return "pub ";
        }

        return "";
    }

    // Whether the struct of `c` rejects unknown fields: if `c` is one of
    // several classes of a union, or a class that one of them contains
    // whose schema doesn't allow additional properties either.  serde
    // tries the variants of an untagged enum in turn, and a struct ignores
    // unknown fields by default, so it would take the values of the other
    // structs, too, if it doesn't require any of their fields, or if the
    // structs it contains take the values of theirs.  A union only has
    // several classes if they don't allow additional properties, so their
    // structs reject unknown fields, and so do the structs they contain
    // that don't allow them, at any depth: every variant only takes values
    // of its own.  The classes they contain that allow additional
    // properties take any of them, as their schemas say.
    private rejectsUnknownFields(c: ClassType): boolean {
        if (this._strictClasses === undefined) {
            const strictClasses = new Set<Type>();
            for (const t of this.typeGraph.allTypesUnordered()) {
                if (!(t instanceof UnionType)) continue;
                const classes = Array.from(t.members).filter(
                    (m) => m instanceof ClassType,
                );
                if (classes.length < 2) continue;
                for (const m of classes) strictClasses.add(m);
            }

            const seen = new Set<Type>();
            const work = Array.from(strictClasses);
            for (let t = work.pop(); t !== undefined; t = work.pop()) {
                if (seen.has(t)) continue;
                seen.add(t);
                if (
                    t instanceof ClassType &&
                    isDistinctObject(t.getAttributes())
                ) {
                    strictClasses.add(t);
                }

                work.push(...t.getNonAttributeChildren());
            }

            this._strictClasses = strictClasses;
        }

        return this._strictClasses.has(c);
    }

    protected emitStructDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            "Serialize, Deserialize)]",
        );

        // List the possible naming styles for every class property
        const propertiesNamingStyles: { [key: string]: string[] } = {};
        this.forEachClassProperty(c, "none", (_name, jsonName, _prop) => {
            propertiesNamingStyles[jsonName] =
                listMatchingNamingStyles(jsonName);
        });

        // Set the default naming style on the struct
        const defaultStyle = "snake_case";
        const preferedNamingStyle = getPreferredNamingStyle(
            Object.values(propertiesNamingStyles).flat(),
            defaultStyle,
        );
        if (preferedNamingStyle !== defaultStyle) {
            this.emitLine(`#[serde(rename_all = "${preferedNamingStyle}")]`);
        }

        if (this.rejectsUnknownFields(c)) {
            this.emitLine("#[serde(deny_unknown_fields)]");
        }

        const blankLines =
            this._options.density === Density.Dense ? "none" : "interposing";
        const structBody = (): void =>
            this.forEachClassProperty(c, blankLines, (name, jsonName, prop) => {
                this.emitDescription(
                    this.descriptionForClassProperty(c, jsonName),
                );
                this.emitRenameAttribute(
                    name,
                    jsonName,
                    defaultStyle,
                    preferedNamingStyle,
                );
                if (this._options.skipSerializingNone) {
                    this.emitSkipSerializeNone(prop.type);
                }

                this.emitLine(
                    this.visibility,
                    name,
                    ": ",
                    this.breakCycle(prop.type, true),
                    ",",
                );
            });

        this.emitBlock(["pub struct ", className], structBody);
    }

    protected emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("}");
    }

    protected emitUnion(u: UnionType, unionName: Name): void {
        const isMaybeWithSingleType = nullableFromUnion(u);

        if (isMaybeWithSingleType !== null) {
            return;
        }

        this.emitDescription(this.descriptionForType(u));
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            "Serialize, Deserialize)]",
        );
        this.emitLine("#[serde(untagged)]");

        const [, nonNulls] = removeNullFromUnion(u);

        // serde takes the first variant of an untagged enum that
        // deserializes, and a struct also deserializes from an array of its
        // fields' values, so the array and tuple variants go before a struct
        // variant, which would take the arrays of as many elements of its
        // fields' types.
        const isSequence = (t: Type): boolean =>
            t.kind === "array" || t.kind === "tuple";
        const sortOrder = iterableSome(nonNulls, (t) => t.kind === "class")
            ? (n: Name, t: Type): string =>
                  `${isSequence(t) ? 0 : 1}${defined(this.names.get(n))}`
            : null;

        const blankLines =
            this._options.density === Density.Dense ? "none" : "interposing";
        this.emitBlock(["pub enum ", unionName], () =>
            this.forEachUnionMember(
                u,
                nonNulls,
                blankLines,
                sortOrder,
                (fieldName, t) => {
                    const rustType = this.breakCycle(t, true);
                    this.emitLine([fieldName, "(", rustType, "),"]);
                },
            ),
        );
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            "Serialize, Deserialize)]",
        );

        // List the possible naming styles for every enum case
        const enumCasesNamingStyles: { [key: string]: string[] } = {};
        this.forEachEnumCase(e, "none", (_name, jsonName) => {
            enumCasesNamingStyles[jsonName] =
                listMatchingNamingStyles(jsonName);
        });

        // Set the default naming style on the enum
        const defaultStyle = "PascalCase";
        const preferedNamingStyle = getPreferredNamingStyle(
            Object.values(enumCasesNamingStyles).flat(),
            defaultStyle,
        );
        if (preferedNamingStyle !== defaultStyle) {
            this.emitLine(`#[serde(rename_all = "${preferedNamingStyle}")]`);
        }

        const blankLines =
            this._options.density === Density.Dense ? "none" : "interposing";
        this.emitBlock(["pub enum ", enumName], () =>
            this.forEachEnumCase(e, blankLines, (name, jsonName) => {
                this.emitRenameAttribute(
                    name,
                    jsonName,
                    defaultStyle,
                    preferedNamingStyle,
                );
                this.emitLine([name, ","]);
            }),
        );
    }

    protected get unionDeclarationsOmitNull(): boolean {
        return true;
    }

    protected emitTopLevelAlias(t: Type, name: Name): void {
        this.emitLine("pub type ", name, " = ", this.rustType(t), ";");
    }

    protected emitLeadingComments(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
            return;
        }

        const topLevel = mapFirst(this.topLevels);
        if (topLevel === undefined) return;

        const topLevelName = topLevel.getCombinedName();
        this.emitMultiline(
            `// Example code that deserializes and serializes the model.
// extern crate serde;
// #[macro_use]
// extern crate serde_derive;
// extern crate serde_json;
//
// use generated_module::${topLevelName};
//
// fn main() {
//     let json = r#"{"answer": 42}"#;
//     let model: ${topLevelName} = serde_json::from_str(&json).unwrap();
// }`,
        );
    }

    protected emitSourceStructure(): void {
        if (this._options.leadingComments) {
            this.emitLeadingComments();
        }

        this.ensureBlankLine();
        // Only declared types derive Serialize/Deserialize; aliases don't.
        if (this.haveNamedTypes) {
            this.emitLine("use serde::{Serialize, Deserialize};");
        }

        if (this.haveMaps) {
            this.emitLine("use std::collections::HashMap;");
        }

        this.forEachTopLevel(
            "leading",
            (t, name) => this.emitTopLevelAlias(t, name),
            (t) => this.namedTypeToNameForTopLevel(t) === undefined,
        );

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, name: Name) => this.emitStructDefinition(c, name),
            (e, name) => this.emitEnumDefinition(e, name),
            (u, name) => this.emitUnion(u, name),
            (t, name) => this.emitTupleStruct(t, name),
        );
    }
}
