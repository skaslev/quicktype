import { iterableSome } from "collection-utils";

import type { Name } from "../../Naming.js";
import { type Sourcelike, modifySource } from "../../Source.js";
import { camelCase } from "../../support/Strings.js";
import { defined, mustNotHappen } from "../../support/Support.js";
import type { ArrayType, EnumType, MapType, Type } from "../../Type/index.js";
import { TupleType, UnionType } from "../../Type/index.js";
import { matchType, nullableFromUnion } from "../../Type/TypeUtils.js";

import { KotlinRenderer } from "./KotlinRenderer.js";
import { expectedTupleLength, stringEscape } from "./utils.js";

// kotlinx.serialization has no built-in serializers for java.time, so we
// emit our own and register them file-wide with `@file:UseSerializers`.
// Like the Jackson converters, they parse with `.parse` and format with the
// ISO formatters so values round-trip faithfully.
const dateTimeSerializers = [
    {
        kind: "date-time",
        name: "OffsetDateTimeSerializer",
        type: "OffsetDateTime",
        formatter: "ISO_OFFSET_DATE_TIME",
    },
    {
        kind: "date",
        name: "LocalDateSerializer",
        type: "LocalDate",
        formatter: "ISO_LOCAL_DATE",
    },
    {
        kind: "time",
        name: "OffsetTimeSerializer",
        type: "OffsetTime",
        formatter: "ISO_OFFSET_TIME",
    },
] as const;

/**
 * Currently supports simple classes, enums, and TS string unions (which are also enums).
 * TODO: Union, Any, Top Level Array, Top Level Map
 */
export class KotlinXRenderer extends KotlinRenderer {
    protected override emitUnionDefinition(u: UnionType, name: Name): void {
        if (nullableFromUnion(u) === null) {
            this.emitLine(["typealias ", name, " = JsonElement"]);
            return;
        }
        super.emitUnionDefinition(u, name);
    }

    protected override kotlinType(
        t: Type,
        withIssues = false,
        noOptional = false,
    ): Sourcelike {
        if (t instanceof UnionType && nullableFromUnion(t) === null)
            return "JsonElement";
        return super.kotlinType(t, withIssues, noOptional);
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        return [
            ...super.forbiddenNamesForGlobalNamespace(),
            ...dateTimeSerializers.map((s) => s.name),
            "CompositeDecoder",
            "Decoder",
            "Encoder",
            "ExperimentalSerializationApi",
            "KSerializer",
            "ListSerializer",
            "MapSerializer",
            "SerializationException",
            "PrimitiveKind",
            "Serializable",
            "SerialDescriptor",
            "SerialName",
            "UseSerializers",
        ];
    }

    private usedDateTimeSerializers(): Array<
        (typeof dateTimeSerializers)[number]
    > {
        return dateTimeSerializers.filter((s) =>
            this.haveTransformedStringType(s.kind),
        );
    }

    protected anySourceType(optional: string): Sourcelike {
        return ["JsonElement", optional];
    }

    protected arrayType(
        arrayType: ArrayType,
        withIssues = false,
        noOptional = false,
    ): Sourcelike {
        const valType = this.kotlinType(arrayType.items, withIssues, true);
        const name = this.sourcelikeToString(valType);
        if (name === "JsonObject" || name === "JsonElement") {
            return "JsonArray";
        }

        return super.arrayType(arrayType, withIssues, noOptional);
    }

    protected mapType(
        mapType: MapType,
        withIssues = false,
        noOptional = false,
    ): Sourcelike {
        const valType = this.kotlinType(mapType.values, withIssues, true);
        const name = this.sourcelikeToString(valType);
        if (name === "JsonObject" || name === "JsonElement") {
            return "JsonObject";
        }

        return super.mapType(mapType, withIssues, noOptional);
    }

    protected emitTopLevelMap(t: MapType, name: Name): void {
        const elementType = this.kotlinType(t.values);
        if (elementType === "JsonObject") {
            this.emitLine(["typealias ", name, " = JsonObject"]);
        } else {
            super.emitTopLevelMap(t, name);
        }
    }

    protected emitTopLevelArray(t: ArrayType, name: Name): void {
        const elementType = this.kotlinType(t.items);
        this.emitLine(["typealias ", name, " = List<", elementType, ">"]);
    }

    protected emitUsageHeader(): void {
        this.emitLine(
            "// To parse the JSON, install kotlin's serialization plugin and do:",
        );
        this.emitLine("//");
        const table: Sourcelike[][] = [];
        table.push([
            "// val ",
            "json",
            " = Json { allowStructuredMapKeys = true }",
        ]);
        this.forEachTopLevel("none", (_, name) => {
            table.push([
                "// val ",
                modifySource(camelCase, name),
                ` = json.parse(${this.sourcelikeToString(name)}.serializer(), jsonString)`,
            ]);
        });
        this.emitTable(table);
    }

    protected emitFileAnnotations(): void {
        const serializers = this.usedDateTimeSerializers();
        if (serializers.length === 0) return;

        this.emitLine(
            "@file:UseSerializers(",
            serializers.map((s) => `${s.name}::class`).join(", "),
            ")",
        );
        this.ensureBlankLine();
    }

    protected emitHeader(): void {
        super.emitHeader();

        this.emitLine("import kotlinx.serialization.*");
        this.emitLine("import kotlinx.serialization.json.*");
        this.emitLine("import kotlinx.serialization.descriptors.*");
        this.emitLine("import kotlinx.serialization.encoding.*");
        if (
            iterableSome(
                this.typeGraph.allTypesUnordered(),
                (t) => t instanceof TupleType,
            )
        ) {
            this.emitLine("import kotlinx.serialization.builtins.*");
        }
    }

    /** The serializer for values of type `t`, as `kotlinType` renders it. */
    private serializerFor(t: Type): Sourcelike {
        if (t instanceof UnionType) {
            const nullable = nullableFromUnion(t);
            return nullable === null
                ? "JsonElement.serializer()"
                : [this.serializerFor(nullable), ".nullable"];
        }

        return matchType<Sourcelike>(
            t,
            (_anyType) => "JsonElement.serializer().nullable",
            (_nullType) => "JsonElement.serializer().nullable",
            (_boolType) => "Boolean.serializer()",
            (_integerType) => "Long.serializer()",
            (_doubleType) => "Double.serializer()",
            (_stringType) => "String.serializer()",
            (arrayType) =>
                this.sourcelikeToString(this.arrayType(arrayType)) ===
                "JsonArray"
                    ? "JsonArray.serializer()"
                    : [
                          "ListSerializer(",
                          this.serializerFor(arrayType.items),
                          ")",
                      ],
            (classType) => [this.nameForNamedType(classType), ".serializer()"],
            (mapType) =>
                this.sourcelikeToString(this.mapType(mapType)) === "JsonObject"
                    ? "JsonObject.serializer()"
                    : [
                          "MapSerializer(String.serializer(), ",
                          this.serializerFor(mapType.values),
                          ")",
                      ],
            (enumType) => [this.nameForNamedType(enumType), ".serializer()"],
            (_unionType) => mustNotHappen(),
            (transformedStringType) => {
                const serializer = dateTimeSerializers.find(
                    (s) => s.kind === transformedStringType.kind,
                );
                return serializer === undefined
                    ? "String.serializer()"
                    : serializer.name;
            },
            (tupleType) => [this.nameForNamedType(tupleType), ".Serializer"],
        );
    }

    protected emitTupleAnnotations(_t: TupleType, tupleName: Name): void {
        this.emitLine(
            "@Serializable(with = ",
            tupleName,
            ".Serializer::class)",
        );
    }

    // A tuple is a JSON array, so its serializer is a list's: it decodes
    // the elements in turn, each with its item's serializer, and checks
    // their number; it encodes the required items, the optional ones that
    // are present, then the rest.
    protected emitTupleDefinitionMethods(t: TupleType, tupleName: Name): void {
        const properties = this.tupleProperties(t, tupleName);
        const fail = (verb: string, message: string): Sourcelike => [
            'throw SerializationException("Cannot ',
            verb,
            " ",
            tupleName,
            ": ",
            message,
            '")',
        ];
        const failLength = fail(
            "deserialize",
            `expected ${expectedTupleLength(t)}`,
        );
        const optionals = properties.filter(
            (p) => p.kind === "optional" || p.kind === "optional-nullable",
        );
        const serializer = (p: (typeof properties)[number]): Sourcelike =>
            this.serializerFor(p.type);
        const isNullable = (p: (typeof properties)[number]): boolean =>
            this.sourcelikeToString(this.kotlinType(p.type)).endsWith("?");

        const emitDeserialize = (): void => {
            for (const p of properties) {
                if (p.kind === "rest") {
                    this.emitLine(
                        "val rest = mutableListOf<",
                        this.kotlinType(p.type),
                        ">()",
                    );
                } else {
                    const type =
                        p.kind === "required"
                            ? [this.kotlinType(p.type, false, true), "?"]
                            : p.kotlinType;
                    this.emitLine("var ", p.name, ": ", type, " = null");
                }
            }

            this.emitLine("var size = 0");
            this.emitBlock("while (true)", () => {
                this.emitBlock(
                    "when (val index = decodeElementIndex(descriptor))",
                    () => {
                        this.emitLine("CompositeDecoder.DECODE_DONE -> break");
                        properties.forEach((p, i) => {
                            if (p.kind === "rest") {
                                this.emitLine(
                                    "else -> rest.add(decodeSerializableElement(descriptor, index, ",
                                    serializer(p),
                                    "))",
                                );
                                return;
                            }

                            const decode: Sourcelike = [
                                "decodeSerializableElement(descriptor, ",
                                i.toString(),
                                ", ",
                                serializer(p),
                                ")",
                            ];
                            this.emitLine(
                                i.toString(),
                                " -> ",
                                p.name,
                                " = ",
                                p.kind === "optional-nullable"
                                    ? [defined(p.holder), "(", decode, ")"]
                                    : decode,
                            );
                        });
                        if (t.rest === undefined) {
                            this.emitLine("else -> ", failLength);
                        }
                    },
                );
                this.emitLine("size++");
            });
            this.emitLine(
                "if (size < ",
                t.minItems.toString(),
                ") ",
                failLength,
            );
            this.emitLine(tupleName, "(");
            this.indent(() => {
                properties.forEach((p, i) => {
                    const comma = i === properties.length - 1 ? "" : ",";
                    const value =
                        p.kind === "required" && !isNullable(p)
                            ? `${p.name}!!`
                            : p.name;
                    this.emitLine(value, comma);
                });
            });
            this.emitLine(")");
        };

        const emitSerialize = (): void => {
            const required = properties.filter((p) => p.kind === "required");
            optionals.forEach((p, i) => {
                if (i === 0) return;
                this.emitLine(
                    "if (value.",
                    p.name,
                    " != null && value.",
                    optionals[i - 1].name,
                    " == null) ",
                    fail(
                        "serialize",
                        "an item follows a missing optional item",
                    ),
                );
            });
            if (t.rest !== undefined && optionals.length > 0) {
                this.emitLine(
                    "if (value.rest.isNotEmpty() && value.",
                    optionals[optionals.length - 1].name,
                    " == null) ",
                    fail(
                        "serialize",
                        "an item follows a missing optional item",
                    ),
                );
            }

            const size: string[] = [required.length.toString()];
            for (const p of optionals) {
                size.push(`(if (value.${p.name} != null) 1 else 0)`);
            }

            if (t.rest !== undefined) size.push("value.rest.size");
            this.emitBlock(
                [
                    "encoder.encodeCollection(descriptor, ",
                    size.join(" + "),
                    ")",
                ],
                () => {
                    properties.forEach((p, i) => {
                        const encode = (value: string): Sourcelike => [
                            "encodeSerializableElement(descriptor, ",
                            i.toString(),
                            ", ",
                            serializer(p),
                            ", ",
                            value,
                            ")",
                        ];
                        switch (p.kind) {
                            case "required":
                                this.emitLine(encode(`value.${p.name}`));
                                break;
                            case "optional":
                                this.emitLine(
                                    "value.",
                                    p.name,
                                    "?.let { ",
                                    encode("it"),
                                    " }",
                                );
                                break;
                            case "optional-nullable":
                                this.emitLine(
                                    "value.",
                                    p.name,
                                    "?.let { ",
                                    encode("it.value"),
                                    " }",
                                );
                                break;
                            case "rest":
                                this.emitLine(
                                    "value.rest.forEachIndexed { i, item -> encodeSerializableElement(descriptor, ",
                                    i.toString(),
                                    " + i, ",
                                    serializer(p),
                                    ", item) }",
                                );
                                break;
                        }
                    });
                },
            );
        };

        this.emitBlock(")", () => {
            if (this.emitTupleHolders(t, tupleName)) this.ensureBlankLine();
            this.emitBlock(
                ["object Serializer : KSerializer<", tupleName, ">"],
                () => {
                    this.emitLine(
                        "@OptIn(ExperimentalSerializationApi::class)",
                    );
                    this.emitLine(
                        "override val descriptor: SerialDescriptor = listSerialDescriptor(JsonElement.serializer().descriptor)",
                    );
                    this.ensureBlankLine();
                    this.emitBlock(
                        [
                            "override fun deserialize(decoder: Decoder): ",
                            tupleName,
                            " = decoder.decodeStructure(descriptor)",
                        ],
                        emitDeserialize,
                    );
                    this.ensureBlankLine();
                    this.emitBlock(
                        [
                            "override fun serialize(encoder: Encoder, value: ",
                            tupleName,
                            ")",
                        ],
                        emitSerialize,
                    );
                },
            );
        });
    }

    protected emitSourceStructure(): void {
        super.emitSourceStructure();

        for (const serializer of this.usedDateTimeSerializers()) {
            this.ensureBlankLine();
            this.emitMultiline(`object ${serializer.name} : KSerializer<${serializer.type}> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("${serializer.type}", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): ${serializer.type} = ${serializer.type}.parse(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: ${serializer.type}) {
        encoder.encodeString(java.time.format.DateTimeFormatter.${serializer.formatter}.format(value))
    }
}`);
        }
    }

    protected emitClassAnnotations(_c: Type, _className: Name): void {
        this.emitLine("@Serializable");
    }

    protected renameAttribute(
        name: Name,
        jsonName: string,
        _required: boolean,
        meta: Array<() => void>,
    ): void {
        const rename = this._rename(name, jsonName);
        if (rename !== undefined) {
            meta.push(() => this.emitLine(rename));
        }
    }

    private _rename(propName: Name, jsonName: string): Sourcelike | undefined {
        const escapedName = stringEscape(jsonName);
        const namesDiffer = this.sourcelikeToString(propName) !== escapedName;
        if (namesDiffer) {
            return ['@SerialName("', escapedName, '")'];
        }

        return undefined;
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));

        this.emitLine(["@Serializable"]);
        this.emitBlock(["enum class ", enumName, "(val value: String)"], () => {
            let count = e.cases.size;
            this.forEachEnumCase(e, "none", (name, json) => {
                const jsonEnum = stringEscape(json);
                this.emitLine(
                    `@SerialName("${jsonEnum}") `,
                    name,
                    `("${jsonEnum}")`,
                    --count === 0 ? ";" : ",",
                );
            });
        });
    }
}
