import { arrayIntercalate } from "collection-utils";

import {
    minMaxItemsForType,
    minMaxLengthForType,
    minMaxValueForType,
    patternForType,
} from "../../attributes/Constraints.js";
import { topLevelNameOrder } from "../../ConvenienceRenderer.js";
import { DependencyName, type Name, funPrefixNamer } from "../../Naming.js";
import {
    type MultiWord,
    type Sourcelike,
    multiWord,
    parenIfNeeded,
    singleWord,
} from "../../Source.js";
import { assertNever, defined, panic } from "../../support/Support.js";
import {
    ChoiceTransformer,
    DecodingChoiceTransformer,
    DecodingTransformer,
    EncodingTransformer,
    ParseStringTransformer,
    StringifyTransformer,
    type Transformer,
    UnionInstantiationTransformer,
    UnionMemberMatchTransformer,
    transformationForType,
} from "../../Transformers.js";
import {
    type ClassType,
    TupleType,
    type Type,
    type UnionType,
} from "../../Type/index.js";
import { matchType } from "../../Type/TypeUtils.js";

import { PythonRenderer } from "./PythonRenderer.js";
import { snakeNameStyle } from "./utils.js";

const converterFunctions = [
    "none",
    "bool",
    "int",
    "from-float",
    "to-float",
    "str",
    "to-enum",
    "list",
    "to-class",
    "dict",
    "union",
    "from-date",
    "from-time",
    "from-datetime",
    "from-stringified-bool",
    "is-type",
    "from-tuple",
    "to-tuple",
] as const;

export type ConverterFunction = (typeof converterFunctions)[number];

// The name of the Python converter function `cf`.
function converterFunctionName(cf: ConverterFunction): string {
    const name = cf.replace(/-/g, "_");
    if (cf.startsWith("from-") || cf.startsWith("to-") || cf.startsWith("is-"))
        return name;
    return `from_${name}`;
}

interface TupleConverterNames {
    fromJSON: Name;
    toJSON: Name;
}

// Python's keywords (`keyword.kwlist`).
const keywords = new Set([
    "False",
    "None",
    "True",
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield",
]);

// Can `s` be written as a keyword argument, `s=...`?  Non-ASCII names are
// left out: Python NFKC-normalizes identifiers, so the keyword may not be
// `s`.
function isKeywordArgument(s: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !keywords.has(s);
}

interface TopLevelConverterNames {
    fromDict: Name;
    toDict: Name;
}

// A value or a lambda.  All four combinations are valid:
//
// * `value` and `lambda`: a value given by applying `value` to `lambda`, i.e. `lambda(value)`
// * `lambda` only: a lambda given by `lambda`
// * `value` only: a value given by `value`
// * neither: the identity function, i.e. `lambda x: x`
export interface ValueOrLambda {
    lambda?: MultiWord;
    value: Sourcelike | undefined;
}

// Return the result of composing `input` and `f`.  `input` can be a
// value or a lambda, but `f` must be a lambda or a TypeScript function
// (i.e. it can't be a value).
//
// * If `input` is a value, the result is `f(input)`.
// * If `input` is a lambda, the result is `lambda x: f(input(x))`
function compose(
    input: ValueOrLambda,
    f: ValueOrLambda | ((arg: Sourcelike) => Sourcelike),
): ValueOrLambda {
    if (typeof f === "function") {
        if (input.value !== undefined) {
            // `input` is a value, so just apply `f` to its source form.
            return { value: f(makeValue(input)) };
        }

        if (input.lambda !== undefined) {
            // `input` is a lambda, so build `lambda x: f(input(x))`.
            return {
                lambda: multiWord(
                    " ",
                    "lambda x:",
                    f([parenIfNeeded(input.lambda), "(x)"]),
                ),
                value: undefined,
            };
        }

        // `input` is the identify function, so the composition is `lambda x: f(x)`.
        return {
            lambda: multiWord(" ", "lambda x:", f("x")),
            value: undefined,
        };
    }

    if (f.value !== undefined) {
        return panic("Cannot compose into a value");
    }

    if (f.lambda === undefined) {
        // `f` is the identity function, so the result is just `input`.
        return input;
    }

    if (input.value === undefined) {
        // `input` is a lambda
        if (input.lambda === undefined) {
            // `input` is the identity function, so the result is just `f`.
            return f;
        }

        // `input` is a lambda, so the result is `lambda x: f(input(x))`.
        return {
            lambda: multiWord(
                "",
                "lambda x: ",
                parenIfNeeded(f.lambda),
                "(",
                parenIfNeeded(input.lambda),
                "(x))",
            ),
            value: undefined,
        };
    }

    // `input` is a value, so return `f(input)`.
    return { lambda: f.lambda, value: makeValue(input) };
}

const identity: ValueOrLambda = { value: undefined };

// If `vol` is a lambda, return it in its source form.  If it's
// a value, return a `lambda` that returns the value.
function makeLambda(vol: ValueOrLambda): MultiWord {
    if (vol.lambda !== undefined) {
        if (vol.value === undefined) {
            return vol.lambda;
        }

        return multiWord(
            "",
            "lambda x: ",
            parenIfNeeded(vol.lambda),
            "(",
            vol.value,
            ")",
        );
    }
    if (vol.value !== undefined) {
        return multiWord(" ", "lambda x:", vol.value);
    }

    return multiWord(" ", "lambda x:", "x");
}

// If `vol` is a value, return the value in its source form.
// Calling this with `vol` being a lambda is not allowed.
function makeValue(vol: ValueOrLambda): Sourcelike {
    if (vol.value === undefined) {
        return panic("Cannot make value from lambda without value");
    }

    if (vol.lambda !== undefined) {
        return [parenIfNeeded(vol.lambda), "(", vol.value, ")"];
    }

    return vol.value;
}

export class JSONPythonRenderer extends PythonRenderer {
    private readonly _deserializerFunctions = new Set<ConverterFunction>();

    private readonly _converterNamer = funPrefixNamer("converter", (s) =>
        snakeNameStyle(s, false, this.pyOptions.nicePropertyNames),
    );

    private readonly _topLevelConverterNames = new Map<
        Name,
        TopLevelConverterNames
    >();

    private readonly _tupleConverterNames = new Map<
        TupleType,
        TupleConverterNames
    >();

    private _haveTypeVar = false;

    private _haveEnumTypeVar = false;

    private _haveDateutil = false;

    // The converters of named tuples, `from_pair`, mustn't take the names
    // of the helper functions.
    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        return [
            ...super.forbiddenNamesForGlobalNamespace(),
            ...converterFunctions.map(converterFunctionName),
        ];
    }

    protected forbiddenForObjectProperties(c: ClassType, className: Name) {
        const result = super.forbiddenForObjectProperties(c, className);
        result.names = result.names.concat(["from_dict", "to_dict"]);
        // from_dict casts the aliases of pydantic models, and its locals are
        // the properties.
        if (this.pyOptions.pydanticBaseModel) {
            result.names = result.names.concat(["cast"]);
        }

        return result;
    }

    protected emitTypeVar(tvar: string, constraints: Sourcelike): void {
        if (!this.pyOptions.features.typeHints) {
            return;
        }

        this.emitLine(
            tvar,
            " = ",
            this.withTyping("TypeVar"),
            "(",
            this.string(tvar),
            constraints,
            ")",
        );
    }

    protected typeVar(): string {
        this._haveTypeVar = true;
        // FIXME: This is ugly, but the code that requires the type variables, in
        // `emitImports` actually runs after imports have been imported.  The proper
        // solution would be to either allow more complex dependencies, or to
        // gather-emit the type variable declarations, too.  Unfortunately the
        // gather-emit is a bit buggy with blank lines, and I can't be bothered to
        // fix it now.
        this.withTyping("TypeVar");
        return "T";
    }

    protected enumTypeVar(): string {
        this._haveEnumTypeVar = true;
        // See the comment above.
        this.withTyping("TypeVar");
        this.withImport("enum", "Enum");
        return "EnumT";
    }

    protected cast(type: Sourcelike, v: Sourcelike): Sourcelike {
        if (!this.pyOptions.features.typeHints) {
            return v;
        }

        return [this.withTyping("cast"), "(", type, ", ", v, ")"];
    }

    protected emitNoneConverter(): void {
        // FIXME: We can't return the None type here because mypy thinks that means
        // We're not returning any value, when we're actually returning `None`.
        this.emitBlock(
            [
                "def from_none(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> ", this.withTyping("Any")),
                ":",
            ],
            () => {
                this.emitLine("assert x is None");
                this.emitLine("return x");
            },
        );
    }

    protected emitBoolConverter(): void {
        this.emitBlock(
            [
                "def from_bool(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> bool"),
                ":",
            ],
            () => {
                this.emitLine("assert isinstance(x, bool)");
                this.emitLine("return x");
            },
        );
    }

    protected emitIntConverter(): void {
        this.emitBlock(
            [
                "def from_int(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> int"),
                ":",
            ],
            () => {
                this.emitLine(
                    "assert isinstance(x, int) and not isinstance(x, bool)",
                );
                this.emitLine("return x");
            },
        );
    }

    protected emitFromFloatConverter(): void {
        this.emitBlock(
            [
                "def from_float(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> float"),
                ":",
            ],
            () => {
                this.emitLine(
                    "assert isinstance(x, (float, int)) and not isinstance(x, bool)",
                );
                this.emitLine("return float(x)");
            },
        );
    }

    protected emitToFloatConverter(): void {
        this.emitBlock(
            [
                "def to_float(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> float"),
                ":",
            ],
            () => {
                this.emitLine("assert isinstance(x, (int, float))");
                this.emitLine("return x");
            },
        );
    }

    protected emitStrConverter(): void {
        this.emitBlock(
            [
                "def from_str(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> str"),
                ":",
            ],
            () => {
                const strType = "str";
                this.emitLine("assert isinstance(x, ", strType, ")");
                this.emitLine("return x");
            },
        );
    }

    // The annotation of a converter's class parameter, `: Type[T]`, and the
    // type of the class's instances, `T`.  Without `typing.Type` the class
    // can't be annotated, so its instances are `Any`: a TypeVar return type
    // that no parameter mentions binds to nothing, and mypy rejects it.
    protected classParameterHint(
        typeVar: () => string,
    ): [classHint: Sourcelike, instanceType: Sourcelike] {
        if (!this.pyOptions.features.typingType) {
            return [[], this.withTyping("Any")];
        }

        const tvar = typeVar();
        return [
            this.typeHint(": ", this.withTyping("Type"), "[", tvar, "]"),
            tvar,
        ];
    }

    protected emitToEnumConverter(): void {
        const [classHint, enumType] = this.classParameterHint(() =>
            this.enumTypeVar(),
        );
        this.emitBlock(
            [
                "def to_enum(c",
                classHint,
                ", ",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> ", enumType),
                ":",
            ],
            () => {
                this.emitLine("assert isinstance(x, c)");
                this.emitLine("return x.value");
            },
        );
    }

    protected emitListConverter(): void {
        const tvar = this.typeVar();
        this.emitBlock(
            [
                "def from_list(f",
                this.typeHint(
                    ": ",
                    this.withTyping("Callable"),
                    "[[",
                    this.withTyping("Any"),
                    "], ",
                    tvar,
                    "]",
                ),
                ", ",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(
                    " -> ",
                    this.pyOptions.features.builtinGenerics
                        ? "list"
                        : this.withTyping("List"),
                    "[",
                    tvar,
                    "]",
                ),
                ":",
            ],
            () => {
                this.emitLine("assert isinstance(x, list)");
                this.emitLine("return [f(y) for y in x]");
            },
        );
    }

    protected emitToClassConverter(): void {
        const [classHint] = this.classParameterHint(() => this.typeVar());
        this.emitBlock(
            [
                "def to_class(c",
                classHint,
                ", ",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> dict"),
                ":",
            ],
            () => {
                this.emitLine("assert isinstance(x, c)");
                this.emitLine(
                    "return ",
                    this.cast(this.withTyping("Any"), "x"),
                    ".to_dict()",
                );
            },
        );
    }

    protected emitDictConverter(): void {
        const tvar = this.typeVar();
        this.emitBlock(
            [
                "def from_dict(f",
                this.typeHint(
                    ": ",
                    this.withTyping("Callable"),
                    "[[",
                    this.withTyping("Any"),
                    "], ",
                    tvar,
                    "]",
                ),
                ", ",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(
                    " -> ",
                    this.pyOptions.features.builtinGenerics
                        ? "dict"
                        : this.withTyping("Dict"),
                    "[str, ",
                    tvar,
                    "]",
                ),
                ":",
            ],
            () => {
                this.emitLine("assert isinstance(x, dict)");
                this.emitLine("return { k: f(v) for (k, v) in x.items() }");
            },
        );
    }

    // This is not easily idiomatically typeable in Python.  See
    // https://stackoverflow.com/questions/51066468/computed-types-in-mypy/51084497
    protected emitUnionConverter(): void {
        this.emitMultiline(`def from_union(fs, x):
    for f in fs:
        try:
            return f(x)
        except:
            pass
    assert False`);
    }

    protected emitFromDateConverter(): void {
        this.emitBlock(
            [
                "def from_date(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> ", [
                    this.withModuleImport("datetime"),
                    ".date",
                ]),
                ":",
            ],
            () => {
                this._haveDateutil = true;
                this.emitLine(
                    "assert isinstance(x, str) and ",
                    this.withModuleImport("re"),
                    '.match(r"^\\d{4}-\\d{2}-\\d{2}$", x)',
                );
                this.emitLine("return dateutil.parser.parse(x).date()");
            },
        );
    }

    protected emitFromTimeConverter(): void {
        this.emitBlock(
            [
                "def from_time(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> ", [
                    this.withModuleImport("datetime"),
                    ".time",
                ]),
                ":",
            ],
            () => {
                this._haveDateutil = true;
                this.emitLine(
                    "assert isinstance(x, str) and ",
                    this.withModuleImport("re"),
                    '.match(r"^\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})?$", x)',
                );
                this.emitLine("return dateutil.parser.parse(x).timetz()");
            },
        );
    }

    protected emitFromDatetimeConverter(): void {
        this.emitBlock(
            [
                "def from_datetime(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> ", [
                    this.withModuleImport("datetime"),
                    ".datetime",
                ]),
                ":",
            ],
            () => {
                this._haveDateutil = true;
                this.emitLine("return dateutil.parser.parse(x)");
            },
        );
    }

    protected emitFromStringifiedBoolConverter(): void {
        this.emitBlock(
            [
                "def from_stringified_bool(x",
                this.typeHint(": str"),
                ")",
                this.typeHint(" -> bool"),
                ":",
            ],
            () => {
                this.emitBlock('if x == "true":', () =>
                    this.emitLine("return True"),
                );
                this.emitBlock('if x == "false":', () =>
                    this.emitLine("return False"),
                );
                this.emitLine("assert False");
            },
        );
    }

    protected emitIsTypeConverter(): void {
        const [typeHint, instanceType] = this.classParameterHint(() =>
            this.typeVar(),
        );
        this.emitBlock(
            [
                "def is_type(t",
                typeHint,
                ", ",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> ", instanceType),
                ":",
            ],
            () => {
                this.emitLine("assert isinstance(x, t)");
                this.emitLine("return x");
            },
        );
    }

    // A JSON array with an element of the right type in each position.
    protected emitFromTupleConverter(): void {
        this.emitBlock(
            [
                "def from_tuple(fs",
                this.typeHint(": ", this.converterListType()),
                ", ",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(
                    " -> ",
                    this.pyOptions.features.builtinGenerics
                        ? "tuple"
                        : this.withTyping("Tuple"),
                    "[",
                    this.withTyping("Any"),
                    ", ...]",
                ),
                ":",
            ],
            () => {
                this.emitLine(
                    "assert isinstance(x, list) and len(x) == len(fs)",
                );
                this.emitLine("return tuple(f(y) for (f, y) in zip(fs, x))");
            },
        );
    }

    protected emitToTupleConverter(): void {
        this.emitBlock(
            [
                "def to_tuple(fs",
                this.typeHint(": ", this.converterListType()),
                ", ",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(
                    " -> ",
                    this.pyOptions.features.builtinGenerics
                        ? "list"
                        : this.withTyping("List"),
                    "[",
                    this.withTyping("Any"),
                    "]",
                ),
                ":",
            ],
            () => {
                this.emitLine(
                    "assert isinstance(x, tuple) and len(x) == len(fs)",
                );
                this.emitLine("return [f(y) for (f, y) in zip(fs, x)]");
            },
        );
    }

    // `List[Callable[[Any], Any]]`, a converter per tuple item.
    private converterListType(): Sourcelike {
        return [
            this.pyOptions.features.builtinGenerics
                ? "list"
                : this.withTyping("List"),
            "[",
            this.withTyping("Callable"),
            "[[",
            this.withTyping("Any"),
            "], ",
            this.withTyping("Any"),
            "]]",
        ];
    }

    protected emitConverter(cf: ConverterFunction): void {
        switch (cf) {
            case "none": {
                this.emitNoneConverter();
                return;
            }

            case "bool": {
                this.emitBoolConverter();
                return;
            }

            case "int": {
                this.emitIntConverter();
                return;
            }

            case "from-float": {
                this.emitFromFloatConverter();
                return;
            }

            case "to-float": {
                this.emitToFloatConverter();
                return;
            }

            case "str": {
                this.emitStrConverter();
                return;
            }

            case "to-enum": {
                this.emitToEnumConverter();
                return;
            }

            case "list": {
                this.emitListConverter();
                return;
            }

            case "to-class": {
                this.emitToClassConverter();
                return;
            }

            case "dict": {
                this.emitDictConverter();
                return;
            }

            case "union": {
                this.emitUnionConverter();
                return;
            }

            case "from-date": {
                this.emitFromDateConverter();
                return;
            }

            case "from-time": {
                this.emitFromTimeConverter();
                return;
            }

            case "from-datetime": {
                this.emitFromDatetimeConverter();
                return;
            }

            case "from-stringified-bool": {
                this.emitFromStringifiedBoolConverter();
                return;
            }

            case "is-type": {
                this.emitIsTypeConverter();
                return;
            }

            case "from-tuple": {
                this.emitFromTupleConverter();
                return;
            }

            case "to-tuple": {
                this.emitToTupleConverter();
                return;
            }

            default:
                assertNever(cf);
        }
    }

    // Return the name of the Python converter function `cf`.
    protected conv(cf: ConverterFunction): Sourcelike {
        this._deserializerFunctions.add(cf);
        return converterFunctionName(cf);
    }

    // Applies the converter function to `arg`
    protected convFn(cf: ConverterFunction, arg: ValueOrLambda): ValueOrLambda {
        return compose(arg, {
            lambda: singleWord(this.conv(cf)),
            value: undefined,
        });
    }

    protected typeObject(t: Type): Sourcelike {
        const s = matchType<Sourcelike | undefined>(
            t,
            (_anyType) => undefined,
            (_nullType) => "type(None)",
            (_boolType) => "bool",
            (_integerType) => "int",
            (_doubleType) => "float",
            (_stringType) => "str",
            // isinstance needs the builtin, which every version has;
            // typing's List isn't imported without type hints (3.5).
            (_arrayType) => "list",
            (classType) => this.nameForNamedType(classType),
            (_mapType) => "dict",
            (enumType) => this.nameForNamedType(enumType),
            (_unionType) => undefined,
            (transformedStringType) => {
                if (transformedStringType.kind === "date") {
                    return [this.withModuleImport("datetime"), ".date"];
                }

                if (transformedStringType.kind === "time") {
                    return [this.withModuleImport("datetime"), ".time"];
                }

                if (transformedStringType.kind === "date-time") {
                    return [this.withModuleImport("datetime"), ".datetime"];
                }

                if (transformedStringType.kind === "uuid") {
                    return this.withImport("uuid", "UUID");
                }

                return undefined;
            },
            (_tupleType) => "tuple",
        );
        if (s === undefined) {
            return panic(`No type object for ${t.kind}`);
        }

        return s;
    }

    protected transformer(
        inputTransformer: ValueOrLambda,
        xfer: Transformer,
        targetType: Type,
    ): ValueOrLambda {
        const consume = (
            consumer: Transformer | undefined,
            vol: ValueOrLambda,
        ): ValueOrLambda => {
            if (consumer === undefined) {
                return vol;
            }

            return this.transformer(vol, consumer, targetType);
        };

        const isType = (
            t: Type,
            valueToCheck: ValueOrLambda,
        ): ValueOrLambda => {
            return compose(valueToCheck, (v) => [
                this.conv("is-type"),
                "(",
                this.typeObject(t),
                ", ",
                v,
                ")",
            ]);
        };

        if (
            xfer instanceof DecodingChoiceTransformer ||
            xfer instanceof ChoiceTransformer
        ) {
            const lambdas = xfer.transformers.map(
                (x) =>
                    makeLambda(this.transformer(identity, x, targetType))
                        .source,
            );
            return compose(inputTransformer, (v) => [
                this.conv("union"),
                "([",
                arrayIntercalate(", ", lambdas),
                "], ",
                v,
                ")",
            ]);
        }
        if (xfer instanceof DecodingTransformer) {
            const consumer = xfer.consumer;
            const vol = this.deserializer(inputTransformer, xfer.sourceType);
            return consume(consumer, vol);
        }
        if (xfer instanceof EncodingTransformer) {
            return this.serializer(inputTransformer, xfer.sourceType);
        }
        if (xfer instanceof UnionInstantiationTransformer) {
            return inputTransformer;
        }
        if (xfer instanceof UnionMemberMatchTransformer) {
            const consumer = xfer.transformer;
            const vol = isType(xfer.memberType, inputTransformer);
            return consume(consumer, vol);
        }
        if (xfer instanceof ParseStringTransformer) {
            const consumer = xfer.consumer;
            const immediateTargetType =
                consumer === undefined ? targetType : consumer.sourceType;
            let vol: ValueOrLambda;
            switch (immediateTargetType.kind) {
                case "integer":
                    vol = compose(inputTransformer, (v) => ["int(", v, ")"]);
                    break;
                case "bool":
                    vol = this.convFn(
                        "from-stringified-bool",
                        inputTransformer,
                    );
                    break;
                case "enum":
                    vol = this.deserializer(
                        inputTransformer,
                        immediateTargetType,
                    );
                    break;
                case "date":
                    vol = this.convFn("from-date", inputTransformer);
                    break;
                case "time":
                    vol = this.convFn("from-time", inputTransformer);
                    break;
                case "date-time":
                    vol = this.convFn("from-datetime", inputTransformer);
                    break;
                case "uuid":
                    vol = compose(inputTransformer, (v) => [
                        this.withImport("uuid", "UUID"),
                        "(",
                        v,
                        ")",
                    ]);
                    break;
                default:
                    return panic(
                        `Parsing of ${immediateTargetType.kind} in a transformer is not supported`,
                    );
            }

            return consume(consumer, vol);
        }
        if (xfer instanceof StringifyTransformer) {
            const consumer = xfer.consumer;
            let vol: ValueOrLambda;
            switch (xfer.sourceType.kind) {
                case "integer":
                    vol = compose(inputTransformer, (v) => ["str(", v, ")"]);
                    break;
                case "bool":
                    vol = compose(inputTransformer, (v) => [
                        "str(",
                        v,
                        ").lower()",
                    ]);
                    break;
                case "enum":
                    vol = this.serializer(inputTransformer, xfer.sourceType);
                    break;
                case "date":
                case "time":
                case "date-time":
                    vol = compose(inputTransformer, (v) => [v, ".isoformat()"]);
                    break;
                case "uuid":
                    vol = compose(inputTransformer, (v) => ["str(", v, ")"]);
                    break;
                default:
                    return panic(
                        `Parsing of ${xfer.sourceType.kind} in a transformer is not supported`,
                    );
            }

            return consume(consumer, vol);
        }

        return panic(`Transformer ${xfer.kind} is not supported`);
    }

    private unionMembers(unionType: UnionType): Type[] {
        // from_float also accepts integers, so from_int must be tried first.
        const members = Array.from(unionType.members);
        const integerIndex = members.findIndex((m) => m.kind === "integer");
        const doubleIndex = members.findIndex((m) => m.kind === "double");

        if (doubleIndex >= 0 && integerIndex > doubleIndex) {
            const integerType = defined(members[integerIndex]);
            members.splice(integerIndex, 1);
            members.splice(doubleIndex, 0, integerType);
        }

        return members;
    }

    // Returns the code to deserialize `value` as type `t`.  If `t` has
    // an associated transformer, the code for that transformer is
    // returned.
    protected deserializer(value: ValueOrLambda, t: Type): ValueOrLambda {
        const xf = transformationForType(t);
        if (xf !== undefined) {
            return this.transformer(value, xf.transformer, xf.targetType);
        }

        return matchType<ValueOrLambda>(
            t,
            (_anyType) => value,
            (_nullType) => this.convFn("none", value),
            (_boolType) => this.convFn("bool", value),
            (_integerType) => this.convFn("int", value),
            (_doubleType) => this.convFn("from-float", value),
            (_stringType) => this.convFn("str", value),
            (arrayType) =>
                compose(value, (v) => [
                    this.conv("list"),
                    "(",
                    makeLambda(this.deserializer(identity, arrayType.items))
                        .source,
                    ", ",
                    v,
                    ")",
                ]),
            (classType) =>
                compose(value, {
                    lambda: singleWord(
                        this.nameForNamedType(classType),
                        ".from_dict",
                    ),
                    value: undefined,
                }),
            (mapType) =>
                compose(value, (v) => [
                    this.conv("dict"),
                    "(",
                    makeLambda(this.deserializer(identity, mapType.values))
                        .source,
                    ", ",
                    v,
                    ")",
                ]),
            (enumType) =>
                compose(value, {
                    lambda: singleWord(this.nameForNamedType(enumType)),
                    value: undefined,
                }),
            (unionType) => {
                // FIXME: handle via transformers
                const deserializers = this.unionMembers(unionType).map(
                    (m) => makeLambda(this.deserializer(identity, m)).source,
                );
                return compose(value, (v) => [
                    this.conv("union"),
                    "([",
                    arrayIntercalate(", ", deserializers),
                    "], ",
                    v,
                    ")",
                ]);
            },
            (transformedStringType) => {
                // FIXME: handle via transformers
                if (transformedStringType.kind === "date") {
                    return this.convFn("from-date", value);
                }

                if (transformedStringType.kind === "time") {
                    return this.convFn("from-time", value);
                }

                if (transformedStringType.kind === "date-time") {
                    return this.convFn("from-datetime", value);
                }

                if (transformedStringType.kind === "uuid") {
                    return compose(value, (v) => [
                        this.withImport("uuid", "UUID"),
                        "(",
                        v,
                        ")",
                    ]);
                }

                return panic(
                    `Transformed type ${transformedStringType.kind} not supported`,
                );
            },
            (tupleType) => {
                const names = this._tupleConverterNames.get(tupleType);
                if (names !== undefined) {
                    return compose(value, {
                        lambda: singleWord(names.fromJSON),
                        value: undefined,
                    });
                }

                return this.tupleDeserializer(value, tupleType);
            },
        );
    }

    // `from_tuple([from_str, from_float], x)`
    private tupleDeserializer(
        value: ValueOrLambda,
        t: TupleType,
    ): ValueOrLambda {
        const deserializers = t.items.map(
            (item) => makeLambda(this.deserializer(identity, item)).source,
        );
        return compose(value, (v) => [
            this.conv("from-tuple"),
            "([",
            arrayIntercalate(", ", deserializers),
            "], ",
            v,
            ")",
        ]);
    }

    private tupleSerializer(value: ValueOrLambda, t: TupleType): ValueOrLambda {
        const serializers = t.items.map(
            (item) => makeLambda(this.serializer(identity, item)).source,
        );
        return compose(value, (v) => [
            this.conv("to-tuple"),
            "([",
            arrayIntercalate(", ", serializers),
            "], ",
            v,
            ")",
        ]);
    }

    protected serializer(value: ValueOrLambda, t: Type): ValueOrLambda {
        const xf = transformationForType(t);
        if (xf !== undefined) {
            const reverse = xf.reverse;
            return this.transformer(
                value,
                reverse.transformer,
                reverse.targetType,
            );
        }

        return matchType<ValueOrLambda>(
            t,
            (_anyType) => value,
            (_nullType) => this.convFn("none", value),
            (_boolType) => this.convFn("bool", value),
            (_integerType) => this.convFn("int", value),
            (_doubleType) => this.convFn("to-float", value),
            (_stringType) => this.convFn("str", value),
            (arrayType) =>
                compose(value, (v) => [
                    this.conv("list"),
                    "(",
                    makeLambda(this.serializer(identity, arrayType.items))
                        .source,
                    ", ",
                    v,
                    ")",
                ]),
            (classType) =>
                compose(value, (v) => [
                    this.conv("to-class"),
                    "(",
                    this.nameForNamedType(classType),
                    ", ",
                    v,
                    ")",
                ]),
            (mapType) =>
                compose(value, (v) => [
                    this.conv("dict"),
                    "(",
                    makeLambda(this.serializer(identity, mapType.values))
                        .source,
                    ", ",
                    v,
                    ")",
                ]),
            (enumType) =>
                compose(value, (v) => [
                    this.conv("to-enum"),
                    "(",
                    this.nameForNamedType(enumType),
                    ", ",
                    v,
                    ")",
                ]),
            (unionType) => {
                const serializers = this.unionMembers(unionType).map(
                    (m) => makeLambda(this.serializer(identity, m)).source,
                );
                return compose(value, (v) => [
                    this.conv("union"),
                    "([",
                    arrayIntercalate(", ", serializers),
                    "], ",
                    v,
                    ")",
                ]);
            },
            (transformedStringType) => {
                if (
                    transformedStringType.kind === "date" ||
                    transformedStringType.kind === "time" ||
                    transformedStringType.kind === "date-time"
                ) {
                    return compose(value, (v) => [v, ".isoformat()"]);
                }

                if (transformedStringType.kind === "uuid") {
                    return compose(value, (v) => ["str(", v, ")"]);
                }

                return panic(
                    `Transformed type ${transformedStringType.kind} not supported`,
                );
            },
            (tupleType) => {
                const names = this._tupleConverterNames.get(tupleType);
                if (names !== undefined) {
                    return compose(value, {
                        lambda: singleWord(names.toJSON),
                        value: undefined,
                    });
                }

                return this.tupleSerializer(value, tupleType);
            },
        );
    }

    // A named tuple, which may contain itself, is converted by functions of
    // its own: `from_pair` and `to_pair`.
    protected emitTuple(t: TupleType, tupleName: Name): void {
        super.emitTuple(t, tupleName);
        const { fromJSON, toJSON } = defined(this._tupleConverterNames.get(t));
        const pythonType = this.namedType(t);
        this.ensureBlankLine(2);
        this.emitBlock(
            [
                "def ",
                fromJSON,
                "(",
                this.typingDecl("x", "Any"),
                ")",
                this.typeHint(" -> ", pythonType),
                ":",
            ],
            () =>
                this.emitLine(
                    "return ",
                    makeValue(this.tupleDeserializer({ value: "x" }, t)),
                ),
        );
        this.ensureBlankLine(2);
        this.emitBlock(
            [
                "def ",
                toJSON,
                "(x",
                this.typeHint(": ", pythonType),
                ")",
                this.typingReturn("Any"),
                ":",
            ],
            () =>
                this.emitLine(
                    "return ",
                    makeValue(this.tupleSerializer({ value: "x" }, t)),
                ),
        );
    }

    protected makeNamedTypeDependencyNames(
        t: Type,
        name: Name,
    ): DependencyName[] {
        if (!(t instanceof TupleType)) return [];
        const fromJSON = new DependencyName(
            this._converterNamer,
            name.order,
            (l) => `from_${l(name)}`,
        );
        const toJSON = new DependencyName(
            this._converterNamer,
            name.order,
            (l) => `to_${l(name)}`,
        );
        this._tupleConverterNames.set(t, { fromJSON, toJSON });
        return [fromJSON, toJSON];
    }

    protected emitClassMembers(t: ClassType): void {
        super.emitClassMembers(t);
        this.ensureBlankLine();

        const className = this.nameForNamedType(t);

        this.emitLine("@staticmethod");
        this.emitBlock(
            [
                "def from_dict(",
                this.typingDecl("obj", "Any"),
                ")",
                this.typeHint(" -> ", this.namedType(t)),
                ":",
            ],
            () => {
                const args: Sourcelike[] = [];
                const aliasArgs: Sourcelike[] = [];
                this.emitLine("assert isinstance(obj, dict)");
                this.forEachClassProperty(t, "none", (name, jsonName, cp) => {
                    const property = {
                        value: cp.isOptional
                            ? ["obj.get(", this.string(jsonName), ")"]
                            : ["obj[", this.string(jsonName), "]"],
                    };
                    this.emitLine(
                        name,
                        " = ",
                        makeValue(this.deserializer(property, cp.type)),
                    );
                    // A pydantic model takes its fields as keyword
                    // arguments only, under their aliases.  An alias that
                    // can't be a keyword argument goes in a `**` dict,
                    // which mypy only takes as `Dict[str, Any]`.
                    const alias = this.pydanticAlias(name, jsonName);
                    if (!this.pyOptions.pydanticBaseModel) {
                        args.push(name);
                    } else if (alias === undefined) {
                        args.push([name, "=", name]);
                    } else if (isKeywordArgument(alias)) {
                        args.push([alias, "=", name]);
                    } else {
                        aliasArgs.push([this.string(alias), ": ", name]);
                    }
                    {
                        const [min, max] = minMaxItemsForType(cp.type) ?? [];
                        const check = (condition: Sourcelike): void =>
                            this.emitLine(
                                "assert ",
                                name,
                                " is None or ",
                                condition,
                            );
                        if (min !== undefined)
                            check([min.toString(), " <= len(", name, ")"]);
                        if (max !== undefined)
                            check(["len(", name, ") <= ", max.toString()]);
                        const [minValue, maxValue] =
                            minMaxValueForType(cp.type) ?? [];
                        if (minValue !== undefined)
                            check([minValue.toString(), " <= ", name]);
                        if (maxValue !== undefined)
                            check([name, " <= ", maxValue.toString()]);
                        const [lo, hi] = minMaxLengthForType(cp.type) ?? [];
                        if (lo !== undefined || hi !== undefined) {
                            const raw = this.cast("str", property.value);
                            if (lo !== undefined)
                                check([lo.toString(), " <= len(", raw, ")"]);
                            if (hi !== undefined)
                                check(["len(", raw, ") <= ", hi.toString()]);
                        }
                        const pattern = patternForType(cp.type);
                        if (pattern !== undefined)
                            check([
                                this.withModuleImport("re"),
                                ".search(",
                                this.string(pattern),
                                ", ",
                                this.cast("str", property.value),
                                ")",
                            ]);
                    }
                });
                if (aliasArgs.length > 0) {
                    const dict = this.pyOptions.features.builtinGenerics
                        ? "dict"
                        : this.withTyping("Dict");
                    args.push([
                        "**",
                        this.cast(
                            [dict, "[str, ", this.withTyping("Any"), "]"],
                            ["{", arrayIntercalate(", ", aliasArgs), "}"],
                        ),
                    ]);
                }

                this.emitLine(
                    "return ",
                    className,
                    "(",
                    arrayIntercalate(", ", args),
                    ")",
                );
            },
        );
        this.ensureBlankLine();

        this.emitBlock(
            ["def to_dict(self)", this.typeHint(" -> dict"), ":"],
            () => {
                this.emitLine("result", this.typeHint(": dict"), " = {}");
                this.forEachClassProperty(t, "none", (name, jsonName, cp) => {
                    const property = { value: ["self.", name] };
                    if (cp.isOptional) {
                        this.emitBlock(
                            ["if self.", name, " is not None:"],
                            () => {
                                this.emitLine(
                                    "result[",
                                    this.string(jsonName),
                                    "] = ",
                                    makeValue(
                                        this.serializer(property, cp.type),
                                    ),
                                );
                            },
                        );
                    } else {
                        this.emitLine(
                            "result[",
                            this.string(jsonName),
                            "] = ",
                            makeValue(this.serializer(property, cp.type)),
                        );
                    }
                });
                this.emitLine("return result");
            },
        );
    }

    protected emitImports(): void {
        super.emitImports();
        if (this._haveDateutil) {
            this.emitLine("import dateutil.parser");
        }

        if (!this._haveTypeVar && !this._haveEnumTypeVar) return;

        this.ensureBlankLine(2);
        if (this._haveTypeVar) {
            this.emitTypeVar(this.typeVar(), []);
        }

        if (this._haveEnumTypeVar) {
            this.emitTypeVar(this.enumTypeVar(), [
                ", bound=",
                this.withImport("enum", "Enum"),
            ]);
        }
    }

    protected emitSupportCode(): void {
        const map = Array.from(this._deserializerFunctions).map(
            (f) => [f, f] as [ConverterFunction, ConverterFunction],
        );
        this.forEachWithBlankLines(map, ["interposing", 2], (cf) => {
            this.emitConverter(cf);
        });
    }

    protected makeTopLevelDependencyNames(
        _t: Type,
        topLevelName: Name,
    ): DependencyName[] {
        const fromDict = new DependencyName(
            this._converterNamer,
            topLevelNameOrder,
            (l) => `${l(topLevelName)}_from_dict`,
        );
        const toDict = new DependencyName(
            this._converterNamer,
            topLevelNameOrder,
            (l) => `${l(topLevelName)}_to_dict`,
        );
        this._topLevelConverterNames.set(topLevelName, { fromDict, toDict });
        return [fromDict, toDict];
    }

    protected emitDefaultLeadingComments(): void {
        this.ensureBlankLine();
        if (this._haveDateutil) {
            this.emitCommentLines([
                "This code parses date/times, so please",
                "",
                "    pip install python-dateutil",
                "",
            ]);
        }

        this.emitCommentLines([
            "To use this code, make sure you",
            "",
            "    import json",
            "",
            "and then, to convert JSON from a string, do",
            "",
        ]);
        this.forEachTopLevel("none", (_, name) => {
            const { fromDict } = defined(
                this._topLevelConverterNames.get(name),
            );
            this.emitLine(
                this.commentLineStart,
                "    result = ",
                fromDict,
                "(json.loads(json_string))",
            );
        });
    }

    protected emitClosingCode(): void {
        this.forEachTopLevel(["interposing", 2], (t, name) => {
            const { fromDict, toDict } = defined(
                this._topLevelConverterNames.get(name),
            );
            const pythonType = this.pythonType(t);
            this.emitBlock(
                [
                    "def ",
                    fromDict,
                    "(",
                    this.typingDecl("s", "Any"),
                    ")",
                    this.typeHint(" -> ", pythonType),
                    ":",
                ],
                () => {
                    this.emitLine(
                        "return ",
                        makeValue(this.deserializer({ value: "s" }, t)),
                    );
                },
            );
            this.ensureBlankLine(2);
            this.emitBlock(
                [
                    "def ",
                    toDict,
                    "(x",
                    this.typeHint(": ", pythonType),
                    ")",
                    this.typingReturn("Any"),
                    ":",
                ],
                () => {
                    this.emitLine(
                        "return ",
                        makeValue(this.serializer({ value: "x" }, t)),
                    );
                },
            );
        });
    }
}
