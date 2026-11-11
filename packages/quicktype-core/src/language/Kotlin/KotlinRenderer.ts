import { iterableSome } from "collection-utils";

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
import { acronymStyle } from "../../support/Acronyms.js";
import { capitalize } from "../../support/Strings.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    ArrayType,
    type ClassProperty,
    type ClassType,
    type EnumType,
    MapType,
    type ObjectType,
    PrimitiveType,
    type TupleType,
    type Type,
    type UnionType,
} from "../../Type/index.js";
import {
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";

import { keywords } from "./constants.js";
import type { kotlinOptions } from "./language.js";
import { kotlinNameStyle, stringEscape } from "./utils.js";

export interface TupleProperty {
    name: string;
    type: Type;
    kotlinType: Sourcelike;
    kind: "required" | "optional" | "optional-nullable" | "rest";
    /** For "optional-nullable", the class holding the item's value. */
    holder?: Sourcelike;
}

export class KotlinRenderer extends ConvenienceRenderer {
    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        protected readonly _kotlinOptions: OptionValues<typeof kotlinOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        const forbidden: string[] = [...keywords];
        if (this.haveTransformedStringType("date")) forbidden.push("LocalDate");
        if (this.haveTransformedStringType("date-time"))
            forbidden.push("OffsetDateTime");
        if (this.haveTransformedStringType("time"))
            forbidden.push("OffsetTime");
        return forbidden;
    }

    // Every tuple is a data class, with a property per item.
    protected tupleNeedsName(_t: TupleType): boolean {
        return true;
    }

    protected forbiddenForObjectProperties(
        _o: ObjectType,
        _classNamed: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForEnumCases(
        _e: EnumType,
        enumName: Name,
    ): ForbiddenWordsInfo {
        return { names: [enumName], includeGlobalForbidden: true };
    }

    protected forbiddenForUnionMembers(
        _u: UnionType,
        _unionName: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: false };
    }

    protected topLevelNameStyle(rawName: string): string {
        return kotlinNameStyle(true, rawName);
    }

    protected makeNamedTypeNamer(): Namer {
        return funPrefixNamer("upper", (s) =>
            kotlinNameStyle(
                true,
                s,
                acronymStyle(this._kotlinOptions.acronymStyle),
            ),
        );
    }

    protected namerForObjectProperty(): Namer {
        return funPrefixNamer("lower", (s) =>
            kotlinNameStyle(
                false,
                s,
                acronymStyle(this._kotlinOptions.acronymStyle),
            ),
        );
    }

    protected makeUnionMemberNamer(): Namer {
        return funPrefixNamer(
            "upper",
            (s) => `${kotlinNameStyle(true, s)}Value`,
        );
    }

    protected makeEnumCaseNamer(): Namer {
        return funPrefixNamer("upper", (s) =>
            kotlinNameStyle(
                true,
                s,
                acronymStyle(this._kotlinOptions.acronymStyle),
            ),
        );
    }

    protected emitDescriptionBlock(lines: Sourcelike[]): void {
        this.emitCommentLines(lines, {
            lineStart: " * ",
            beforeComment: "/**",
            afterComment: " */",
        });
    }

    protected emitBlock(
        line: Sourcelike,
        f: () => void,
        delimiter: "curly" | "paren" | "lambda" = "curly",
    ): void {
        const [open, close] =
            delimiter === "curly"
                ? ["{", "}"]
                : delimiter === "paren"
                  ? ["(", ")"]
                  : ["{", "})"];
        this.emitLine(line, " ", open);
        this.indent(f);
        this.emitLine(close);
    }

    protected anySourceType(optional: string): Sourcelike {
        return ["Any", optional];
    }

    // (asarazan): I've broken out the following two functions
    // because some renderers, such as kotlinx, can cope with `any`, while some get mad.
    protected arrayType(
        arrayType: ArrayType,
        withIssues = false,
        _noOptional = false,
    ): Sourcelike {
        return ["List<", this.kotlinType(arrayType.items, withIssues), ">"];
    }

    protected mapType(
        mapType: MapType,
        withIssues = false,
        _noOptional = false,
    ): Sourcelike {
        return [
            "Map<String, ",
            this.kotlinType(mapType.values, withIssues),
            ">",
        ];
    }

    protected haveTransformedStringType(
        kind: "date-time" | "date" | "time",
    ): boolean {
        return iterableSome(
            this.typeGraph.allTypesUnordered(),
            (t) => t instanceof PrimitiveType && t.kind === kind,
        );
    }

    protected kotlinType(
        t: Type,
        withIssues = false,
        noOptional = false,
    ): Sourcelike {
        const optional = noOptional ? "" : "?";
        return matchType<Sourcelike>(
            t,
            (_anyType) => {
                return maybeAnnotated(
                    withIssues,
                    anyTypeIssueAnnotation,
                    this.anySourceType(optional),
                );
            },
            (_nullType) => {
                return maybeAnnotated(
                    withIssues,
                    nullTypeIssueAnnotation,
                    this.anySourceType(optional),
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
                if (nullable !== null)
                    return [this.kotlinType(nullable, withIssues), optional];
                return this.nameForNamedType(unionType);
            },
            (transformedStringType) => {
                if (transformedStringType.kind === "date-time") {
                    return "OffsetDateTime";
                }

                if (transformedStringType.kind === "date") {
                    return "LocalDate";
                }

                if (transformedStringType.kind === "time") {
                    return "OffsetTime";
                }

                return "String";
            },
            (tupleType) => this.nameForNamedType(tupleType),
        );
    }

    protected emitUsageHeader(): void {
        // To be overridden
    }

    // Emitted between the usage header and the package declaration —
    // the only place Kotlin allows `@file:`-targeted annotations.
    protected emitFileAnnotations(): void {
        // To be overridden
    }

    protected emitHeader(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        } else {
            this.emitUsageHeader();
        }

        this.ensureBlankLine();
        this.emitFileAnnotations();
        this.emitLine("package ", this._kotlinOptions.packageName);
        this.ensureBlankLine();

        // Check if we need to import java.time classes
        const usesDateTime = this.haveTransformedStringType("date-time");
        const usesDate = this.haveTransformedStringType("date");
        const usesTime = this.haveTransformedStringType("time");

        if (usesDateTime) {
            this.emitLine("import java.time.OffsetDateTime");
        }

        if (usesDate) {
            this.emitLine("import java.time.LocalDate");
        }

        if (usesTime) {
            this.emitLine("import java.time.OffsetTime");
        }

        if (usesDateTime || usesDate || usesTime) {
            this.ensureBlankLine();
        }
    }

    protected emitTopLevelPrimitive(t: PrimitiveType, name: Name): void {
        const elementType = this.kotlinType(t);
        this.emitLine(["typealias ", name, " = ", elementType, ""]);
    }

    protected emitTopLevelArray(t: ArrayType, name: Name): void {
        const elementType = this.kotlinType(t.items);
        this.emitLine(["typealias ", name, " = ArrayList<", elementType, ">"]);
    }

    protected emitTopLevelMap(t: MapType, name: Name): void {
        const elementType = this.kotlinType(t.values);
        this.emitLine([
            "typealias ",
            name,
            " = HashMap<String, ",
            elementType,
            ">",
        ]);
    }

    protected emitEmptyClassDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitClassAnnotations(c, className);
        this.emitLine("class ", className, "()");
    }

    protected emitClassDefinition(c: ClassType, className: Name): void {
        if (c.getProperties().size === 0) {
            this.emitEmptyClassDefinition(c, className);
            return;
        }

        const kotlinType = (p: ClassProperty): Sourcelike => {
            if (p.isOptional) {
                return [this.kotlinType(p.type, true, true), "?"];
            }

            return this.kotlinType(p.type, true);
        };

        this.emitDescription(this.descriptionForType(c));
        this.emitClassAnnotations(c, className);
        this.emitLine("data class ", className, " (");
        this.indent(() => {
            let count = c.getProperties().size;
            let first = true;
            this.forEachClassProperty(c, "none", (name, jsonName, p) => {
                const nullable =
                    p.type.kind === "union" &&
                    nullableFromUnion(p.type as UnionType) !== null;
                const nullableOrOptional =
                    p.isOptional || p.type.kind === "null" || nullable;
                const last = --count === 0;
                const meta: Array<() => void> = [];

                const description = this.descriptionForClassProperty(
                    c,
                    jsonName,
                );
                if (description !== undefined) {
                    meta.push(() => this.emitDescription(description));
                }

                this.renameAttribute(name, jsonName, !p.isOptional, meta, p);

                if (meta.length > 0 && !first) {
                    this.ensureBlankLine();
                }

                for (const emit of meta) {
                    emit();
                }

                this.emitLine(
                    "val ",
                    name,
                    ": ",
                    kotlinType(p),
                    this.propertyDefault(p, nullableOrOptional),
                    last ? "" : ",",
                );

                if (meta.length > 0 && !last) {
                    this.ensureBlankLine();
                }

                first = false;
            });
        });

        this.emitClassDefinitionMethods(c, className);
    }

    protected emitClassDefinitionMethods(
        _c: ClassType,
        _className: Name,
    ): void {
        this.emitLine(")");
    }

    /**
     * The properties of a tuple's data class.  Items have no names, so they
     * are `item0`, `item1`, ... after their positions in the JSON array, and
     * the rest is a final list, `rest`.  A missing optional item is null.
     * If null is also a value of the item, the property's type is a nested
     * class holding the value, `Item1(val value: T?)`, which keeps them
     * apart: null if the item is missing, `Item1(null)` if it's null.  It
     * isn't generic, like `java.util.Optional`, since Klaxon can't reflect
     * on generic classes.
     */
    protected tupleProperties(
        t: TupleType,
        tupleName: Name,
        withIssues = false,
    ): TupleProperty[] {
        const properties: TupleProperty[] = t.items.map((item, i) => {
            const name = `item${i}`;
            if (i < t.minItems) {
                return {
                    name,
                    type: item,
                    kotlinType: this.kotlinType(item, withIssues),
                    kind: "required",
                };
            }

            const itemType = this.kotlinType(item, withIssues);
            if (!this.sourcelikeToString(itemType).endsWith("?")) {
                return {
                    name,
                    type: item,
                    kotlinType: [itemType, "?"],
                    kind: "optional",
                };
            }

            const holder: Sourcelike = [tupleName, ".", capitalize(name)];
            return {
                name,
                type: item,
                kotlinType: [holder, "?"],
                kind: "optional-nullable",
                holder,
            };
        });
        if (t.rest !== undefined) {
            properties.push({
                name: "rest",
                type: t.rest,
                kotlinType: ["List<", this.kotlinType(t.rest, withIssues), ">"],
                kind: "rest",
            });
        }

        return properties;
    }

    protected emitTupleAnnotations(_t: TupleType, _tupleName: Name): void {
        // to be overridden
    }

    protected emitTupleDefinition(t: TupleType, tupleName: Name): void {
        this.emitDescription(this.descriptionForType(t));
        this.emitTupleAnnotations(t, tupleName);
        this.emitLine("data class ", tupleName, " (");
        this.indent(() => {
            const properties = this.tupleProperties(t, tupleName, true);
            properties.forEach((p, i) => {
                const optional =
                    p.kind === "optional" || p.kind === "optional-nullable";
                this.emitLine(
                    "val ",
                    p.name,
                    ": ",
                    p.kotlinType,
                    optional ? " = null" : "",
                    i === properties.length - 1 ? "" : ",",
                );
            });
        });
        this.emitTupleDefinitionMethods(t, tupleName);
    }

    protected emitTupleDefinitionMethods(t: TupleType, tupleName: Name): void {
        if (this.tupleHolders(t, tupleName).length === 0) {
            this.emitLine(")");
        } else {
            this.emitBlock(")", () => {
                this.emitTupleHolders(t, tupleName);
            });
        }
    }

    /**
     * `toJson` for a tuple, which writes the list of the JSON array's
     * elements with `write`: the required items, the optional ones that are
     * present, then the rest.  `write` gets an expression, which is a sum
     * of lists if `isSum`.  An item can't follow a missing one in JSON,
     * so such a value is an error rather than written with the later items
     * moved into the gap, or with nulls in it.
     */
    protected emitTupleToJson(
        t: TupleType,
        tupleName: Name,
        signature: Sourcelike,
        write: (elements: Sourcelike, isSum: boolean) => Sourcelike,
    ): void {
        const properties = this.tupleProperties(t, tupleName);
        const required = properties
            .filter((p) => p.kind === "required")
            .map((p) => p.name)
            .join(", ");
        const optionals = properties.filter(
            (p) => p.kind === "optional" || p.kind === "optional-nullable",
        );
        if (optionals.length === 0) {
            const elements: Sourcelike = ["listOf<Any?>(", required, ")"];
            this.emitLine(
                signature,
                " = ",
                t.rest === undefined
                    ? write(elements, false)
                    : write([elements, " + rest"], true),
            );
            return;
        }

        const gap: Sourcelike = [
            '"Cannot serialize ',
            tupleName,
            ': an item follows a missing optional item"',
        ];
        this.emitBlock(signature, () => {
            this.emitLine("val items = mutableListOf<Any?>(", required, ")");
            optionals.forEach((p, i) => {
                const value =
                    p.kind === "optional" ? p.name : `${p.name}.value`;
                if (i === 0) {
                    this.emitLine(
                        "if (",
                        p.name,
                        " != null) items.add(",
                        value,
                        ")",
                    );
                    return;
                }

                this.emitBlock(["if (", p.name, " != null)"], () => {
                    this.emitLine(
                        "require(",
                        optionals[i - 1].name,
                        " != null) { ",
                        gap,
                        " }",
                    );
                    this.emitLine("items.add(", value, ")");
                });
            });
            if (t.rest !== undefined) {
                const last = optionals[optionals.length - 1].name;
                this.emitLine(
                    "require(rest.isEmpty() || ",
                    last,
                    " != null) { ",
                    gap,
                    " }",
                );
                this.emitLine("items.addAll(rest)");
            }

            this.emitLine("return ", write("items", false));
        });
    }

    private tupleHolders(t: TupleType, tupleName: Name): TupleProperty[] {
        return this.tupleProperties(t, tupleName).filter(
            (p) => p.kind === "optional-nullable",
        );
    }

    /**
     * The classes holding the optional items that may be null; whether
     * there are any.
     */
    protected emitTupleHolders(t: TupleType, tupleName: Name): boolean {
        const holders = this.tupleHolders(t, tupleName);
        for (const p of holders) {
            this.emitLine(
                "data class ",
                capitalize(p.name),
                "(val value: ",
                this.kotlinType(p.type, true),
                ")",
            );
        }

        return holders.length > 0;
    }

    protected emitClassAnnotations(_c: Type, _className: Name): void {
        // to be overridden
    }

    protected propertyDefault(
        _p: ClassProperty,
        nullableOrOptional: boolean,
    ): Sourcelike {
        return nullableOrOptional ? " = null" : "";
    }

    protected renameAttribute(
        _name: Name,
        _jsonName: string,
        _required: boolean,
        _meta: Array<() => void>,
        _p: ClassProperty,
    ): void {
        // to be overridden
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));

        this.emitBlock(["enum class ", enumName, "(val value: String)"], () => {
            let count = e.cases.size;
            this.forEachEnumCase(e, "none", (name, json) => {
                this.emitLine(
                    name,
                    `("${stringEscape(json)}")`,
                    --count === 0 ? ";" : ",",
                );
            });
            this.ensureBlankLine();
            this.emitBlock("companion object", () => {
                this.emitBlock(
                    [
                        "fun fromValue(value: String): ",
                        enumName,
                        " = when (value)",
                    ],
                    () => {
                        const table: Sourcelike[][] = [];
                        this.forEachEnumCase(e, "none", (name, json) => {
                            table.push([
                                [`"${stringEscape(json)}"`],
                                [" -> ", name],
                            ]);
                        });
                        table.push([
                            ["else"],
                            [" -> throw IllegalArgumentException()"],
                        ]);
                        this.emitTable(table);
                    },
                );
            });
        });
    }

    protected emitUnionDefinition(u: UnionType, unionName: Name): void {
        function sortBy(t: Type): string {
            const kind = t.kind;
            if (kind === "class") return kind;
            return `_${kind}`;
        }

        this.emitDescription(this.descriptionForType(u));

        const [maybeNull, nonNulls] = removeNullFromUnion(u, sortBy);
        this.emitClassAnnotations(u, unionName);
        this.emitBlock(["sealed class ", unionName], () => {
            {
                const table: Sourcelike[][] = [];
                this.forEachUnionMember(
                    u,
                    nonNulls,
                    "none",
                    null,
                    (name, t) => {
                        table.push([
                            [
                                "class ",
                                name,
                                "(val value: ",
                                this.kotlinType(t),
                                ")",
                            ],
                            [" : ", unionName, "()"],
                        ]);
                    },
                );
                if (maybeNull !== null) {
                    table.push([
                        ["class ", this.nameForUnionMember(u, maybeNull), "()"],
                        [" : ", unionName, "()"],
                    ]);
                }

                this.emitTable(table);
            }

            this.emitUnionDefinitionMethods(u, nonNulls, maybeNull, unionName);
        });
    }

    protected emitUnionDefinitionMethods(
        _u: UnionType,
        _nonNulls: ReadonlySet<Type>,
        _maybeNull: PrimitiveType | null,
        _unionName: Name,
    ): void {
        // to be overridden
    }

    protected emitSourceStructure(): void {
        this.emitHeader();

        // Top-level arrays, maps
        this.forEachTopLevel("leading", (t, name) => {
            if (t instanceof ArrayType) {
                this.emitTopLevelArray(t, name);
            } else if (t instanceof MapType) {
                this.emitTopLevelMap(t, name);
            } else if (t.isPrimitive()) {
                this.emitTopLevelPrimitive(t, name);
            } else if (this.namedTypeToNameForTopLevel(t) === undefined) {
                // e.g. a nullable top-level (`T | null`)
                this.emitLine(["typealias ", name, " = ", this.kotlinType(t)]);
            }
        });

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) => this.emitClassDefinition(c, n),
            (e, n) => this.emitEnumDefinition(e, n),
            (u, n) => this.emitUnionDefinition(u, n),
            (t, n) => this.emitTupleDefinition(t, n),
        );
    }
}
