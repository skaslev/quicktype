import { arrayIntercalate, mapContains } from "collection-utils";

import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import { minMaxItemsForType } from "../../attributes/Constraints.js";
import { minMaxLengthForType } from "../../attributes/Constraints.js";
import { minMaxValueForType } from "../../attributes/Constraints.js";
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
    annotated,
    multiWord,
    parenIfNeeded,
    singleWord,
} from "../../Source.js";
import { decapitalize } from "../../support/Strings.js";
import { defined } from "../../support/Support.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    type ClassProperty,
    ClassType,
    EnumType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import { matchType, nullableFromUnion } from "../../Type/TypeUtils.js";

import { forbiddenNames } from "./constants.js";
import type { elmOptions } from "./language.js";
import {
    elmStringEscape,
    lowerNamingFunction,
    requiredOrOptional,
    upperNamingFunction,
} from "./utils.js";

// The helpers of tuples' decoders and encoders.
const tupleHelperNames = [
    "tupleOfLength",
    "optionalTupleItem",
    "tupleRestItems",
    "presentTupleItems",
];

interface TopLevelDependent {
    decoder?: Name;
    encoder: Name;
}

interface NamedTypeDependent {
    decoder: Name;
    encoder: Name;
}

export class ElmRenderer extends ConvenienceRenderer {
    private readonly _topLevelDependents = new Map<Name, TopLevelDependent>();

    private readonly _namedTypeDependents = new Map<Name, NamedTypeDependent>();

    private readonly _classIsCustomType = new Map<ClassType, boolean>();

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof elmOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        const types = Array.from(this.typeGraph.allTypesUnordered());
        const tuples = types.filter(
            (t): t is TupleType => t instanceof TupleType,
        );

        // The tuple helpers, and the variables of the custom types'
        // decoders and encoders, `x0`, `x1`, ...: Elm doesn't allow a
        // variable to shadow a top-level definition.
        const arity = Math.max(
            0,
            ...tuples
                .filter((t) => this.tupleForm(t) === "custom")
                .map((t) => this.tupleFieldCount(t)),
            ...types
                .filter(
                    (t): t is ClassType =>
                        t instanceof ClassType && this.classIsCustomType(t),
                )
                .map((c) => c.getProperties().size),
        );
        return [
            ...forbiddenNames,
            ...(tuples.length > 0 ? tupleHelperNames : []),
            ...Array.from({ length: arity }, (_, i) => `x${i}`),
        ];
    }

    // Every tuple gets a decoder and an encoder function.  Only those that
    // the schema names, top-levels and tuples that aren't Elm tuples are
    // declared as types, see `tupleIsDeclared`.
    protected tupleNeedsName(_t: TupleType): boolean {
        return true;
    }

    /**
     * How a tuple is declared: Elm's 2- and 3-tuples hold fixed-length
     * tuples of 2 or 3 items; other tuples are records with a field per
     * item, `item0`, `item1`, ..., and `rest`.  A type alias can't refer to
     * itself, other than through a custom type, so a tuple that contains
     * itself otherwise is a custom type whose constructor takes the items
     * in order.
     */
    private tupleForm(t: TupleType): "tuple" | "record" | "custom" {
        const isCustomType = (c: Type): boolean =>
            c instanceof EnumType ||
            (c instanceof UnionType && nullableFromUnion(c) === null);
        if (this.isInCycleThrough(t, (c) => !isCustomType(c))) {
            return "custom";
        }

        return t.isFixedLength && (t.items.length === 2 || t.items.length === 3)
            ? "tuple"
            : "record";
    }

    private tupleIsDeclared(t: TupleType): boolean {
        return (
            this.tupleForm(t) !== "tuple" ||
            this.hasGivenName(t) ||
            mapContains(this.topLevels, t)
        );
    }

    /** The items, and the rest. */
    private tupleFieldCount(t: TupleType): number {
        return t.items.length + (t.rest === undefined ? 0 : 1);
    }

    /**
     * Whether a class is a custom type wrapping its record,
     * `type A = A { ... }`, instead of a type alias for the record.  Elm
     * doesn't allow a type alias to refer to itself, other than through a
     * custom type, so a class that contains itself through records,
     * lists, dicts, `Maybe`s and tuples that aren't custom types only is a
     * custom type.
     */
    private classIsCustomType(c: ClassType): boolean {
        let result = this._classIsCustomType.get(c);
        if (result !== undefined) return result;

        const isCustomType = (t: Type): boolean =>
            t instanceof EnumType ||
            (t instanceof UnionType && nullableFromUnion(t) === null) ||
            (t instanceof TupleType && this.tupleForm(t) === "custom");
        result = this.isInCycleThrough(c, (t) => !isCustomType(t));
        this._classIsCustomType.set(c, result);
        return result;
    }

    protected makeTopLevelDependencyNames(
        t: Type,
        topLevelName: Name,
    ): DependencyName[] {
        const encoder = new DependencyName(
            lowerNamingFunction,
            topLevelName.order,
            (lookup) => `${lookup(topLevelName)}_to_string`,
        );
        let decoder: DependencyName | undefined;
        if (this.namedTypeToNameForTopLevel(t) === undefined) {
            decoder = new DependencyName(
                lowerNamingFunction,
                topLevelName.order,
                (lookup) => lookup(topLevelName),
            );
        }

        this._topLevelDependents.set(topLevelName, { encoder, decoder });
        if (decoder !== undefined) {
            return [encoder, decoder];
        }

        return [encoder];
    }

    protected makeNamedTypeNamer(): Namer {
        return upperNamingFunction;
    }

    protected makeNamedTypeDependencyNames(
        _: Type,
        typeName: Name,
    ): DependencyName[] {
        const encoder = new DependencyName(
            lowerNamingFunction,
            typeName.order,
            (lookup) => `encode_${lookup(typeName)}`,
        );
        const decoder = new DependencyName(
            lowerNamingFunction,
            typeName.order,
            (lookup) => lookup(typeName),
        );
        this._namedTypeDependents.set(typeName, { encoder, decoder });
        return [encoder, decoder];
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

    private get arrayType(): string {
        return this._options.useList ? "List" : "Array";
    }

    private elmType(t: Type, noOptional = false): MultiWord {
        return matchType<MultiWord>(
            t,
            (_anyType) =>
                singleWord(annotated(anyTypeIssueAnnotation, "Jdec.Value")),
            (_nullType) => singleWord(annotated(nullTypeIssueAnnotation, "()")),
            (_boolType) => singleWord("Bool"),
            (_integerType) => singleWord("Int"),
            (_doubleType) => singleWord("Float"),
            (_stringType) => singleWord("String"),
            (arrayType) =>
                multiWord(
                    " ",
                    this.arrayType,
                    parenIfNeeded(this.elmType(arrayType.items)),
                ),
            (classType) => singleWord(this.nameForNamedType(classType)),
            (mapType) =>
                multiWord(
                    " ",
                    "Dict String",
                    parenIfNeeded(this.elmType(mapType.values)),
                ),
            (enumType) => singleWord(this.nameForNamedType(enumType)),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    const nullableType = this.elmType(nullable);
                    if (noOptional) return nullableType;
                    return multiWord(" ", "Maybe", parenIfNeeded(nullableType));
                }

                return singleWord(this.nameForNamedType(unionType));
            },
            undefined,
            (tupleType) =>
                this.tupleIsDeclared(tupleType)
                    ? singleWord(this.nameForNamedType(tupleType))
                    : this.elmTupleType(tupleType),
        );
    }

    /** `( A, B )` */
    private elmTupleType(t: TupleType): MultiWord {
        return singleWord(
            "( ",
            arrayIntercalate(
                ", ",
                t.items.map((item) => this.elmType(item).source),
            ),
            " )",
        );
    }

    /**
     * The type of each item, `Maybe` for the optional ones, and of the
     * rest.  An optional item that can be null is a `Maybe (Maybe a)`:
     * `Nothing` if it's missing, `Just Nothing` if it's null.
     */
    private tupleFieldTypes(t: TupleType): MultiWord[] {
        const types = t.items.map((item, i) =>
            i < t.minItems
                ? this.elmType(item)
                : multiWord(" ", "Maybe", parenIfNeeded(this.elmType(item))),
        );
        if (t.rest !== undefined) {
            types.push(
                multiWord(
                    " ",
                    this.arrayType,
                    parenIfNeeded(this.elmType(t.rest)),
                ),
            );
        }

        return types;
    }

    private tupleFieldNames(t: TupleType): string[] {
        const names = t.items.map((_, i) => `item${i}`);
        if (t.rest !== undefined) names.push("rest");
        return names;
    }

    private elmProperty(p: ClassProperty): Sourcelike {
        if (p.isOptional) {
            return multiWord(
                " ",
                "Maybe",
                parenIfNeeded(this.elmType(p.type, true)),
            ).source;
        }

        return this.elmType(p.type).source;
    }

    private decoderNameForNamedType(t: Type): Name {
        const name = this.nameForNamedType(t);
        return defined(this._namedTypeDependents.get(name)).decoder;
    }

    private decoderForNumber(t: Type, decoder: string): MultiWord {
        const [min, max] = minMaxValueForType(t) ?? [];
        if (min === undefined && max === undefined) return singleWord(decoder);
        const minCheck = min === undefined ? "True" : `x >= ${min}`;
        const maxCheck = max === undefined ? "True" : `x <= ${max}`;
        return singleWord(
            `(Jdec.andThen (\\x -> if ${minCheck} && ${maxCheck} then Jdec.succeed x else Jdec.fail "Number out of range") ${decoder})`,
        );
    }

    private arrayConstraint(t: Type): string {
        const [min, max] = minMaxItemsForType(t) ?? [];
        if (min === undefined && max === undefined) return "";
        const length = `${this.arrayType}.length x`;
        const minCheck = min === undefined ? "True" : `${length} >= ${min}`;
        const maxCheck = max === undefined ? "True" : `${length} <= ${max}`;
        return `|> Jdec.andThen (\\x -> if ${minCheck} && ${maxCheck} then Jdec.succeed x else Jdec.fail "Array length out of range")`;
    }

    private decoderForString(t: Type): MultiWord {
        const [min, max] = minMaxLengthForType(t) ?? [];
        if (min === undefined && max === undefined)
            return singleWord("Jdec.string");
        const length = "List.length (String.toList x)";
        const minCheck = min === undefined ? "True" : `${length} >= ${min}`;
        const maxCheck = max === undefined ? "True" : `${length} <= ${max}`;
        return singleWord(
            `(Jdec.andThen (\\x -> if ${minCheck} && ${maxCheck} then Jdec.succeed x else Jdec.fail "String length out of range") Jdec.string)`,
        );
    }

    private decoderNameForType(t: Type, noOptional = false): MultiWord {
        return matchType<MultiWord>(
            t,
            (_anyType) => singleWord("Jdec.value"),
            (_nullType) => multiWord(" ", "Jdec.null", "()"),
            (_boolType) => singleWord("Jdec.bool"),
            (integerType) => this.decoderForNumber(integerType, "Jdec.int"),
            (doubleType) => this.decoderForNumber(doubleType, "Jdec.float"),
            (stringType) => this.decoderForString(stringType),
            (arrayType) =>
                multiWord(
                    " ",
                    ["Jdec.", decapitalize(this.arrayType)],
                    parenIfNeeded(this.decoderNameForType(arrayType.items)),
                    this.arrayConstraint(arrayType),
                ),
            (classType) => singleWord(this.decoderNameForNamedType(classType)),
            (mapType) =>
                multiWord(
                    " ",
                    "Jdec.dict",
                    parenIfNeeded(this.decoderNameForType(mapType.values)),
                ),
            (enumType) => singleWord(this.decoderNameForNamedType(enumType)),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    const nullableDecoder = this.decoderNameForType(nullable);
                    if (noOptional) return nullableDecoder;
                    return multiWord(
                        " ",
                        "Jdec.nullable",
                        parenIfNeeded(nullableDecoder),
                    );
                }

                return singleWord(this.decoderNameForNamedType(unionType));
            },
            undefined,
            (tupleType) => singleWord(this.decoderNameForNamedType(tupleType)),
        );
    }

    private decoderNameForProperty(p: ClassProperty): MultiWord {
        if (p.isOptional) {
            return multiWord(
                " ",
                p.type.isNullable ? "Jdec.nullable" : "Jdec.map Just",
                parenIfNeeded(this.decoderNameForType(p.type, true)),
            );
        }

        return this.decoderNameForType(p.type);
    }

    private encoderNameForNamedType(t: Type): Name {
        const name = this.nameForNamedType(t);
        return defined(this._namedTypeDependents.get(name)).encoder;
    }

    private encoderNameForType(t: Type, noOptional = false): MultiWord {
        return matchType<MultiWord>(
            t,
            (_anyType) => singleWord("identity"),
            (_nullType) => multiWord(" ", "always", "Jenc.null"),
            (_boolType) => singleWord("Jenc.bool"),
            (_integerType) => singleWord("Jenc.int"),
            (_doubleType) => singleWord("Jenc.float"),
            (_stringType) => singleWord("Jenc.string"),
            (arrayType) =>
                multiWord(
                    " ",
                    ["Jenc.", decapitalize(this.arrayType)],
                    parenIfNeeded(this.encoderNameForType(arrayType.items)),
                ),
            (classType) => singleWord(this.encoderNameForNamedType(classType)),
            (mapType) =>
                multiWord(
                    " ",
                    "Jenc.dict",
                    "identity",
                    parenIfNeeded(this.encoderNameForType(mapType.values)),
                ),
            (enumType) => singleWord(this.encoderNameForNamedType(enumType)),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    const nullableEncoder = this.encoderNameForType(nullable);
                    if (noOptional) return nullableEncoder;
                    return multiWord(
                        " ",
                        "makeNullableEncoder",
                        parenIfNeeded(nullableEncoder),
                    );
                }

                return singleWord(this.encoderNameForNamedType(unionType));
            },
            undefined,
            (tupleType) => singleWord(this.encoderNameForNamedType(tupleType)),
        );
    }

    private encoderNameForProperty(p: ClassProperty): MultiWord {
        if (p.isOptional) {
            return multiWord(
                " ",
                "makeNullableEncoder",
                parenIfNeeded(this.encoderNameForType(p.type, true)),
            );
        }

        return this.encoderNameForType(p.type);
    }

    private emitTopLevelDefinition(t: Type, topLevelName: Name): void {
        this.emitLine(
            "type alias ",
            topLevelName,
            " = ",
            this.elmType(t).source,
        );
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
        const wrapped = this.classIsCustomType(c);
        if (wrapped) {
            this.emitLine("type ", className, " =");
        } else {
            this.emitLine("type alias ", className, " =");
        }
        this.indent(() => {
            if (wrapped) {
                this.emitLine(className);
            }
            const indent = wrapped
                ? (f: () => void): void => this.indent(f)
                : (f: () => void): void => f();
            indent(() => {
                let onFirst = true;
                this.forEachClassProperty(c, "none", (name, _jsonName, p) => {
                    this.emitLine(
                        onFirst ? "{" : ",",
                        " ",
                        name,
                        " : ",
                        this.elmProperty(p),
                    );
                    onFirst = false;
                });
                if (onFirst) {
                    this.emitLine("{");
                }

                this.emitLine("}");
            });
        });
    }

    private emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("type ", enumName);
        this.indent(() => {
            let onFirst = true;
            this.forEachEnumCase(e, "none", (name) => {
                const equalsOrPipe = onFirst ? "=" : "|";
                this.emitLine(equalsOrPipe, " ", name);
                onFirst = false;
            });
        });
    }

    private emitUnionDefinition(u: UnionType, unionName: Name): void {
        this.emitDescription(this.descriptionForType(u));
        this.emitLine("type ", unionName);
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
                        parenIfNeeded(this.elmType(t)),
                    );
                }

                onFirst = false;
            });
        });
    }

    private emitTupleDefinition(t: TupleType, tupleName: Name): void {
        if (!this.tupleIsDeclared(t)) return;

        this.emitDescription(this.descriptionForType(t));
        const form = this.tupleForm(t);
        if (form === "tuple") {
            this.emitLine(
                "type alias ",
                tupleName,
                " = ",
                this.elmTupleType(t).source,
            );
            return;
        }

        const types = this.tupleFieldTypes(t);
        if (form === "custom") {
            this.emitLine("type ", tupleName);
            this.indent(() =>
                this.emitLine(
                    "= ",
                    tupleName,
                    ...types.map((type) => [" ", parenIfNeeded(type)]),
                ),
            );
            return;
        }

        this.emitLine("type alias ", tupleName, " =");
        this.indent(() => {
            this.tupleFieldNames(t).forEach((name, i) => {
                this.emitLine(
                    i === 0 ? "{" : ",",
                    " ",
                    name,
                    " : ",
                    types[i].source,
                );
            });
            this.emitLine("}");
        });
    }

    private emitTopLevelFunctions(t: Type, topLevelName: Name): void {
        const { encoder, decoder } = defined(
            this._topLevelDependents.get(topLevelName),
        );
        if (this.namedTypeToNameForTopLevel(t) === undefined) {
            this.emitLine(defined(decoder), " : Jdec.Decoder ", topLevelName);
            this.emitLine(
                defined(decoder),
                " = ",
                this.decoderNameForType(t).source,
            );
            this.ensureBlankLine();
        }

        this.emitLine(encoder, " : ", topLevelName, " -> String");
        this.emitLine(
            encoder,
            " r = Jenc.encode 0 (",
            this.encoderNameForType(t).source,
            " r)",
        );
    }

    private emitClassFunctions(c: ClassType, className: Name): void {
        const wrapped = this.classIsCustomType(c);
        const decoderName = this.decoderNameForNamedType(c);
        this.emitLine(decoderName, " : Jdec.Decoder ", className);
        this.emitLine(decoderName, " =");
        this.indent(() => {
            if (c.getProperties().size === 0) {
                this.emitLine(
                    "Jdec.dict Jdec.value |> Jdec.map (\\_ -> ",
                    className,
                    ")",
                );
                return;
            }
            if (wrapped) {
                // A function of the properties that wraps their record.
                const parameters: string[] = [];
                const fields: Sourcelike[] = [];
                this.forEachClassProperty(c, "none", (name) => {
                    const x = `x${parameters.length}`;
                    fields.push([
                        fields.length === 0 ? "{ " : ", ",
                        name,
                        " = ",
                        x,
                    ]);
                    parameters.push(x);
                });
                this.emitLine(
                    "Jdec.succeed (\\",
                    parameters.join(" "),
                    " -> ",
                    className,
                    " ",
                    fields,
                    " })",
                );
            } else {
                this.emitLine("Jdec.succeed ", className);
            }
            this.indent(() => {
                this.forEachClassProperty(c, "none", (_, jsonName, p) => {
                    // Elm rejects a value that is defined in terms of
                    // itself, so a property that contains the record is
                    // decoded lazily (also through a union, which breaks
                    // the cycle of types but not of decoders).
                    const propDecoder = this.containsType(p.type, c)
                        ? [
                              "(Jdec.lazy (\\_ -> ",
                              this.decoderNameForProperty(p).source,
                              "))",
                          ]
                        : parenIfNeeded(this.decoderNameForProperty(p));
                    const { reqOrOpt, fallback } = requiredOrOptional(p);
                    if (reqOrOpt.endsWith("optional")) {
                        this.emitLine([
                            '|> Jpipe.custom (optionalField "',
                            elmStringEscape(jsonName),
                            '" ',
                            propDecoder,
                            fallback,
                            ")",
                        ]);
                        return;
                    }
                    this.emitLine(
                        "|> ",
                        reqOrOpt,
                        ' "',
                        elmStringEscape(jsonName),
                        '" ',
                        propDecoder,
                        fallback,
                    );
                });
            });
        });
        this.ensureBlankLine();

        const encoderName = this.encoderNameForNamedType(c);
        this.emitLine(encoderName, " : ", className, " -> Jenc.Value");
        if (wrapped) {
            this.emitLine(encoderName, " (", className, " x) =");
        } else {
            this.emitLine(encoderName, " x =");
        }
        // An optional property that's `Nothing` is left out: null isn't
        // valid for it, and its decoder rejects it.  Unless it's nullable:
        // Elm can't tell its absence from null, and null is valid for it.
        const leftOutIfNothing = (p: ClassProperty): boolean =>
            p.isOptional && !p.type.isNullable;
        const leavesOut = Array.from(c.getProperties().values()).some(
            leftOutIfNothing,
        );
        this.indent(() => {
            this.emitLine(
                "Jenc.object",
                leavesOut ? " <| List.filterMap identity" : "",
            );
            this.indent(() => {
                let onFirst = true;
                this.forEachClassProperty(c, "none", (name, jsonName, p) => {
                    const bracketOrComma = onFirst ? "[" : ",";
                    const key = ['"', elmStringEscape(jsonName), '"'];
                    onFirst = false;
                    if (leftOutIfNothing(p)) {
                        this.emitLine(
                            bracketOrComma,
                            " Maybe.map (\\y -> (",
                            key,
                            ", ",
                            this.encoderNameForType(p.type, true).source,
                            " y)) x.",
                            name,
                        );
                        return;
                    }

                    const propEncoder = this.encoderNameForProperty(p).source;
                    this.emitLine(
                        bracketOrComma,
                        leavesOut ? " Just (" : " (",
                        key,
                        ", ",
                        propEncoder,
                        " x.",
                        name,
                        ")",
                    );
                });
                if (onFirst) {
                    this.emitLine("[");
                }

                this.emitLine("]");
            });
        });
    }

    private emitEnumFunctions(e: EnumType, enumName: Name): void {
        const decoderName = this.decoderNameForNamedType(e);
        this.emitLine(decoderName, " : Jdec.Decoder ", enumName);
        this.emitLine(decoderName, " =");
        this.indent(() => {
            this.emitLine("Jdec.string");
            this.indent(() => {
                this.emitLine("|> Jdec.andThen (\\str ->");
                this.indent(() => {
                    this.emitLine("case str of");
                    this.indent(() => {
                        this.forEachEnumCase(e, "none", (name, jsonName) => {
                            this.emitLine(
                                '"',
                                elmStringEscape(jsonName),
                                '" -> Jdec.succeed ',
                                name,
                            );
                        });
                        this.emitLine(
                            'somethingElse -> Jdec.fail <| "Invalid ',
                            enumName,
                            ': " ++ somethingElse',
                        );
                    });
                });
                this.emitLine(")");
            });
        });
        this.ensureBlankLine();

        const encoderName = this.encoderNameForNamedType(e);
        this.emitLine(encoderName, " : ", enumName, " -> Jenc.Value");
        this.emitLine(encoderName, " x = case x of");
        this.indent(() => {
            this.forEachEnumCase(e, "none", (name, jsonName) => {
                this.emitLine(
                    name,
                    ' -> Jenc.string "',
                    elmStringEscape(jsonName),
                    '"',
                );
            });
        });
    }

    // Whether `t` is `target` or contains it.
    private containsType(t: Type, target: Type): boolean {
        const seen = new Set<Type>();
        const work = [t];
        for (let c = work.pop(); c !== undefined; c = work.pop()) {
            if (c === target) return true;
            if (seen.has(c)) continue;
            seen.add(c);
            work.push(...c.getNonAttributeChildren());
        }

        return false;
    }

    /**
     * Checks the length of the JSON array, then decodes the items with
     * `Jdec.index`, the optional ones only if they're there, and the rest.
     * The items' decoders are in a function, so the decoder can refer to
     * itself.
     */
    private emitTupleFunctions(t: TupleType, tupleName: Name): void {
        const form = this.tupleForm(t);
        const type = this.elmType(t).source;
        const [minConstraint, maxConstraint] = minMaxItemsForType(t) ?? [];
        const min = Math.max(t.minItems, minConstraint ?? 0);
        const max = t.rest === undefined ? t.items.length : maxConstraint;
        // The decoders of optional items and the rest need the length.
        const needsLength = t.minItems < t.items.length || t.rest !== undefined;

        const decoderName = this.decoderNameForNamedType(t);
        this.emitLine(decoderName, " : Jdec.Decoder ", type);
        this.emitLine(decoderName, " =");
        this.indent(() => {
            this.emitLine(
                "tupleOfLength ",
                min.toString(),
                max === undefined ? " Nothing" : ` (Just ${max})`,
                needsLength ? " (\\m ->" : " (\\_ ->",
            );
            this.indent(() => {
                const decoders: Sourcelike[] = t.items.map((item, i) => {
                    const decoder = parenIfNeeded(
                        this.decoderNameForType(item),
                    );
                    return i < t.minItems
                        ? ["(Jdec.index ", i.toString(), " ", decoder, ")"]
                        : [
                              "(optionalTupleItem m ",
                              i.toString(),
                              " ",
                              decoder,
                              ")",
                          ];
                });
                const rest = t.rest;
                if (rest !== undefined) {
                    const items: Sourcelike = [
                        "tupleRestItems m ",
                        t.items.length.toString(),
                        " ",
                        parenIfNeeded(this.decoderNameForType(rest)),
                    ];
                    decoders.push(
                        this._options.useList
                            ? ["(", items, ")"]
                            : ["(Jdec.map Array.fromList (", items, "))"],
                    );
                }

                if (form === "tuple") {
                    this.emitLine(
                        t.items.length === 2
                            ? "Jdec.map2 Tuple.pair"
                            : "Jdec.map3 (\\x y r -> ( x, y, r ))",
                    );
                    this.indent(() => {
                        decoders.forEach((decoder, i) => {
                            this.emitLine(
                                decoder,
                                i === decoders.length - 1 ? ")" : "",
                            );
                        });
                    });
                    return;
                }

                this.emitLine("Jdec.succeed ", tupleName);
                this.indent(() => {
                    decoders.forEach((decoder, i) => {
                        this.emitLine(
                            "|> Jpipe.custom ",
                            decoder,
                            i === decoders.length - 1 ? ")" : "",
                        );
                    });
                });
            });
        });
        this.ensureBlankLine();

        // The items' values, in order.
        const fields =
            form === "tuple"
                ? ["x", "y", "r"].slice(0, t.items.length)
                : form === "custom"
                  ? Array.from(
                        { length: this.tupleFieldCount(t) },
                        (_, i) => `x${i}`,
                    )
                  : this.tupleFieldNames(t).map((name) => `x.${name}`);
        const hasOptionalItems = t.minItems < t.items.length;
        const encoded: Sourcelike[] = t.items.map((item, i) => {
            const encoder = this.encoderNameForType(item).source;
            if (!hasOptionalItems) return [encoder, " ", fields[i]];
            if (i < t.minItems) {
                return ["Just (", encoder, " ", fields[i], ")"];
            }

            return [
                "Maybe.map ",
                parenIfNeeded(this.encoderNameForType(item)),
                " ",
                fields[i],
            ];
        });
        const rest = t.rest;
        let restValues: Sourcelike | undefined;
        if (rest !== undefined) {
            const values = this._options.useList
                ? fields[t.items.length]
                : ["(Array.toList ", fields[t.items.length], ")"];
            const restEncoder = parenIfNeeded(this.encoderNameForType(rest));
            restValues = [
                " ++ List.map ",
                hasOptionalItems
                    ? ["(Just << ", restEncoder, ")"]
                    : restEncoder,
                " ",
                values,
            ];
        }

        const encoderName = this.encoderNameForNamedType(t);
        this.emitLine(encoderName, " : ", type, " -> Jenc.Value");
        if (form === "tuple") {
            this.emitLine(encoderName, " ( ", fields.join(", "), " ) =");
            this.indent(() =>
                this.emitLine(
                    "Jenc.list identity [ ",
                    arrayIntercalate(", ", encoded),
                    " ]",
                ),
            );
            return;
        }

        if (form === "custom") {
            this.emitLine(
                encoderName,
                " (",
                tupleName,
                " ",
                fields.join(" "),
                ") =",
            );
        } else {
            this.emitLine(encoderName, " x =");
        }

        // An item after a missing optional item can't be written: the
        // array ends at the first missing item.
        this.indent(() => {
            this.emitLine(
                "Jenc.list identity",
                hasOptionalItems ? " (presentTupleItems" : "",
                restValues === undefined ? "" : " (",
            );
            this.indent(() => {
                encoded.forEach((e, i) => {
                    this.emitLine(i === 0 ? "[ " : ", ", e);
                });
                this.emitLine(
                    "]",
                    restValues === undefined ? "" : [restValues, ")"],
                    hasOptionalItems ? ")" : "",
                );
            });
        });
    }

    private emitUnionFunctions(u: UnionType, unionName: Name): void {
        // We need arrays first, then strings, and integers before doubles.
        // Tuples go before arrays, which would take them too: fixed-length
        // ones first, then those with optional items, then those with a
        // rest.
        function sortOrder(_: Name, t: Type): string {
            if (t instanceof TupleType) {
                const shape =
                    t.rest !== undefined
                        ? 2
                        : t.minItems < t.items.length
                          ? 1
                          : 0;
                return `  ${shape}tuple`;
            }

            if (t.kind === "array") {
                return "  array";
            }
            if (t.kind === "double") {
                return " xdouble";
            }
            if (t.isPrimitive()) {
                return ` ${t.kind}`;
            }

            return t.kind;
        }

        const decoderName = this.decoderNameForNamedType(u);
        this.emitLine(decoderName, " : Jdec.Decoder ", unionName);
        this.emitLine(decoderName, " =");
        this.indent(() => {
            this.emitLine("Jdec.oneOf");
            this.indent(() => {
                let onFirst = true;
                this.forEachUnionMember(
                    u,
                    null,
                    "none",
                    sortOrder,
                    (name, t) => {
                        const bracketOrComma = onFirst ? "[" : ",";
                        if (t.kind === "null") {
                            this.emitLine(bracketOrComma, " Jdec.null ", name);
                        } else {
                            // Elm rejects a value that is defined in terms of
                            // itself, so a member that contains the union is
                            // decoded lazily.
                            const decoder = this.containsType(t, u)
                                ? [
                                      "(Jdec.lazy (\\_ -> ",
                                      this.decoderNameForType(t).source,
                                      "))",
                                  ]
                                : parenIfNeeded(this.decoderNameForType(t));
                            this.emitLine(
                                bracketOrComma,
                                " Jdec.map ",
                                name,
                                " ",
                                decoder,
                            );
                        }

                        onFirst = false;
                    },
                );
                this.emitLine("]");
            });
        });
        this.ensureBlankLine();

        const encoderName = this.encoderNameForNamedType(u);
        this.emitLine(encoderName, " : ", unionName, " -> Jenc.Value");
        this.emitLine(encoderName, " x = case x of");
        this.indent(() => {
            this.forEachUnionMember(u, null, "none", sortOrder, (name, t) => {
                if (t.kind === "null") {
                    this.emitLine(name, " -> Jenc.null");
                } else {
                    const encoder = this.encoderNameForType(t).source;
                    this.emitLine(name, " y -> ", encoder, " y");
                }
            });
        });
    }

    private emitTupleHelpers(tuples: readonly TupleType[]): void {
        this.emitLine("--- tuple helpers");
        this.ensureBlankLine();
        this.emitMultiline(`tupleOfLength : Int -> Maybe Int -> (Int -> Jdec.Decoder a) -> Jdec.Decoder a
tupleOfLength x y f =
    Jdec.list Jdec.value
        |> Jdec.andThen (\\m ->
            if List.length m < x || Maybe.withDefault False (Maybe.map (\\r -> List.length m > r) y) then
                Jdec.fail ("Unexpected number of tuple elements: " ++ String.fromInt (List.length m))
            else
                f (List.length m))`);
        if (tuples.some((t) => t.minItems < t.items.length)) {
            this.ensureBlankLine();
            this.emitMultiline(`optionalTupleItem : Int -> Int -> Jdec.Decoder a -> Jdec.Decoder (Maybe a)
optionalTupleItem m x decoder =
    if x < m then Jdec.map Just (Jdec.index x decoder) else Jdec.succeed Nothing

presentTupleItems : List (Maybe Jenc.Value) -> List Jenc.Value
presentTupleItems m =
    case m of
        (Just x) :: y -> x :: presentTupleItems y
        _ -> []`);
        }

        if (tuples.some((t) => t.rest !== undefined)) {
            this.ensureBlankLine();
            this.emitMultiline(`tupleRestItems : Int -> Int -> Jdec.Decoder a -> Jdec.Decoder (List a)
tupleRestItems m x decoder =
    List.foldr (\\y r -> Jdec.map2 (::) (Jdec.index y decoder) r) (Jdec.succeed []) (List.range x (m - 1))`);
        }

        this.ensureBlankLine();
    }

    protected emitSourceStructure(): void {
        const exports: Sourcelike[] = [];
        const topLevelDecoders: Sourcelike[] = [];
        this.forEachTopLevel("none", (t, name) => {
            let { encoder, decoder } = defined(
                this._topLevelDependents.get(name),
            );
            if (decoder === undefined) {
                decoder = defined(this._namedTypeDependents.get(name)).decoder;
            }

            topLevelDecoders.push(decoder);
            // A top-level custom type, an enum, a union, a record that
            // contains itself or a tuple that's a custom type, exposes its
            // constructors, as the other custom types do.
            const isCustomType =
                t instanceof EnumType ||
                (t instanceof UnionType && nullableFromUnion(t) === null) ||
                (t instanceof ClassType && this.classIsCustomType(t)) ||
                (t instanceof TupleType && this.tupleForm(t) === "custom");
            exports.push(
                isCustomType ? [name, "(..)"] : name,
                encoder,
                decoder,
            );
        });
        this.forEachObject("none", (t: ClassType, name: Name) => {
            if (mapContains(this.topLevels, t)) return;
            exports.push(this.classIsCustomType(t) ? [name, "(..)"] : name);
        });
        this.forEachEnum("none", (t, name) => {
            if (!mapContains(this.topLevels, t)) exports.push([name, "(..)"]);
        });
        this.forEachUnion("none", (t, name) => {
            if (!mapContains(this.topLevels, t)) exports.push([name, "(..)"]);
        });
        const tuples: TupleType[] = [];
        const ignore = (): void => undefined;
        this.forEachNamedType("none", ignore, ignore, ignore, (t, name) => {
            tuples.push(t);
            if (mapContains(this.topLevels, t) || !this.tupleIsDeclared(t)) {
                return;
            }

            exports.push(
                this.tupleForm(t) === "custom" ? [name, "(..)"] : name,
            );
        });

        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        } else if (!this._options.justTypes) {
            this.emitCommentLines([
                "To decode the JSON data, add this file to your project, run",
                "",
                "    elm install NoRedInk/elm-json-decode-pipeline",
                "",
                "add these imports",
                "",
                "    import Json.Decode exposing (decodeString)",
            ]);
            this.emitLine(
                "--     import ",
                this._options.moduleName,
                " exposing (",
                arrayIntercalate(", ", topLevelDecoders),
                ")",
            );
            this.emitMultiline(`--
-- and you're off to the races with
--`);
            this.forEachTopLevel("none", (_, name) => {
                let { decoder } = defined(this._topLevelDependents.get(name));
                if (decoder === undefined) {
                    decoder = defined(
                        this._namedTypeDependents.get(name),
                    ).decoder;
                }

                this.emitLine("--     decodeString ", decoder, " myJsonString");
            });
        }

        if (!this._options.justTypes) {
            this.ensureBlankLine();
            this.emitLine("module ", this._options.moduleName, " exposing");
            this.indent(() => {
                for (let i = 0; i < exports.length; i++) {
                    this.emitLine(i === 0 ? "(" : ",", " ", exports[i]);
                }

                this.emitLine(")");
            });
            this.ensureBlankLine();

            this.emitMultiline(`import Json.Decode as Jdec
import Json.Decode.Pipeline as Jpipe
import Json.Encode as Jenc
import Dict exposing (Dict)`);
            if (!this._options.useList) {
                this.emitLine("import Array exposing (Array)");
            }
        } else {
            // Just types: a module of type aliases and custom types only.
            this.ensureBlankLine();
            this.emitLine(
                "module ",
                this._options.moduleName,
                " exposing (..)",
            );
            this.ensureBlankLine();
            this.emitLine("import Dict exposing (Dict)");
            if (!this._options.useList) {
                this.emitLine("import Array exposing (Array)");
            }

            // Free-form values are Json.Decode.Value (Jdec.Value).
            if (
                Array.from(this.typeGraph.allTypesUnordered()).some(
                    (t) => t.kind === "any",
                )
            ) {
                this.emitLine("import Json.Decode as Jdec");
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

        if (this._options.justTypes) return;

        this.ensureBlankLine();
        this.emitLine("-- decoders and encoders");
        this.emitMultiline(`optionalField key decoder fallback =
    Jdec.dict Jdec.value
        |> Jdec.andThen (\\m ->
            case Dict.get key m of
                Nothing -> Jdec.succeed fallback
                Just x -> Jdec.decodeValue decoder x |> Result.map Jdec.succeed |> Result.withDefault (Jdec.fail ("Invalid " ++ key)))`);
        this.forEachTopLevel(
            "leading-and-interposing",
            (t: Type, topLevelName: Name) =>
                this.emitTopLevelFunctions(t, topLevelName),
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
        this.ensureBlankLine();

        if (tuples.length > 0) {
            this.emitTupleHelpers(tuples);
        }

        this.emitLine("--- encoder helpers");
        this.ensureBlankLine();
        this.emitMultiline(`makeNullableEncoder : (a -> Jenc.Value) -> Maybe a -> Jenc.Value
makeNullableEncoder f m =
	case m of
	Just x -> f x
	Nothing -> Jenc.null`);
    }
}
