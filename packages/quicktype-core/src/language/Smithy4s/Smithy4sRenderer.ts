import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer.js";
import { type Name, type Namer, funPrefixNamer } from "../../Naming.js";
import type { RenderContext } from "../../Renderer.js";
import type { OptionValues } from "../../RendererOptions/index.js";
import { type Sourcelike, maybeAnnotated } from "../../Source.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    isNamedType,
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";
import {
    ArrayType,
    type ClassProperty,
    type ClassType,
    type EnumType,
    isPrimitiveStringTypeKind,
    MapType,
    type ObjectType,
    type Type,
    UnionType,
} from "../../Type/index.js";

import { keywords } from "./constants.js";
import type { smithyOptions } from "./language.js";
import {
    lowerNamingFunction,
    scalaNameStyle,
    upperNamingFunction,
} from "./utils.js";

// Smithy identifiers are `(1*"_" (ALPHA / DIGIT) / ALPHA) *(ALPHA / DIGIT / "_")`
// and can't be quoted, so replace anything else with underscores.
function smithyIdentifier(s: string): string {
    const name = s.replace(/[^A-Za-z0-9_]+/g, "_");
    if (/^([A-Za-z]|_+[A-Za-z0-9])/.test(name)) return name;
    if (/^[0-9]/.test(name)) return `_${name}`;
    return "Empty";
}

export class Smithy4sRenderer extends ConvenienceRenderer {
    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        protected readonly _scalaOptions: OptionValues<typeof smithyOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        return keywords;
    }

    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        // Smithy shapes aren't nullable, so a `T | null` top-level is
        // declared as T: a class, enum or union T takes the top-level name.
        if (type instanceof UnionType) {
            const nullable = nullableFromUnion(type);
            if (nullable !== null && isNamedType(nullable)) return nullable;
        }

        return super.namedTypeToNameForTopLevel(type);
    }

    protected forbiddenForObjectProperties(
        _: ObjectType,
        _classNamed: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForEnumCases(
        _: EnumType,
        _enumName: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForUnionMembers(
        _u: UnionType,
        _unionName: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: false };
    }

    protected topLevelNameStyle(rawName: string): string {
        return scalaNameStyle(true, rawName);
    }

    protected makeNamedTypeNamer(): Namer {
        return upperNamingFunction;
    }

    protected namerForObjectProperty(): Namer {
        return lowerNamingFunction;
    }

    protected makeUnionMemberNamer(): Namer {
        return funPrefixNamer(
            "upper",
            (s) => `${scalaNameStyle(true, s)}Value`,
        );
    }

    protected makeEnumCaseNamer(): Namer {
        // Enum member names must be Smithy identifiers, so e.g. "caching-yes"
        // becomes caching_yes; the JSON value is kept as the member's value.
        return funPrefixNamer("upper", smithyIdentifier);
    }

    protected emitDescriptionBlock(lines: Sourcelike[]): void {
        // Smithy IDL has no block comments; documentation comments are `///`.
        this.emitCommentLines(lines, { lineStart: "/// " });
    }

    protected emitBlock(
        line: Sourcelike,
        f: () => void,
        delimiter: "curly" | "paren" | "lambda" | "none" = "curly",
    ): void {
        const [open, close] =
            delimiter === "curly"
                ? ["{", "}"]
                : delimiter === "paren"
                  ? ["(", ")"]
                  : delimiter === "none"
                    ? ["", ""]
                    : ["{", "})"];
        this.emitLine(line, " ", open);
        this.indent(f);
        this.emitLine(close);
    }

    protected anySourceType(_: boolean): Sourcelike {
        return ["Document"];
    }

    // (asarazan): I've broken out the following two functions
    // because some renderers, such as kotlinx, can cope with `any`, while some get mad.
    protected arrayType(arrayType: ArrayType, _ = false): Sourcelike {
        return this.collectionShapeName(arrayType, "List");
    }

    private readonly _collectionShapeNames = new Map<Type, string>();

    private readonly _usedCollectionShapeNames = new Set<string>();

    // Lists and maps are separate shapes named after the property they come
    // from, so nested ones share their parent's combined name (`string[][]`
    // is a list of lists), as do different types from properties of the same
    // name; give each distinct type its own shape name.
    private collectionShapeName(
        t: ArrayType | MapType,
        suffix: string,
    ): string {
        const existing = this._collectionShapeNames.get(t);
        if (existing !== undefined) return existing;

        const base = smithyIdentifier(
            `${t.getCombinedName().toString()}${suffix}`,
        );
        let name = base;
        for (let i = 2; this._usedCollectionShapeNames.has(name); i++) {
            name = `${base}${i}`;
        }

        this._collectionShapeNames.set(t, name);
        this._usedCollectionShapeNames.add(name);
        return name;
    }

    protected emitArrayType(_: ArrayType, smithyType: Sourcelike): void {
        this.emitLine(["list ", smithyType, " { member : ", "}"]);
    }

    protected mapType(mapType: MapType, _ = false): Sourcelike {
        return this.collectionShapeName(mapType, "Map");
    }

    protected scalaType(
        t: Type,
        withIssues = false,
        noOptional = false,
    ): Sourcelike {
        return matchType<Sourcelike>(
            t,
            (_anyType) => {
                return maybeAnnotated(
                    withIssues,
                    anyTypeIssueAnnotation,
                    this.anySourceType(!noOptional),
                );
            },
            (_nullType) => {
                // return "None.type"
                return maybeAnnotated(
                    withIssues,
                    nullTypeIssueAnnotation,
                    this.anySourceType(!noOptional),
                );
            },
            (_boolType) => "Boolean",
            (_integerType) => "Long",
            (_doubleType) => "Double",
            (_stringType) => "String",
            (arrayType) => this.arrayType(arrayType, withIssues),
            (classType) => this.nameForNamedType(classType),
            (mapType) => this.mapType(mapType, withIssues),
            (enumType) => this.nameForNamedType(enumType),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    return [this.scalaType(nullable, withIssues)];
                }

                return this.nameForNamedType(unionType);
            },
        );
    }

    protected emitUsageHeader(): void {
        // To be overridden
    }

    protected emitHeader(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        } else {
            this.emitUsageHeader();
        }

        this.ensureBlankLine();
        this.emitLine('$version: "2"');
        this.emitLine("namespace ", this._scalaOptions.packageName);
        this.ensureBlankLine();

        // Unions are emitted as `@untagged union`, a smithy4s (alloy) trait.
        if (this.haveNamedUnions) {
            this.emitLine("use alloy#untagged");
            this.ensureBlankLine();
        }

        this.emitLine("document NullValue");
        this.ensureBlankLine();
    }

    protected emitTopLevelArray(t: ArrayType, name: Name): void {
        const elementType = this.scalaType(t.items);
        this.emitLine(["list ", name, " { member : ", elementType, "}"]);
    }

    protected emitTopLevelMap(t: MapType, name: Name): void {
        const elementType = this.scalaType(t.values);
        this.emitLine([
            "map ",
            name,
            " { key : String, value : ",
            elementType,
            " }",
        ]);
    }

    // Smithy has no type aliases, so a primitive top-level is declared as a
    // simple shape, e.g. `string TopLevel`.
    protected emitTopLevelSimpleShape(t: Type, name: Name): void {
        const shapes: Record<string, string> = {
            any: "document",
            bool: "boolean",
            integer: "long",
            double: "double",
        };
        const shape =
            shapes[t.kind] ??
            (isPrimitiveStringTypeKind(t.kind) ? "string" : undefined);
        if (shape !== undefined) {
            this.emitLine([shape, " ", name]);
        }
    }

    protected emitEmptyClassDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitLine("structure ", className, "{}");
    }

    protected emitClassDefinition(c: ClassType, className: Name): void {
        if (c.getProperties().size === 0) {
            this.emitEmptyClassDefinition(c, className);
            return;
        }

        const scalaType = (p: ClassProperty): Sourcelike => {
            if (p.isOptional) {
                return [this.scalaType(p.type, true, true)];
            }

            return [this.scalaType(p.type, true)];
        };

        const emitLater: ClassProperty[] = [];

        this.emitDescription(this.descriptionForType(c));
        this.emitLine("structure ", className, " {");
        this.indent(() => {
            let count = c.getProperties().size;
            let first = true;

            this.forEachClassProperty(c, "none", (_, jsonName, p) => {
                const nullable =
                    p.type.kind === "union" &&
                    nullableFromUnion(p.type as UnionType) !== null;
                const nullableOrOptional =
                    p.isOptional || p.type.kind === "null" || nullable;
                const last = --count === 0;
                const meta: Array<() => void> = [];

                const laterType =
                    p.type.kind === "array" || p.type.kind === "map";
                if (laterType) {
                    emitLater.push(p);
                }

                const description = this.descriptionForClassProperty(
                    c,
                    jsonName,
                );
                if (description !== undefined) {
                    meta.push(() => this.emitDescription(description));
                }

                if (meta.length > 0 && !first) {
                    this.ensureBlankLine();
                }

                for (const emit of meta) {
                    emit();
                }

                // Member names must be Smithy identifiers (there is no
                // quoting); @jsonName keeps the original JSON name.
                const memberName = smithyIdentifier(jsonName);
                this.emitLine(
                    p.isOptional ? "" : nullableOrOptional ? "" : "@required ",
                    memberName === jsonName
                        ? ""
                        : `@jsonName(${JSON.stringify(jsonName)}) `,
                    memberName,
                    " : ",
                    scalaType(p),

                    last ? "" : ",",
                );

                if (meta.length > 0 && !last) {
                    this.ensureBlankLine();
                }

                first = false;
            });
        });
        this.emitClassDefinitionMethods(emitLater);
    }

    protected emitClassDefinitionMethods(_arrayTypes: ClassProperty[]): void {
        // The list and map shapes of the properties are emitted by
        // emitCollectionShapes, after all other shapes.
        this.emitLine("}");
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));

        this.ensureBlankLine();
        this.emitItem(["enum ", enumName, " { "]);
        let count = e.cases.size;

        this.forEachEnumCase(e, "none", (name, jsonName) => {
            // if (!(jsonName == "")) {
            /*                 const backticks = 
																	shouldAddBacktick(jsonName) || 
																	jsonName.includes(" ") || 
																	!isNaN(parseInt(jsonName.charAt(0)))
															if (backticks) {this.emitItem("`")} else  */
            this.emitLine();

            this.emitItem([name, ' = "', jsonName, '"']);

            //                if (backticks) {this.emitItem("`")}
            if (--count > 0) this.emitItem([","]);
            // } else {
            // --count
            // }
        });

        this.ensureBlankLine();
        this.emitItem(["}"]);
    }

    protected emitUnionDefinition(u: UnionType, unionName: Name): void {
        function sortBy(t: Type): string {
            const kind = t.kind;
            if (kind === "class") return kind;
            return `_${kind}`;
        }

        this.emitDescription(this.descriptionForType(u));

        const [maybeNull, nonNulls] = removeNullFromUnion(u, sortBy);
        const theTypes: Sourcelike[] = [];
        this.forEachUnionMember(u, nonNulls, "none", null, (_, t) => {
            theTypes.push(this.scalaType(t));
        });
        if (maybeNull !== null) {
            theTypes.push(this.nameForUnionMember(u, maybeNull));
        }

        this.emitLine(["@untagged union ", unionName, " { "]);
        this.indent(() => {
            theTypes.forEach((t, i) => {
                this.emitLine([String.fromCharCode(i + 65), " : ", t]);
            });
        });
        this.emitLine("}");
        this.ensureBlankLine();
    }

    // Every list and map that is referenced gets its own shape (see
    // collectionShapeName).  Emitting one can reference further, nested
    // collections, so repeat until all are emitted.
    protected emitCollectionShapes(): void {
        const emitted = new Set<Type>();
        for (;;) {
            const pending = Array.from(this._collectionShapeNames).filter(
                ([t]) => !emitted.has(t),
            );
            if (pending.length === 0) break;

            for (const [t, name] of pending) {
                emitted.add(t);
                if (t instanceof ArrayType) {
                    this.emitLine([
                        "list ",
                        name,
                        " { member: ",
                        this.scalaType(t.items, true),
                        " }",
                    ]);
                } else if (t instanceof MapType) {
                    this.emitLine([
                        "map ",
                        name,
                        " { key: String, value: ",
                        this.scalaType(t.values, true),
                        " }",
                    ]);
                }
            }
        }
    }

    protected emitSourceStructure(): void {
        this.emitHeader();

        // Top-level arrays, maps and primitives.  Smithy shapes aren't
        // nullable (only members are optional), so a `T | null` top-level is
        // declared as `T`.
        this.forEachTopLevel("leading", (t, name) => {
            const nonNull =
                t instanceof UnionType ? (nullableFromUnion(t) ?? t) : t;
            if (nonNull instanceof ArrayType) {
                this.emitTopLevelArray(nonNull, name);
            } else if (nonNull instanceof MapType) {
                this.emitTopLevelMap(nonNull, name);
            } else if (
                nonNull.isPrimitive() &&
                this.namedTypeToNameForTopLevel(t) === undefined
            ) {
                this.emitTopLevelSimpleShape(nonNull, name);
            }
        });

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) => this.emitClassDefinition(c, n),
            (e, n) => this.emitEnumDefinition(e, n),
            (u, n) => this.emitUnionDefinition(u, n),
        );

        this.ensureBlankLine();
        this.emitCollectionShapes();
    }
}
