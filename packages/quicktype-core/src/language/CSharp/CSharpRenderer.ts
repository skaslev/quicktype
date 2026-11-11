import {
    arrayIntercalate,
    iterableFirst,
    iterableSome,
} from "collection-utils";

import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer.js";
import type { Name, Namer } from "../../Naming.js";
import type {
    BlankLineConfig,
    ForEachPosition,
    RenderContext,
} from "../../Renderer.js";
import type { OptionValues } from "../../RendererOptions/index.js";
import { type Sourcelike, maybeAnnotated } from "../../Source.js";
import { assert } from "../../support/Support.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import { followTargetType } from "../../Transformers.js";
import {
    type ClassProperty,
    type ClassType,
    EnumType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import {
    directlyReachableTypes,
    isNamedType,
    matchCompoundType,
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";

import type { cSharpOptions } from "./language.js";
import {
    AccessModifier,
    csTypeForTransformedStringType,
    isValueType,
    namingFunction,
    namingFunctionKeep,
    decodesNullToNull,
    tupleHasItemFlag,
    tupleHasItemName,
    tupleItemName,
    tupleMemberNames,
    tupleRestName,
} from "./utils.js";

/**
 * How a framework's tuple converter reads and writes items, for
 * `emitTupleRead` and `emitTupleWrite`.  The converter's `reader`,
 * `writer` and `value` are in scope.
 */
export interface TupleConverterDialect {
    /** `JsonTokenType` or `JsonToken`. */
    readonly tokenType: string;
    /**
     * A condition on `reader` for a JSON value of the wrong type, if reading
     * the item doesn't reject all of them.
     */
    invalidItem: (t: Type) => string | undefined;
    /** An expression that reads an item of type `t`. */
    readItem: (t: Type) => Sourcelike;
    /**
     * Writes `item`, of type `t`, or of the nullable type of an optional
     * item, then not null.
     */
    writeItem: (t: Type, item: Sourcelike, isOptional: boolean) => void;
    cannotUnmarshal: () => void;
    cannotMarshal: () => void;
}

// A condition to be joined with `||`.
function parenthesize(condition: string): string {
    return condition.includes(" && ") ? `(${condition})` : condition;
}

const objectMemberNames = [
    "ToString",
    "GetHashCode",
    "Finalize",
    "Equals",
    "GetType",
    "MemberwiseClone",
    "ReferenceEquals",
];

export class CSharpRenderer extends ConvenienceRenderer {
    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _csOptions: OptionValues<typeof cSharpOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return [
            "QuickType",
            "Type",
            "System",
            "Console",
            "Exception",
            "DateTimeOffset",
            "DateTimeStyles",
            "Guid",
            "Uri",
            ...(this._csOptions.useRecords
                ? ["Clone", "EqualityContract", "PrintMembers", "ToString"]
                : []),
            // A member can't have its class's name.
            ...this.tupleMemberNamesInUse(),
        ];
    }

    private tupleMemberNamesInUse(): string[] {
        const names = new Set<string>();
        for (const t of this.typeGraph.allTypesUnordered()) {
            if (!(t instanceof TupleType)) continue;
            for (const name of tupleMemberNames(t)) {
                names.add(name);
            }
        }

        return Array.from(names);
    }

    protected forbiddenForObjectProperties(
        _: ClassType,
        classNamed: Name,
    ): ForbiddenWordsInfo {
        return {
            names: [
                classNamed,
                ...objectMemberNames,
                ...(this._csOptions.useRecords
                    ? ["Clone", "EqualityContract", "PrintMembers"]
                    : []),
            ],
            includeGlobalForbidden: false,
        };
    }

    protected forbiddenForUnionMembers(
        _: UnionType,
        unionNamed: Name,
    ): ForbiddenWordsInfo {
        return {
            names: [unionNamed, ...objectMemberNames],
            includeGlobalForbidden: true,
        };
    }

    protected makeNamedTypeNamer(): Namer {
        return namingFunction;
    }

    protected namerForObjectProperty(): Namer {
        return this._csOptions.keepPropertyName
            ? namingFunctionKeep
            : namingFunction;
    }

    protected makeUnionMemberNamer(): Namer {
        return namingFunction;
    }

    protected makeEnumCaseNamer(): Namer {
        return namingFunction;
    }

    protected unionNeedsName(u: UnionType): boolean {
        return nullableFromUnion(u) === null;
    }

    // Every tuple is a class with a property per item.
    protected tupleNeedsName(_t: TupleType): boolean {
        return true;
    }

    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        // In just-types mode a top-level enum takes the top-level name.
        // Enums are converted with a transformer, so the top-level type
        // is the string that's transformed into the enum.  Without
        // just-types the name belongs to the class with `FromJson`.
        if (this._csOptions.justTypes) {
            const target = followTargetType(type);
            if (target instanceof EnumType) return target;
        }

        // If the top-level type doesn't contain any classes, unions or
        // tuples we have to define a class just for the `FromJson` method,
        // in emitFromJsonForTopLevel.
        const definedTypes = directlyReachableTypes(type, (t) =>
            (!(t instanceof UnionType) && isNamedType(t)) ||
            (t instanceof UnionType && nullableFromUnion(t) === null) ||
            t instanceof TupleType
                ? new Set([t])
                : null,
        );
        assert(
            definedTypes.size <= 1,
            "Cannot have more than one defined type per top-level",
        );
        return iterableFirst(definedTypes);
    }

    protected emitBlock(f: () => void, semicolon = false): void {
        this.emitLine("{");
        this.indent(f);
        this.emitLine("}", semicolon ? ";" : "");
    }

    protected get doubleType(): string {
        return this._csOptions.useDecimal ? "decimal" : "double";
    }

    protected csType(
        t: Type,
        follow: (t: Type) => Type = followTargetType,
        withIssues = false,
    ): Sourcelike {
        const actualType = follow(t);
        return matchType<Sourcelike>(
            actualType,
            (_anyType) =>
                maybeAnnotated(
                    withIssues,
                    anyTypeIssueAnnotation,
                    this._csOptions.typeForAny,
                ),
            (_nullType) =>
                maybeAnnotated(
                    withIssues,
                    nullTypeIssueAnnotation,
                    this._csOptions.typeForAny,
                ),
            (_boolType) => "bool",
            (_integerType) => "long",
            (_doubleType) => this.doubleType,
            (_stringType) => "string",
            (arrayType) =>
                this.listType(this.csType(arrayType.items, follow, withIssues)),
            (classType) => this.nameForNamedType(classType),
            (mapType) => [
                "Dictionary<string, ",
                this.csType(mapType.values, follow, withIssues),
                ">",
            ],
            (enumType) => this.nameForNamedType(enumType),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null)
                    return this.nullableCSType(nullable, follow);
                return this.nameForNamedType(unionType);
            },
            (transformedStringType) =>
                csTypeForTransformedStringType(transformedStringType),
            (tupleType) => this.nameForNamedType(tupleType),
        );
    }

    /** `T[]` or `List<T>`, depending on `--array-type`. */
    protected listType(itemsType: Sourcelike): Sourcelike {
        return this._csOptions.useList
            ? ["List<", itemsType, ">"]
            : [itemsType, "[]"];
    }

    protected nullableCSType(
        t: Type,
        follow: (t: Type) => Type = followTargetType,
        withIssues = false,
    ): Sourcelike {
        t = followTargetType(t);
        // A nullable union already renders with its own "?" through
        // csType's union case; unwrap it so the annotation is applied
        // exactly once.  Without this, an optional property whose type
        // is e.g. `string | null` would render as `string??` at C# 8
        // (and a nullable value-type union as `long??` at any version).
        if (t instanceof UnionType) {
            const nullable = nullableFromUnion(t);
            if (nullable !== null) {
                t = followTargetType(nullable);
            }
        }

        const csType = this.csType(t, follow, withIssues);
        if (isValueType(t) || this._csOptions.version >= 8) {
            return [csType, "?"];
        } else {
            return csType;
        }
    }

    protected baseclassForType(_t: Type): Sourcelike | undefined {
        return undefined;
    }

    /**
     * Keyword for named object types.  Records need C# 9+; the option is
     * independent of `--csharp-version`, which only gates older syntax.
     */
    protected get objectTypeKind(): string {
        return this._csOptions.useRecords ? "record" : "class";
    }

    protected emitType(
        description: string[] | undefined,
        accessModifier: AccessModifier,
        declaration: Sourcelike,
        name: Sourcelike,
        baseclass: Sourcelike | undefined,
        emitter: () => void,
    ): void {
        switch (accessModifier) {
            case AccessModifier.Public:
                declaration = ["public ", declaration];
                break;
            case AccessModifier.Internal:
                declaration = ["internal ", declaration];
                break;
            default:
                break;
        }

        this.emitDescription(description);
        if (baseclass === undefined) {
            this.emitLine(declaration, " ", name);
        } else {
            this.emitLine(declaration, " ", name, " : ", baseclass);
        }

        this.emitBlock(emitter);
    }

    protected attributesForProperty(
        _property: ClassProperty,
        _name: Name,
        _c: ClassType,
        _jsonName: string,
    ): Sourcelike[] | undefined {
        return undefined;
    }

    protected propertyDefinition(
        property: ClassProperty,
        name: Name,
        _c: ClassType,
        _jsonName: string,
    ): Sourcelike {
        const t = property.type;
        const csType = property.isOptional
            ? this.nullableCSType(t, followTargetType, true)
            : this.csType(t, followTargetType, true);

        const propertyArray = ["public "];

        if (this._csOptions.virtual) propertyArray.push("virtual ");

        return [...propertyArray, csType, " ", name, " { get; set; }"];
    }

    protected emitDescriptionBlock(lines: Sourcelike[]): void {
        // Doc comments are XML, so anything that could be mistaken
        // for markup must be escaped.
        const escapedLines = lines.map((line) =>
            this.sourcelikeToString(line)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;"),
        );
        const start = "/// <summary>";
        if (this._csOptions.dense) {
            this.emitLine(start, escapedLines.join("; "), "</summary>");
        } else {
            this.emitCommentLines(escapedLines, {
                lineStart: "/// ",
                beforeComment: start,
                afterComment: "/// </summary>",
            });
        }
    }

    protected blankLinesBetweenAttributes(): boolean {
        return false;
    }

    private emitClassDefinition(c: ClassType, className: Name): void {
        this.emitType(
            this.descriptionForType(c),
            AccessModifier.Public,
            ["partial ", this.objectTypeKind],
            className,
            this.baseclassForType(c),
            () => {
                if (c.getProperties().size === 0) return;
                const blankLines = this.blankLinesBetweenAttributes()
                    ? "interposing"
                    : "none";
                const columns: Sourcelike[][] = [];
                let isFirstProperty = true;
                let previousDescription: string[] | undefined;
                this.forEachClassProperty(
                    c,
                    blankLines,
                    (name, jsonName, p) => {
                        const attributes = this.attributesForProperty(
                            p,
                            name,
                            c,
                            jsonName,
                        );
                        const description = this.descriptionForClassProperty(
                            c,
                            jsonName,
                        );
                        const property = this.propertyDefinition(
                            p,
                            name,
                            c,
                            jsonName,
                        );
                        if (attributes === undefined) {
                            if (
                                // Descriptions should be preceded by an empty line
                                (!isFirstProperty &&
                                    description !== undefined) ||
                                // If the previous property has a description, leave an empty line
                                previousDescription !== undefined
                            ) {
                                this.ensureBlankLine();
                            }

                            this.emitDescription(description);
                            this.emitLine(property);
                        } else if (
                            this._csOptions.dense &&
                            attributes.length > 0
                        ) {
                            const comment =
                                description === undefined
                                    ? ""
                                    : ` // ${description.join("; ")}`;
                            columns.push([attributes, " ", property, comment]);
                        } else {
                            this.emitDescription(description);
                            for (const attribute of attributes) {
                                this.emitLine(attribute);
                            }

                            this.emitLine(property);
                        }

                        isFirstProperty = false;
                        previousDescription = description;
                    },
                );
                if (columns.length > 0) {
                    this.emitTable(columns);
                }
            },
        );
    }

    private emitUnionDefinition(u: UnionType, unionName: Name): void {
        const nonNulls = removeNullFromUnion(u, true)[1];
        this.emitType(
            this.descriptionForType(u),
            AccessModifier.Public,
            "partial struct",
            unionName,
            this.baseclassForType(u),
            () => {
                this.forEachUnionMember(
                    u,
                    nonNulls,
                    "none",
                    null,
                    (fieldName, t) => {
                        const csType = this.nullableCSType(t);
                        this.emitLine("public ", csType, " ", fieldName, ";");
                    },
                );
                this.ensureBlankLine();
                const nullTests: Sourcelike[] = Array.from(nonNulls).map(
                    (t) => [this.nameForUnionMember(u, t), " == null"],
                );
                this.ensureBlankLine();
                this.forEachUnionMember(
                    u,
                    nonNulls,
                    "none",
                    null,
                    (fieldName, t) => {
                        const csType = this.csType(t);
                        this.emitExpressionMember(
                            [
                                "public static implicit operator ",
                                unionName,
                                "(",
                                csType,
                                " ",
                                fieldName,
                                ")",
                            ],
                            [
                                "new ",
                                unionName,
                                " { ",
                                fieldName,
                                " = ",
                                fieldName,
                                " }",
                            ],
                        );
                    },
                );
                if (u.findMember("null") === undefined) return;
                this.emitExpressionMember(
                    "public bool IsNull",
                    arrayIntercalate(" && ", nullTests),
                    true,
                );
            },
        );
    }

    private emitEnumDefinition(e: EnumType, enumName: Name): void {
        const caseNames: Sourcelike[] = [];
        this.forEachEnumCase(e, "none", (name) => {
            if (caseNames.length > 0) caseNames.push(", ");
            caseNames.push(name);
        });
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("public enum ", enumName, " { ", caseNames, " };");
    }

    // `[A, B?, ...C[]]` is a class with `A Item1`, `B? Item2` and
    // `C[] Rest`; the converters read and write it as a JSON array.
    private emitTupleDefinition(t: TupleType, tupleName: Name): void {
        const property = (csType: Sourcelike, name: string): Sourcelike => [
            "public ",
            this._csOptions.virtual ? "virtual " : "",
            csType,
            " ",
            name,
            " { get; set; }",
        ];
        this.emitType(
            this.descriptionForType(t),
            AccessModifier.Public,
            ["partial ", this.objectTypeKind],
            tupleName,
            this.baseclassForType(t),
            () => {
                t.items.forEach((item, i) => {
                    const csType =
                        i < t.minItems
                            ? this.csType(item, followTargetType, true)
                            : this.nullableCSType(item, followTargetType, true);
                    this.emitLine(property(csType, tupleItemName(i)));
                    if (tupleHasItemFlag(t, i)) {
                        this.emitLine(property("bool", tupleHasItemName(i)));
                    }
                });
                if (t.rest !== undefined) {
                    this.emitLine(
                        property(
                            this.listType(
                                this.csType(t.rest, followTargetType, true),
                            ),
                            tupleRestName,
                        ),
                    );
                }
            },
        );
    }

    // Reads the required items, the optional ones while there are
    // elements, then the rest.  An array of the wrong length, or with an
    // item of the wrong type, throws.
    protected emitTupleRead(
        t: TupleType,
        tupleName: Name,
        d: TupleConverterDialect,
    ): void {
        const atEnd = `reader.TokenType == ${d.tokenType}.EndArray`;
        const notAtEnd = `reader.TokenType != ${d.tokenType}.EndArray`;
        const checkItem = (itemType: Type): void => {
            const invalid = d.invalidItem(itemType);
            if (invalid === undefined) return;
            this.emitLine("if (", invalid, ")");
            this.emitBlock(d.cannotUnmarshal);
        };
        this.emitLine(`if (reader.TokenType != ${d.tokenType}.StartArray)`);
        this.emitBlock(d.cannotUnmarshal);
        this.ensureBlankLine();
        this.emitLine("var value = new ", tupleName, "();");
        this.emitLine("reader.Read();");
        t.items.forEach((itemType, i) => {
            const read = (): void => {
                this.emitLine(
                    "value.",
                    tupleItemName(i),
                    " = ",
                    d.readItem(itemType),
                    ";",
                );
                if (tupleHasItemFlag(t, i)) {
                    this.emitLine("value.", tupleHasItemName(i), " = true;");
                }

                this.emitLine("reader.Read();");
            };
            if (i < t.minItems) {
                const invalid = d.invalidItem(itemType);
                this.emitLine(
                    "if (",
                    atEnd,
                    invalid === undefined
                        ? ""
                        : [" || ", parenthesize(invalid)],
                    ")",
                );
                this.emitBlock(d.cannotUnmarshal);
                read();
            } else {
                this.emitLine("if (", notAtEnd, ")");
                this.emitBlock(() => {
                    checkItem(itemType);
                    read();
                });
            }
        });
        const rest = t.rest;
        if (rest === undefined) {
            this.emitLine("if (", notAtEnd, ")");
            this.emitBlock(d.cannotUnmarshal);
        } else {
            this.emitLine("var rest = new List<", this.csType(rest), ">();");
            this.emitLine("while (", notAtEnd, ")");
            this.emitBlock(() => {
                checkItem(rest);
                this.emitLine("rest.Add(", d.readItem(rest), ");");
                this.emitLine("reader.Read();");
            });
            this.emitLine(
                "value.",
                tupleRestName,
                " = rest",
                this._csOptions.useList ? "" : ".ToArray()",
                ";",
            );
        }

        this.ensureBlankLine();
        this.emitLine("return value;");
    }

    // Writes the optional items up to the last one that is present, all of
    // them if the rest isn't empty.  One that can't be null must then be
    // there: JSON can't leave a gap.
    protected emitTupleWrite(t: TupleType, d: TupleConverterDialect): void {
        const item = (i: number): Sourcelike => ["value.", tupleItemName(i)];
        if (t.items.length > t.minItems) {
            let length: Sourcelike = t.minItems.toString();
            for (let i = t.minItems; i < t.items.length; i++) {
                const present: Sourcelike = tupleHasItemFlag(t, i)
                    ? [
                          "(value.",
                          tupleHasItemName(i),
                          " || ",
                          item(i),
                          " != null)",
                      ]
                    : [item(i), " != null"];
                length = [present, " ? ", (i + 1).toString(), " : ", length];
            }

            if (t.rest !== undefined) {
                const count = this._csOptions.useList ? "Count" : "Length";
                length = [
                    `(value.${tupleRestName} != null && value.${tupleRestName}.${count} > 0) ? `,
                    t.items.length.toString(),
                    " : ",
                    length,
                ];
            }

            this.emitLine("var length = ", length, ";");
        }

        this.emitLine("writer.WriteStartArray();");
        t.items.forEach((itemType, i) => {
            if (i < t.minItems) {
                d.writeItem(itemType, item(i), false);
                return;
            }

            this.emitLine("if (length > ", i.toString(), ")");
            this.emitBlock(() => {
                if (!decodesNullToNull(itemType)) {
                    this.emitLine("if (", item(i), " == null)");
                    this.emitBlock(d.cannotMarshal);
                }

                d.writeItem(itemType, item(i), true);
            });
        });
        const rest = t.rest;
        if (rest !== undefined) {
            this.emitLine("if (value.", tupleRestName, " != null)");
            this.emitBlock(() => {
                this.emitLine(
                    "foreach (var item in value.",
                    tupleRestName,
                    ")",
                );
                this.emitBlock(() => d.writeItem(rest, "item", false));
            });
        }

        this.emitLine("writer.WriteEndArray();");
    }

    protected forEachTuple(
        blankLocations: BlankLineConfig,
        f: (t: TupleType, name: Name, position: ForEachPosition) => void,
    ): void {
        const tuples: Array<[TupleType, TupleType]> = [];
        const ignore = (): void => {};
        this.forEachNamedType("none", ignore, ignore, ignore, (t) =>
            tuples.push([t, t]),
        );
        this.forEachSpecificNamedType(blankLocations, tuples, f);
    }

    protected get haveTuples(): boolean {
        return iterableSome(
            this.typeGraph.allTypesUnordered(),
            (t) => t instanceof TupleType,
        );
    }

    protected emitExpressionMember(
        declare: Sourcelike,
        define: Sourcelike,
        isProperty = false,
    ): void {
        if (this._csOptions.version === 5) {
            this.emitLine(declare);
            this.emitBlock(() => {
                const stmt = ["return ", define, ";"];
                if (isProperty) {
                    this.emitLine("get");
                    this.emitBlock(() => this.emitLine(stmt));
                } else {
                    this.emitLine(stmt);
                }
            });
        } else {
            this.emitLine(declare, " => ", define, ";");
        }
    }

    protected emitTypeSwitch<T extends Sourcelike>(
        types: Iterable<T>,
        condition: (t: T) => Sourcelike,
        withBlock: boolean,
        withReturn: boolean,
        f: (t: T) => void,
    ): void {
        assert(!withReturn || withBlock, "Can only have return with block");
        for (const t of types) {
            this.emitLine("if (", condition(t), ")");
            if (withBlock) {
                this.emitBlock(() => {
                    f(t);
                    if (withReturn) {
                        this.emitLine("return;");
                    }
                });
            } else {
                this.indent(() => f(t));
            }
        }
    }

    protected emitUsing(ns: Sourcelike): void {
        this.emitLine("using ", ns, ";");
    }

    protected emitUsings(): void {
        for (const ns of ["System", "System.Collections.Generic"]) {
            this.emitUsing(ns);
        }
    }

    protected emitRequiredHelpers(): void {}

    private emitTypesAndSupport(): void {
        this.forEachObject(
            "leading-and-interposing",
            (c: ClassType, name: Name) => this.emitClassDefinition(c, name),
        );
        this.forEachTuple("leading-and-interposing", (t, name) =>
            this.emitTupleDefinition(t, name),
        );
        this.forEachEnum("leading-and-interposing", (e, name) =>
            this.emitEnumDefinition(e, name),
        );
        this.forEachUnion("leading-and-interposing", (u, name) =>
            this.emitUnionDefinition(u, name),
        );
        this.emitRequiredHelpers();
    }

    protected emitDefaultLeadingComments(): void {}

    protected emitDefaultFollowingComments(): void {}

    protected needNamespace(): boolean {
        return true;
    }

    protected emitSourceStructure(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        } else {
            this.emitDefaultLeadingComments();
        }

        this.ensureBlankLine();
        if (this.needNamespace()) {
            this.emitLine("namespace ", this._csOptions.namespace);
            this.emitBlock(() => {
                this.emitUsings();
                this.emitTypesAndSupport();
            });
        } else {
            this.emitUsings();
            this.emitTypesAndSupport();
        }

        this.emitDefaultFollowingComments();
    }

    protected emitDependencyUsings(): void {
        let genericEmited = false;
        const ensureGenericOnce = () => {
            if (!genericEmited) {
                this.emitUsing("System.Collections.Generic");
                genericEmited = true;
            }
        };
        this.typeGraph.allTypesUnordered().forEach((_) => {
            matchCompoundType(
                _,
                (_arrayType) =>
                    this._csOptions.useList ? ensureGenericOnce() : undefined,
                (_classType) => {},
                (_mapType) => ensureGenericOnce(),
                (_objectType) => {},
                (_unionType) => {},
                (tupleType) =>
                    tupleType.rest !== undefined && this._csOptions.useList
                        ? ensureGenericOnce()
                        : undefined,
            );
        });
    }
}
