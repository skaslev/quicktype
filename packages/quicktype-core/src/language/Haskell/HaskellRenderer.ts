import { arrayIntercalate, mapContains } from "collection-utils";

import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer.js";
import { DependencyName, type Name, type Namer } from "../../Naming.js";
import type { RenderContext } from "../../Renderer.js";
import type { OptionValues } from "../../RendererOptions/index.js";
import {
    type MultiWord,
    type Sourcelike,
    multiWord,
    parenIfNeeded,
    singleWord,
} from "../../Source.js";
import { stringEscape } from "../../support/Strings.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    type ClassProperty,
    type ClassType,
    type EnumType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import { matchType, nullableFromUnion } from "../../Type/TypeUtils.js";

import { forbiddenNames } from "./constants.js";
import type { haskellOptions } from "./language.js";
import { lowerNamingFunction, upperNamingFunction } from "./utils.js";

function haskellStringEscape(s: string): string {
    return stringEscape(s).replace(
        /\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g,
        (_match, bmp: string | undefined, astral: string | undefined) =>
            `\\x${bmp ?? astral}\\&`,
    );
}

// The kinds of JSON values, aeson's `Value` constructors: Object, Array,
// String, Number, Bool and Null.
const valueKindCount = 6;

// aeson has instances for tuples of up to 15 elements, as has Show.
const maxTupleLength = 15;

// How many array lengths a tuple accepts.
function acceptedLengths(t: TupleType): number {
    return t.rest === undefined
        ? t.items.length - t.minItems + 1
        : Number.POSITIVE_INFINITY;
}

function elements(n: number): string {
    return n === 1 ? "1 element" : `${n} elements`;
}

// What a tuple with optional items or a rest expects, for error messages.
function expectedTupleLength(t: TupleType): string {
    const min = t.minItems;
    const max = t.items.length;
    if (t.rest !== undefined) {
        return min === 0 ? "an array" : `an array of at least ${elements(min)}`;
    }

    return min === 0
        ? `an array of at most ${elements(max)}`
        : `an array of ${min} to ${max} elements`;
}

export class HaskellRenderer extends ConvenienceRenderer {
    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof haskellOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        return forbiddenNames;
    }

    protected makeNamedTypeNamer(): Namer {
        return upperNamingFunction;
    }

    protected namerForObjectProperty(): Namer {
        return lowerNamingFunction;
    }

    protected forbiddenForObjectProperties(
        _c: ClassType,
        _className: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected makeUnionMemberNamer(): Namer {
        return upperNamingFunction;
    }

    protected get unionMembersInGlobalNamespace(): boolean {
        return true;
    }

    protected makeEnumCaseNamer(): Namer {
        return upperNamingFunction;
    }

    protected get enumCasesInGlobalNamespace(): boolean {
        return true;
    }

    protected makeNameForEnumCase(
        e: EnumType,
        enumName: Name,
        caseName: string,
        assignedName: string | undefined,
    ): Name {
        const name = super.makeNameForEnumCase(
            e,
            enumName,
            caseName,
            assignedName,
        );
        const proposedName = name.firstProposedName(new Map());
        return new DependencyName(
            name.namingFunction,
            name.order,
            (lookup) => `${proposedName}_${lookup(enumName)}`,
        );
    }

    protected proposeUnionMemberName(
        u: UnionType,
        unionName: Name,
        fieldType: Type,
        lookup: (n: Name) => string,
    ): string {
        const fieldName = super.proposeUnionMemberName(
            u,
            unionName,
            fieldType,
            lookup,
        );
        return `${fieldName}_in_${lookup(unionName)}`;
    }

    protected get commentLineStart(): string {
        return "-- ";
    }

    protected emitDescriptionBlock(lines: Sourcelike[]): void {
        if (lines.length === 1) {
            this.emitComments([
                { customLines: lines, lineStart: "{-| ", lineEnd: " -}" },
            ]);
        } else {
            this.emitCommentLines(lines, {
                firstLineStart: "{-| ",
                lineStart: "",
                afterComment: "-}",
            });
        }
    }

    private haskellType(t: Type, noOptional = false): MultiWord {
        return matchType<MultiWord>(
            t,
            (_anyType) => singleWord("Value"),
            (_nullType) => multiWord(" ", "Maybe", "Text"),
            (_boolType) => singleWord("Bool"),
            (_integerType) => singleWord("Int"),
            (_doubleType) => singleWord("Double"),
            (_stringType) => singleWord("Text"),
            (arrayType) => this.haskellArray(arrayType.items),
            (classType) => singleWord(this.nameForNamedType(classType)),
            (mapType) =>
                multiWord(
                    " ",
                    "HashMap Text",
                    parenIfNeeded(this.haskellType(mapType.values)),
                ),
            (enumType) => singleWord(this.nameForNamedType(enumType)),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    const nullableType = this.haskellType(nullable);
                    if (noOptional) return nullableType;
                    return multiWord(" ", "Maybe", parenIfNeeded(nullableType));
                }

                return singleWord(this.nameForNamedType(unionType));
            },
            undefined,
            (tupleType) =>
                this.tupleNeedsName(tupleType)
                    ? singleWord(this.nameForNamedType(tupleType))
                    : this.tupleSource(tupleType),
        );
    }

    private haskellArray(items: Type): MultiWord {
        if (this._options.useList) {
            return multiWord(
                "",
                "[",
                parenIfNeeded(this.haskellType(items)),
                "]",
            );
        }

        return multiWord(" ", "Vector", parenIfNeeded(this.haskellType(items)));
    }

    // Tuples are spelled out, `(A, B)`, unless the schema names them or
    // they can't be a type synonym of a Haskell tuple.
    protected tupleNeedsName(t: TupleType): boolean {
        return this.hasGivenName(t) || this.tupleIsData(t);
    }

    /**
     * Whether a tuple is declared as a data type with JSON instances of its
     * own instead of a type synonym: a Haskell tuple has exactly one
     * element per item, so a tuple with optional items or a rest can't be
     * one, Haskell has no one-element tuple (and aeson encodes `Solo a` as
     * just `a`), longer tuples than `maxTupleLength` have no instances, and
     * a type synonym can't refer to itself, other than through a data type.
     */
    private tupleIsData(t: TupleType): boolean {
        const isData = (c: Type): boolean =>
            ["class", "enum"].includes(c.kind) ||
            (c instanceof UnionType && this.unionNeedsName(c)) ||
            (c instanceof TupleType &&
                (!c.isFixedLength ||
                    c.items.length === 1 ||
                    c.items.length > maxTupleLength));
        return isData(t) || this.isInCycleThrough(t, (c) => !isData(c));
    }

    private tupleSource(t: TupleType): MultiWord {
        const items = t.items.map((item) => this.haskellType(item).source);
        return singleWord("(", ...arrayIntercalate(", ", items), ")");
    }

    private haskellProperty(p: ClassProperty): Sourcelike {
        if (p.isOptional) {
            return multiWord(
                " ",
                "Maybe",
                parenIfNeeded(this.haskellType(p.type)),
            ).source;
        }

        return this.haskellType(p.type).source;
    }

    private encoderNameForType(t: Type): MultiWord {
        return matchType<MultiWord>(
            t,
            (_anyType) => singleWord("String"),
            (_nullType) => singleWord("Null"),
            (_boolType) => singleWord("Bool"),
            (_integerType) => singleWord("Number"),
            (_doubleType) => singleWord("Number"),
            (_stringType) => singleWord("String"),
            (_arrayType) => singleWord("Array"),
            (_classType) => singleWord("Object"),
            (_mapType) => singleWord("Object"),
            (_enumType) => singleWord("String"),
            (_unionType) => singleWord("Object"),
            undefined,
            (_tupleType) => singleWord("Array"),
        );
    }

    private emitTopLevelDefinition(t: Type, topLevelName: Name): void {
        this.emitLine("type ", topLevelName, " = ", this.haskellType(t).source);
    }

    private emitClassDefinition(c: ClassType, className: Name): void {
        let description = this.descriptionForType(c);
        this.forEachClassProperty(c, "none", (name, jsonName) => {
            const propertyDescription = this.descriptionForClassProperty(
                c,
                jsonName,
            );
            if (propertyDescription === undefined) return;

            if (description === undefined) {
                description = [];
            } else {
                description.push("");
            }

            description.push(`${this.sourcelikeToString(name)}:`);
            description.push(...propertyDescription);
        });

        this.emitDescription(description);
        this.emitLine("data ", className, " = ", className);
        this.indent(() => {
            let onFirst = true;
            this.forEachClassProperty(c, "none", (name, _jsonName, p) => {
                this.emitLine(
                    onFirst ? "{ " : ", ",
                    name,
                    className,
                    " :: ",
                    this.haskellProperty(p),
                );
                onFirst = false;
            });
            if (onFirst) {
                this.emitLine("{");
            }

            this.emitLine("} deriving (Show)");
        });
    }

    private enumCaseName(name: Name, enumName: Name): Sourcelike {
        return name instanceof DependencyName ? name : [name, enumName];
    }

    private emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("data ", enumName);
        this.indent(() => {
            let onFirst = true;
            this.forEachEnumCase(e, "none", (name) => {
                const equalsOrPipe = onFirst ? "=" : "|";
                this.emitLine(
                    equalsOrPipe,
                    " ",
                    this.enumCaseName(name, enumName),
                );
                onFirst = false;
            });
            this.emitLine("deriving (Show)");
        });
    }

    private emitUnionDefinition(u: UnionType, unionName: Name): void {
        this.emitDescription(this.descriptionForType(u));
        this.emitLine("data ", unionName);
        this.indent(() => {
            let onFirst = true;
            this.forEachUnionMember(u, null, "none", null, (name, t) => {
                const equalsOrPipe = onFirst ? "=" : "|";
                if (t.kind === "null") {
                    this.emitLine(equalsOrPipe, " ", name);
                } else {
                    this.emitLine(
                        equalsOrPipe,
                        " ",
                        name,
                        " ",
                        parenIfNeeded(this.haskellType(t)),
                    );
                }

                onFirst = false;
            });
            this.emitLine("deriving (Show)");
        });
    }

    private emitTupleDefinition(t: TupleType, tupleName: Name): void {
        this.emitDescription(this.descriptionForType(t));
        if (!this.tupleIsData(t)) {
            this.emitLine(
                "type ",
                tupleName,
                " = ",
                this.tupleSource(t).source,
            );
            return;
        }

        // A field per item, a `Maybe` for each optional one, and a final
        // array (a list or a `Vector`) for the rest: `[A, B?, ...C[]]` is
        // `T A (Maybe B) [C]`.  An optional item of a nullable type is a
        // `Maybe (Maybe A)`, which keeps a missing item apart from a null
        // one.
        const fields = t.items.map((item, i) => {
            const field = this.haskellType(item);
            return i < t.minItems
                ? field
                : multiWord(" ", "Maybe", parenIfNeeded(field));
        });
        if (t.rest !== undefined) fields.push(this.haskellArray(t.rest));
        this.emitLine(
            fields.length === 1 ? "newtype " : "data ",
            tupleName,
            " = ",
            tupleName,
            ...fields.map((field) => [" ", parenIfNeeded(field)]),
        );
        this.indent(() => this.emitLine("deriving (Show)"));
    }

    private emitTopLevelFunctions(topLevelName: Name): void {
        this.emitLine("decodeTopLevel :: ByteString -> Maybe ", topLevelName);
        this.emitLine("decodeTopLevel = decode");
    }

    private classPropertyLength(c: ClassType): number {
        let counter = 0;
        this.forEachClassProperty(c, "none", () => {
            counter += 1;
        });
        return counter;
    }

    private emitClassEncoderInstance(c: ClassType, className: Name): void {
        const classProperties: Array<Name | string> = [];
        this.forEachClassProperty(c, "none", (name) => {
            classProperties.push(" ");
            classProperties.push(name);
            classProperties.push(className);
        });

        this.emitLine("instance ToJSON ", className, " where");
        this.indent(() => {
            if (classProperties.length === 0) {
                this.emitLine("toJSON = \\_ -> emptyObject");
            } else {
                this.emitLine("toJSON (", className, ...classProperties, ") =");
                this.indent(() => {
                    this.emitLine("object $ foldMap (maybe [] pure)");
                    let onFirst = true;
                    const properties = c.getProperties();
                    this.forEachClassProperty(c, "none", (name, jsonName) => {
                        const optional = properties.get(jsonName)?.isOptional;
                        this.emitLine(
                            onFirst ? "[ " : ", ",
                            optional ? "(" : "Just $ ",
                            '"',
                            haskellStringEscape(jsonName),
                            optional ? '" .=) <$> ' : '" .= ',
                            name,
                            className,
                        );
                        onFirst = false;
                    });
                    if (onFirst) {
                        this.emitLine("[");
                    }

                    this.emitLine("]");
                });
            }
        });
    }

    private emitClassDecoderInstance(c: ClassType, className: Name): void {
        this.emitLine("instance FromJSON ", className, " where");

        this.indent(() => {
            // `withObject` fails on other JSON values, where a pattern
            // match on `Object` would throw.
            const withObject = [
                'parseJSON = withObject "',
                className,
                '" $ \\',
            ];
            if (this.classPropertyLength(c) === 0) {
                this.emitLine(withObject, "_ -> return ", className);
            } else {
                this.emitLine(withObject, "v -> ", className);
                this.indent(() => {
                    let onFirst = true;
                    this.forEachClassProperty(c, "none", (_, jsonName, p) => {
                        const operator = p.isOptional ? ".:!" : ".:";
                        this.emitLine(
                            onFirst ? "<$> " : "<*> ",
                            "v ",
                            operator,
                            ' "',
                            haskellStringEscape(jsonName),
                            '"',
                        );
                        onFirst = false;
                    });
                });
            }
        });
    }

    private emitClassFunctions(c: ClassType, className: Name): void {
        this.emitClassEncoderInstance(c, className);
        this.ensureBlankLine();
        this.emitClassDecoderInstance(c, className);
    }

    private emitEnumEncoderInstance(e: EnumType, enumName: Name): void {
        this.emitLine("instance ToJSON ", enumName, " where");
        this.indent(() => {
            this.forEachEnumCase(e, "none", (name, jsonName) => {
                this.emitLine(
                    "toJSON ",
                    this.enumCaseName(name, enumName),
                    ' = "',
                    haskellStringEscape(jsonName),
                    '"',
                );
            });
        });
    }

    private emitEnumDecoderInstance(e: EnumType, enumName: Name): void {
        this.emitLine("instance FromJSON ", enumName, " where");
        this.indent(() => {
            this.emitLine('parseJSON = withText "', enumName, '" parseText');
            this.indent(() => {
                this.emitLine("where");
                this.indent(() => {
                    this.forEachEnumCase(e, "none", (name, jsonName) => {
                        this.emitLine(
                            'parseText "',
                            haskellStringEscape(jsonName),
                            '" = return ',
                            this.enumCaseName(name, enumName),
                        );
                    });
                    this.emitLine(
                        'parseText invalid = fail ("expected ',
                        enumName,
                        ', but encountered " ++ show invalid)',
                    );
                });
            });
        });
    }

    private emitEnumFunctions(e: EnumType, enumName: Name): void {
        this.emitEnumEncoderInstance(e, enumName);
        this.ensureBlankLine();
        this.emitEnumDecoderInstance(e, enumName);
    }

    private emitUnionEncoderInstance(u: UnionType, unionName: Name): void {
        this.emitLine("instance ToJSON ", unionName, " where");
        this.indent(() => {
            this.forEachUnionMember(u, null, "none", null, (name, t) => {
                if (t.kind === "null") {
                    this.emitLine("toJSON ", name, " = Null");
                } else {
                    this.emitLine("toJSON (", name, " x) = toJSON x");
                }
            });
        });
    }

    /**
     * A union's tuples and array, which are all JSON arrays, if it has a
     * tuple and another one of them.  They're tried in turn, tuples first.
     */
    private arrayMembersTriedInTurn(u: UnionType): Name[] {
        const tuples: Array<[Name, number]> = [];
        const arrays: Name[] = [];
        this.forEachUnionMember(u, null, "none", null, (name, t) => {
            if (t instanceof TupleType) {
                tuples.push([name, acceptedLengths(t)]);
            } else if (t.kind === "array") arrays.push(name);
        });
        // Those that accept fewer lengths first.
        tuples.sort(([, a], [, b]) => a - b);
        return tuples.length > 0 && tuples.length + arrays.length > 1
            ? [...tuples.map(([name]) => name), ...arrays]
            : [];
    }

    private emitUnionDecoderInstance(u: UnionType, unionName: Name): void {
        const arrays = this.arrayMembersTriedInTurn(u);
        let arraysEmitted = false;
        // The kinds of JSON values the members take, the constructors of
        // `Value` they match.
        const kinds = new Set<string>();
        this.emitLine("instance FromJSON ", unionName, " where");
        this.indent(() => {
            this.forEachUnionMember(u, null, "none", null, (name, t) => {
                if (t.kind === "null") {
                    kinds.add("Null");
                    this.emitLine("parseJSON Null = return ", name);
                } else if (arrays.includes(name)) {
                    if (arraysEmitted) return;
                    arraysEmitted = true;
                    kinds.add("Array");
                    this.emitLine(
                        "parseJSON xs@(Array _) = ",
                        arrayIntercalate(
                            " <|> ",
                            arrays.map(
                                (n): Sourcelike => [
                                    "(fmap ",
                                    n,
                                    " . parseJSON) xs",
                                ],
                            ),
                        ),
                    );
                } else {
                    const kind = this.encoderNameForType(t).source;
                    kinds.add(this.sourcelikeToString(kind));
                    this.emitLine(
                        "parseJSON xs@(",
                        kind,
                        " _) = (fmap ",
                        name,
                        " . parseJSON) xs",
                    );
                }
            });
            // Fail on the other kinds, instead of throwing.
            if (kinds.size < valueKindCount) {
                this.emitLine(
                    'parseJSON invalid = typeMismatch "',
                    unionName,
                    '" invalid',
                );
            }
        });
    }

    private emitUnionFunctions(u: UnionType, unionName: Name): void {
        this.emitUnionEncoderInstance(u, unionName);
        this.ensureBlankLine();
        this.emitUnionDecoderInstance(u, unionName);
    }

    // The JSON of a tuple's data type is an array of its fields.
    private emitTupleFunctions(t: TupleType, tupleName: Name): void {
        if (!this.tupleIsData(t)) return;
        if (!t.isFixedLength) {
            this.emitVariableLengthTupleFunctions(t, tupleName);
            return;
        }

        const fields = t.items.map((_, i) => `x${i}`);
        this.emitLine("instance ToJSON ", tupleName, " where");
        this.indent(() => {
            this.emitLine(
                "toJSON (",
                tupleName,
                ...fields.map((x) => ` ${x}`),
                ") = toJSON [",
                fields.map((x) => `toJSON ${x}`).join(", "),
                "]",
            );
        });
        this.ensureBlankLine();
        this.emitLine("instance FromJSON ", tupleName, " where");
        this.indent(() => {
            this.emitLine("parseJSON v = do");
            this.indent(() => {
                this.emitLine("xs <- parseJSON v");
                this.emitLine("case xs of");
                this.indent(() => {
                    this.emitLine(
                        "[",
                        fields.join(", "),
                        "] -> ",
                        tupleName,
                        " <$> ",
                        fields.map((x) => `parseJSON ${x}`).join(" <*> "),
                    );
                    this.emitLine(
                        `_ -> fail "expected an array of length ${fields.length}"`,
                    );
                });
            });
        });
    }

    /**
     * The required items, the optional ones that are present, then the
     * rest.  An item after a missing optional one is an error, as JSON
     * can't leave a gap.  Reading checks the array's length and parses each
     * element as its item's type, so that a null is only accepted where the
     * item is nullable.
     */
    private emitVariableLengthTupleFunctions(
        t: TupleType,
        tupleName: Name,
    ): void {
        const items = t.items.map((_, i) => `x${i}`);
        const hasRest = t.rest !== undefined;
        const fields = hasRest ? [...items, "rest"] : items;
        const restList = this._options.useList
            ? "rest"
            : "(Data.Vector.toList rest)";
        const toJSONList = (values: string[], withRest: boolean): string => {
            const list =
                values.length === 0
                    ? "([] :: [Value])"
                    : `[${values.map((x) => `toJSON ${x}`).join(", ")}]`;
            return withRest
                ? `toJSON (${list} ++ map toJSON ${restList})`
                : `toJSON ${list}`;
        };

        const required = items.slice(0, t.minItems);
        const optional = items.slice(t.minItems);
        this.emitLine("instance ToJSON ", tupleName, " where");
        this.indent(() => {
            const lhs = [
                "toJSON (",
                tupleName,
                ...fields.map((x) => ` ${x}`),
                ") =",
            ];
            if (optional.length === 0) {
                this.emitLine(lhs, " ", toJSONList(required, true));
                return;
            }

            const scrutinee =
                optional.length === 1
                    ? optional[0]
                    : `(${optional.join(", ")})`;
            this.emitLine(lhs, " case ", scrutinee, " of");
            this.indent(() => {
                for (let present = 0; present <= optional.length; present++) {
                    const patterns = optional.map((_, i) =>
                        i < present ? `Just y${t.minItems + i}` : "Nothing",
                    );
                    const pattern =
                        patterns.length === 1
                            ? patterns[0]
                            : `(${patterns.join(", ")})`;
                    const all = present === optional.length;
                    this.emitLine(
                        pattern,
                        hasRest && !all ? " | null rest" : "",
                        " -> ",
                        toJSONList(
                            [
                                ...required,
                                ...optional
                                    .slice(0, present)
                                    .map((_, i) => `y${t.minItems + i}`),
                            ],
                            hasRest && all,
                        ),
                    );
                }

                if (optional.length > 1 || hasRest) {
                    this.emitLine(
                        '_ -> error "',
                        tupleName,
                        ': an item follows a missing optional item"',
                    );
                }
            });
        });
        this.ensureBlankLine();
        this.emitLine("instance FromJSON ", tupleName, " where");
        this.indent(() => {
            this.emitLine("parseJSON v = do");
            this.indent(() => {
                this.emitLine("xs <- parseJSON v");
                this.emitLine("case xs of");
                this.indent(() => {
                    for (
                        let present = 0;
                        present <= optional.length;
                        present++
                    ) {
                        const elementNames = items.slice(
                            0,
                            t.minItems + present,
                        );
                        const all = present === optional.length;
                        const pattern =
                            hasRest && all
                                ? `(${[...elementNames, "rest"].join(" : ")})`
                                : `[${elementNames.join(", ")}]`;
                        const parsed = items.map((x, i) =>
                            i < t.minItems
                                ? `parseJSON ${x}`
                                : i < t.minItems + present
                                  ? `(Just <$> parseJSON ${x})`
                                  : "pure Nothing",
                        );
                        if (hasRest) {
                            parsed.push(
                                !all
                                    ? "pure mempty"
                                    : this._options.useList
                                      ? "mapM parseJSON rest"
                                      : "(Data.Vector.fromList <$> mapM parseJSON rest)",
                            );
                        }

                        this.emitLine(
                            pattern,
                            " -> ",
                            tupleName,
                            " <$> ",
                            parsed.join(" <*> "),
                        );
                    }

                    // Without a rest, longer arrays are wrong; with one,
                    // only arrays shorter than the required items.
                    if (!hasRest || t.minItems > 0) {
                        this.emitLine(
                            '_ -> fail "',
                            tupleName,
                            `: expected ${expectedTupleLength(t)}"`,
                        );
                    }
                });
            });
        });
    }

    private emitLanguageExtensions(ext: string): void {
        this.emitLine(`{-# LANGUAGE ${ext} #-}`);
    }

    protected emitSourceStructure(): void {
        const exports: Sourcelike[] = [];
        this.forEachTopLevel("none", (_, name) => {
            exports.push([name, " (..)"]);
        });
        this.forEachObject("none", (t: ClassType, name: Name) => {
            if (!mapContains(this.topLevels, t)) exports.push([name, " (..)"]);
        });
        this.forEachEnum("none", (t, name) => {
            if (!mapContains(this.topLevels, t)) exports.push([name, " (..)"]);
        });
        this.forEachUnion("none", (t, name) => {
            if (!mapContains(this.topLevels, t)) exports.push([name, " (..)"]);
        });
        const ignore = (): void => undefined;
        this.forEachNamedType("none", ignore, ignore, ignore, (t, name) => {
            if (!mapContains(this.topLevels, t)) exports.push([name, " (..)"]);
        });

        this.emitLanguageExtensions("StrictData");
        this.emitLanguageExtensions("OverloadedStrings");

        if (!this._options.justTypes) {
            this.ensureBlankLine();
            this.emitLine("module ", this._options.moduleName);
            this.indent(() => {
                for (let i = 0; i < exports.length; i++) {
                    this.emitLine(i === 0 ? "(" : ",", " ", exports[i]);
                }

                this.emitLine(", decodeTopLevel");
                this.emitLine(") where");
            });
            this.ensureBlankLine();
            if (
                Array.from(this.namedUnions).some(
                    (u) => this.arrayMembersTriedInTurn(u).length > 0,
                )
            ) {
                this.emitLine("import Control.Applicative ((<|>))");
            }

            this.emitMultiline(`import Data.Aeson
import Data.Aeson.Types (emptyObject, typeMismatch)
import Data.ByteString.Lazy (ByteString)
import Data.HashMap.Strict (HashMap)
import Data.Text (Text)`);
            if (this._options.useList) {
                // this.emitLine("import List (map)");
            } else {
                this.emitLine("import Data.Vector (Vector)");
                // For the rests of tuples.
                if (
                    Array.from(this.typeGraph.allTypesUnordered()).some(
                        (t) => t instanceof TupleType && t.rest !== undefined,
                    )
                ) {
                    this.emitLine("import qualified Data.Vector");
                }
            }
        } else {
            // Just types: the module and the imports its types use.
            this.ensureBlankLine();
            this.emitLine("module ", this._options.moduleName);
            this.indent(() => {
                for (let i = 0; i < exports.length; i++) {
                    this.emitLine(i === 0 ? "(" : ",", " ", exports[i]);
                }

                this.emitLine(exports.length === 0 ? "(" : "", ") where");
            });
            this.ensureBlankLine();
            // Free-form values are Aeson's Value.
            if (
                Array.from(this.typeGraph.allTypesUnordered()).some(
                    (t) => t.kind === "any",
                )
            ) {
                this.emitLine("import Data.Aeson (Value)");
            }

            this.emitLine("import Data.HashMap.Strict (HashMap)");
            this.emitLine("import Data.Text (Text)");
            if (!this._options.useList) {
                this.emitLine("import Data.Vector (Vector)");
            }
        }

        this.forEachTopLevel(
            "leading-and-interposing",
            (t: Type, topLevelName: Name) =>
                this.emitTopLevelDefinition(t, topLevelName),
            (t) => this.namedTypeToNameForTopLevel(t) === undefined,
        );

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, className: Name) =>
                this.emitClassDefinition(c, className),
            (e: EnumType, enumName: Name) =>
                this.emitEnumDefinition(e, enumName),
            (u: UnionType, unionName: Name) =>
                this.emitUnionDefinition(u, unionName),
            (t: TupleType, tupleName: Name) =>
                this.emitTupleDefinition(t, tupleName),
        );

        // decodeTopLevel and the JSON instances need Aeson.
        if (this._options.justTypes) return;

        this.forEachTopLevel(
            "leading-and-interposing",
            (_: Type, topLevelName: Name) =>
                this.emitTopLevelFunctions(topLevelName),
        );

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, className: Name) =>
                this.emitClassFunctions(c, className),
            (e: EnumType, enumName: Name) =>
                this.emitEnumFunctions(e, enumName),
            (u: UnionType, unionName: Name) =>
                this.emitUnionFunctions(u, unionName),
            (t: TupleType, tupleName: Name) =>
                this.emitTupleFunctions(t, tupleName),
        );

        if (this._options.justTypes) return;

        this.ensureBlankLine();
    }
}
