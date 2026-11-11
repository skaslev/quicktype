import { arraySortByInto, iterableSome } from "collection-utils";

import type { Name } from "../../Naming.js";
import type { Sourcelike } from "../../Source.js";
import { assertNever, panic } from "../../support/Support.js";
import {
    ArrayType,
    type ClassProperty,
    ClassType,
    EnumType,
    TupleType,
    type Type,
    type TypeKind,
    UnionType,
} from "../../Type/index.js";
import {
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";

import { JavaRenderer } from "./JavaRenderer.js";
import { stringEscape } from "./utils.js";

function elements(n: number): string {
    return n === 1 ? "1 element" : `${n} elements`;
}

// What a tuple's JSON array must look like, for error messages.
function expectedTupleLength(t: TupleType): string {
    const min = t.minItems;
    const max = t.items.length;
    if (t.rest !== undefined) {
        return min === 0 ? "an array" : `an array of at least ${elements(min)}`;
    }

    if (min === max) return `an array of ${elements(max)}`;
    return min === 0
        ? `an array of at most ${elements(max)}`
        : `an array of ${min} to ${max} elements`;
}

// The order in which a union tries its array-like members on a JSON array:
// those that take fewer lengths first, i.e. fixed-length tuples, tuples
// with optional items, tuples with a rest, and the array last.
function arrayMemberPriority(t: Type): number {
    if (!(t instanceof TupleType)) return Number.POSITIVE_INFINITY;
    if (t.rest !== undefined) return Number.MAX_SAFE_INTEGER;
    return t.items.length - t.minItems;
}

export class JacksonRenderer extends JavaRenderer {
    protected readonly _converterKeywords: string[] = [
        "JsonProperty",
        "JsonSetter",
        "Nulls",
        "JsonDeserialize",
        "JsonDeserializer",
        "JsonSerialize",
        "JsonSerializer",
        "JsonParser",
        "JsonProcessingException",
        "ObjectMapper",
        "ObjectReader",
        "ObjectWriter",
        "DeserializationFeature",
        "SerializationFeature",
        "DeserializationContext",
        "SerializerProvider",
        "None",
        "JsonToken",
        "TreeNode",
    ];

    /**
     * `parser.readValueAs(...)` for a value of type `t`.  Generic types are
     * read with a `TypeReference`, which keeps their type arguments, and an
     * explicit type argument, so that the call can be an argument itself:
     * Java before 8 infers it only from an assignment.
     */
    private readValueAs(parser: Sourcelike, t: Type): Sourcelike {
        const rendered = this.javaType(true, t);
        if (this.sourcelikeToString(rendered).includes("<")) {
            return [
                parser,
                ".<",
                rendered,
                ">readValueAs(new TypeReference<",
                rendered,
                ">() {})",
            ];
        }

        return [
            parser,
            ".readValueAs(",
            this.javaTypeWithoutGenerics(true, t),
            ".class)",
        ];
    }

    private mapperType(t: Type): Sourcelike {
        if (this._options.useList && t instanceof ArrayType) {
            return ["new TypeReference<", this.javaType(false, t), ">() {}"];
        }
        return [this.javaTypeWithoutGenerics(false, t), ".class"];
    }

    protected emitClassAttributes(c: ClassType, _className: Name): void {
        if (c.getProperties().size === 0)
            this.emitLine(
                "@JsonAutoDetect(fieldVisibility=JsonAutoDetect.Visibility.NONE)",
            );

        super.emitClassAttributes(c, _className);
    }

    protected annotationsForAccessor(
        _c: ClassType,
        _className: Name,
        _propertyName: Name,
        jsonName: string,
        p: ClassProperty,
        _isSetter: boolean,
    ): string[] {
        const superAnnotations = super.annotationsForAccessor(
            _c,
            _className,
            _propertyName,
            jsonName,
            p,
            _isSetter,
        );

        const annotations: string[] = [
            `@JsonProperty("${stringEscape(jsonName)}")`,
        ];

        if (_isSetter && p.type.kind === "date-time") {
            annotations.push("@JsonSetter(nulls = Nulls.FAIL)");
        }

        const propertyType =
            p.type instanceof UnionType
                ? (nullableFromUnion(p.type) ?? p.type)
                : p.type;

        switch (propertyType.kind) {
            case "date-time":
                this._dateTimeProvider.dateTimeJacksonAnnotations.forEach(
                    (annotation) => {
                        annotations.push(annotation);
                    },
                );
                break;
            case "date":
                this._dateTimeProvider.dateJacksonAnnotations.forEach(
                    (annotation) => {
                        annotations.push(annotation);
                    },
                );
                break;
            case "time":
                this._dateTimeProvider.timeJacksonAnnotations.forEach(
                    (annotation) => {
                        annotations.push(annotation);
                    },
                );
                break;
            default:
                break;
        }

        return [...superAnnotations, ...annotations];
    }

    protected importsForType(t: ClassType | UnionType | EnumType): string[] {
        if (t instanceof ClassType) {
            const imports = super.importsForType(t);
            imports.push("com.fasterxml.jackson.annotation.*");
            return imports;
        }

        if (t instanceof UnionType) {
            const imports = super.importsForType(t);
            imports.push(
                "java.io.IOException",
                "com.fasterxml.jackson.core.*",
                "com.fasterxml.jackson.databind.*",
                "com.fasterxml.jackson.databind.annotation.*",
            );
            if (this._options.useList) {
                imports.push("com.fasterxml.jackson.core.type.*");
            }

            return imports;
        }

        if (t instanceof EnumType) {
            const imports = super.importsForType(t);
            imports.push("com.fasterxml.jackson.annotation.*");
            return imports;
        }

        return assertNever(t);
    }

    protected importsForTupleDefinition(t: TupleType): string[] {
        const imports = [
            "java.io.IOException",
            "com.fasterxml.jackson.core.*",
            "com.fasterxml.jackson.databind.*",
            "com.fasterxml.jackson.databind.annotation.*",
        ];
        const needsTypeReference = Array.from(t.getNonAttributeChildren()).some(
            (item) =>
                this.sourcelikeToString(this.javaType(true, item)).includes(
                    "<",
                ),
        );
        if (needsTypeReference) {
            imports.push("com.fasterxml.jackson.core.type.*");
        }

        return [...imports, ...super.importsForTupleDefinition(t)];
    }

    protected emitTupleAttributes(t: TupleType, tupleName: Name): void {
        this.emitLine(
            "@JsonDeserialize(using = ",
            tupleName,
            ".Deserializer.class)",
        );
        this.emitLine(
            "@JsonSerialize(using = ",
            tupleName,
            ".Serializer.class)",
        );
        super.emitTupleAttributes(t, tupleName);
    }

    // Jackson reads and writes a tuple's class as a JSON array.  Its
    // `@JsonFormat(shape = ARRAY)` doesn't check the array's length (missing
    // items stay null, extra ones are skipped, since the mapper doesn't
    // fail on unknown properties), writes missing optional items as nulls
    // and has no rest, so the class has its own (de)serializer.
    protected emitTupleSerializer(t: TupleType, tupleName: Name): void {
        const fields = this.tupleFields(t);
        const fail = (verb: string, message: string): Sourcelike => [
            `throw new IOException("Cannot ${verb} `,
            tupleName,
            `: ${message}");`,
        ];
        const failLength = fail(
            "deserialize",
            `expected ${expectedTupleLength(t)}`,
        );

        // Reads the value at the current token, which is the item's first
        // one, then moves to the next item.  The token must be one the
        // item's type starts with: Jackson would also read a number into a
        // String, say, and a union trying its tuples in turn would then take
        // the wrong one.
        const emitRead = (
            type: Type,
            what: string,
            assign: (read: Sourcelike) => Sourcelike,
        ): void => {
            const tokens = this.jsonTokensForType(type);
            if (tokens !== undefined) {
                this.emitBlock(
                    [
                        "if (",
                        tokens === "not-null"
                            ? "token == JsonToken.VALUE_NULL"
                            : tokens
                                  .map((token) => `token != JsonToken.${token}`)
                                  .join(" && "),
                        ")",
                    ],
                    () =>
                        this.emitLine(
                            'throw new IOException("Cannot deserialize ',
                            tupleName,
                            ': unexpected " + token + " for ',
                            what,
                            '");',
                        ),
                );
            }

            this.emitLine(assign(this.readValueAs("jsonParser", type)), ";");
            this.emitLine("token = jsonParser.nextToken();");
        };

        const emitDeserialize = (): void => {
            this.emitBlock(
                "if (jsonParser.currentToken() != JsonToken.START_ARRAY)",
                () => this.emitLine(failLength),
            );
            this.emitLine(tupleName, " value = new ", tupleName, "();");
            this.emitLine("JsonToken token = jsonParser.nextToken();");
            for (const field of fields) {
                switch (field.kind) {
                    case "required":
                        this.emitBlock(
                            "if (token == JsonToken.END_ARRAY)",
                            () => this.emitLine(failLength),
                        );
                        emitRead(field.type, field.name, (read) => [
                            "value.",
                            field.name,
                            " = ",
                            read,
                        ]);
                        break;
                    case "optional":
                    case "optional-nullable":
                        this.emitBlock(
                            "if (token != JsonToken.END_ARRAY)",
                            () =>
                                emitRead(field.type, field.name, (read) => [
                                    "value.",
                                    field.name,
                                    " = ",
                                    field.kind === "optional"
                                        ? read
                                        : [
                                              "java.util.Optional.ofNullable(",
                                              read,
                                              ")",
                                          ],
                                ]),
                        );
                        break;
                    case "rest": {
                        const elementType = this.javaType(true, field.type);
                        const list = this._options.useList
                            ? "value.rest"
                            : "rest";
                        this.emitLine(
                            this._options.useList
                                ? "value.rest"
                                : ["java.util.List<", elementType, "> rest"],
                            " = new java.util.ArrayList<",
                            elementType,
                            ">();",
                        );
                        this.emitBlock(
                            "while (token != JsonToken.END_ARRAY)",
                            () =>
                                emitRead(
                                    field.type,
                                    "an item of the rest",
                                    (read) => [list, ".add(", read, ")"],
                                ),
                        );
                        if (!this._options.useList) {
                            this.emitLine(
                                "value.rest = ",
                                this.newArray(field.type, "rest.size()"),
                                ";",
                            );
                            this.emitBlock(
                                "for (int i = 0; i < rest.size(); i++)",
                                () =>
                                    this.emitLine(
                                        "value.rest[i] = rest.get(i);",
                                    ),
                            );
                        }
                        break;
                    }
                }
            }

            if (t.rest === undefined) {
                this.emitBlock("if (token != JsonToken.END_ARRAY)", () =>
                    this.emitLine(failLength),
                );
            }

            this.emitLine("return value;");
        };

        // The required items, the optional ones that are present, then the
        // rest.  An item can't follow a missing one in JSON, so such a value
        // is an error rather than written with the later items moved into
        // the gap, or with nulls in it.
        const emitSerialize = (): void => {
            const gap = fail(
                "serialize",
                "an item follows a missing optional item",
            );
            this.emitLine("jsonGenerator.writeStartArray();");
            let previousOptional: string | undefined;
            for (const field of fields) {
                switch (field.kind) {
                    case "required":
                        this.emitLine(
                            "jsonGenerator.writeObject(obj.",
                            field.name,
                            ");",
                        );
                        break;
                    case "optional":
                    case "optional-nullable":
                        this.emitBlock(
                            ["if (obj.", field.name, " != null)"],
                            () => {
                                if (previousOptional !== undefined) {
                                    this.emitBlock(
                                        [
                                            "if (obj.",
                                            previousOptional,
                                            " == null)",
                                        ],
                                        () => this.emitLine(gap),
                                    );
                                }

                                this.emitLine(
                                    "jsonGenerator.writeObject(obj.",
                                    field.name,
                                    field.kind === "optional"
                                        ? ""
                                        : ".orElse(null)",
                                    ");",
                                );
                            },
                        );
                        previousOptional = field.name;
                        break;
                    case "rest":
                        this.emitBlock("if (obj.rest != null)", () => {
                            if (previousOptional !== undefined) {
                                const isNotEmpty = this._options.useList
                                    ? "!obj.rest.isEmpty()"
                                    : "obj.rest.length > 0";
                                this.emitBlock(
                                    [
                                        "if (",
                                        isNotEmpty,
                                        " && obj.",
                                        previousOptional,
                                        " == null)",
                                    ],
                                    () => this.emitLine(gap),
                                );
                            }

                            const elementType = this._options.useList
                                ? this.javaType(true, field.type)
                                : this.javaType(false, field.type);
                            this.emitBlock(
                                ["for (", elementType, " item : obj.rest)"],
                                () =>
                                    this.emitLine(
                                        "jsonGenerator.writeObject(item);",
                                    ),
                            );
                        });
                        break;
                }
            }

            this.emitLine("jsonGenerator.writeEndArray();");
        };

        this.ensureBlankLine();
        this.emitBlock(
            [
                "static class Deserializer extends JsonDeserializer<",
                tupleName,
                ">",
            ],
            () => {
                this.emitLine("@Override");
                this.emitBlock(
                    [
                        "public ",
                        tupleName,
                        " deserialize(JsonParser jsonParser, DeserializationContext deserializationContext) throws IOException, JsonProcessingException",
                    ],
                    emitDeserialize,
                );
            },
        );
        this.ensureBlankLine();
        this.emitBlock(
            ["static class Serializer extends JsonSerializer<", tupleName, ">"],
            () => {
                this.emitLine("@Override");
                this.emitBlock(
                    [
                        "public void serialize(",
                        tupleName,
                        " obj, JsonGenerator jsonGenerator, SerializerProvider serializerProvider) throws IOException",
                    ],
                    emitSerialize,
                );
            },
        );
    }

    /**
     * The JSON tokens a value of type `t` can start with, or undefined for
     * any.  A union checks its value itself, but Jackson doesn't pass it a
     * JSON null, so it only must not be null unless it's nullable.
     */
    private jsonTokensForType(t: Type): string[] | "not-null" | undefined {
        if (t instanceof UnionType) {
            const nullable = nullableFromUnion(t);
            if (nullable !== null) {
                const tokens = this.jsonTokensForType(nullable);
                return Array.isArray(tokens)
                    ? [...tokens, "VALUE_NULL"]
                    : undefined;
            }

            return t.isNullable ? undefined : "not-null";
        }

        switch (t.kind) {
            case "any":
                return undefined;
            case "null":
                return ["VALUE_NULL"];
            case "bool":
                return ["VALUE_TRUE", "VALUE_FALSE"];
            case "integer":
                return ["VALUE_NUMBER_INT"];
            case "double":
                return ["VALUE_NUMBER_INT", "VALUE_NUMBER_FLOAT"];
            case "array":
            case "tuple":
                return ["START_ARRAY"];
            case "class":
            case "map":
                return ["START_OBJECT"];
            default:
                // Strings, enums, dates and times, UUIDs.
                return ["VALUE_STRING"];
        }
    }

    /**
     * `new T[size]` for an array of `t`s, with the size in the first
     * dimension if `t` is an array itself.  The element type is written
     * without its type arguments: Java can't create arrays of generic types.
     */
    private newArray(t: Type, size: string): Sourcelike {
        let dimensions = "";
        let element = t;
        while (element instanceof ArrayType) {
            dimensions += "[]";
            element = element.items;
        }

        return [
            "new ",
            this.javaTypeWithoutGenerics(false, element),
            "[",
            size,
            "]",
            dimensions,
        ];
    }

    protected emitUnionAttributes(_u: UnionType, unionName: Name): void {
        this.emitLine(
            "@JsonDeserialize(using = ",
            unionName,
            ".Deserializer.class)",
        );
        this.emitLine(
            "@JsonSerialize(using = ",
            unionName,
            ".Serializer.class)",
        );
    }

    protected emitUnionSerializer(u: UnionType, unionName: Name): void {
        const stringBasedObjects: TypeKind[] = [
            "uuid",
            "time",
            "date",
            "date-time",
        ];

        const tokenCase = (tokenType: string): void => {
            this.emitLine("case ", tokenType, ":");
        };

        const emitNullDeserializer = (): void => {
            this.indent(() => {
                tokenCase("VALUE_NULL");
                this.indent(() => this.emitLine("break;"));
            });
        };

        const emitDeserializerCodeForStringObjects = (
            fieldName: Sourcelike,
            kind: TypeKind,
            parseFrom: string,
        ): void => {
            switch (kind) {
                case "date":
                    this.emitLine(
                        "value.",
                        fieldName,
                        " = ",
                        this._dateTimeProvider.convertStringToDate(parseFrom),
                        ";",
                    );

                    break;
                case "time":
                    this.emitLine(
                        "value.",
                        fieldName,
                        " = ",
                        this._dateTimeProvider.convertStringToTime(parseFrom),
                        ";",
                    );

                    break;
                case "date-time":
                    this.emitLine(
                        "value.",
                        fieldName,
                        " = ",
                        this._dateTimeProvider.convertStringToDateTime(
                            parseFrom,
                        ),
                        ";",
                    );
                    break;
                case "uuid":
                    this.emitLine(
                        "value.",
                        fieldName,
                        " = UUID.fromString(",
                        parseFrom,
                        ");",
                    );

                    break;
                default:
                    panic("Requested type isnt an object!");
            }
        };

        const emitDeserializeType = (t: Type, variableFieldName = ""): void => {
            const { fieldName } = this.unionField(u, t);
            const rendered = this.javaTypeWithoutGenerics(true, t);
            if (this._options.useList && t instanceof ArrayType) {
                // The TypeReference must carry the full generic type:
                // a raw `TypeReference<List>` would make Jackson accept
                // any element type, so schema-invalid inputs (which the
                // expected-failure fixtures rely on rejecting) would
                // deserialize successfully.
                this.emitLine(
                    "value.",
                    fieldName,
                    " = jsonParser.readValueAs(new TypeReference<",
                    this.javaType(true, t),
                    ">() {});",
                );
            } else if (
                stringBasedObjects.some(
                    (stringBasedTypeKind) => t.kind === stringBasedTypeKind,
                )
            ) {
                emitDeserializerCodeForStringObjects(
                    fieldName,
                    t.kind,
                    variableFieldName,
                );
            } else if (t.kind === "string") {
                this.emitLine(
                    "value.",
                    fieldName,
                    " = ",
                    variableFieldName,
                    ";",
                );
            } else if (t.kind === "enum") {
                const { fieldType } = this.unionField(u, t, true);
                this.emitLine(
                    "value.",
                    fieldName,
                    " = ",
                    fieldType,
                    ".forValue(",
                    variableFieldName,
                    ");",
                );
            } else {
                this.emitLine(
                    "value.",
                    fieldName,
                    " = jsonParser.readValueAs(",
                    rendered,
                    ".class);",
                );
            }
        };

        const emitDeserializer = (
            tokenTypes: string[],
            kind: TypeKind,
        ): void => {
            const t = u.findMember(kind);
            if (t === undefined) return;

            this.indent(() => {
                for (const tokenType of tokenTypes) {
                    tokenCase(tokenType);
                }

                this.indent(() => {
                    emitDeserializeType(t);
                    this.emitLine("break;");
                });
            });
        };

        // A JSON array is the array member or one of the tuples.  With
        // several of them, it's read into a tree, and they're tried in turn
        // on the tree: those that take fewer lengths first.
        const emitArrayDeserializer = (): void => {
            const members = arraySortByInto(
                Array.from(u.members).filter(
                    (m) => m instanceof ArrayType || m instanceof TupleType,
                ),
                arrayMemberPriority,
            );
            if (members.length === 0) return;

            this.indent(() => {
                if (members.length === 1) {
                    tokenCase("START_ARRAY");
                    this.indent(() => {
                        emitDeserializeType(members[0]);
                        this.emitLine("break;");
                    });
                    return;
                }

                this.emitLine("case START_ARRAY: {");
                this.indent(() => {
                    this.emitLine(
                        "TreeNode tree = jsonParser.readValueAsTree();",
                    );
                    members.forEach((m, i) => {
                        const { fieldName } = this.unionField(u, m);
                        const read = (): void => {
                            this.emitLine(
                                "value.",
                                fieldName,
                                " = ",
                                this.readValueAs(
                                    "tree.traverse(jsonParser.getCodec())",
                                    m,
                                ),
                                ";",
                            );
                            this.emitLine("break;");
                        };
                        if (i < members.length - 1) {
                            this.emitIgnoredTryCatchBlock(read);
                        } else {
                            read();
                        }
                    });
                });
                this.emitLine("}");
            });
        };

        const emitStringDeserializer = (): void => {
            const enumType = u.findMember("enum");
            const stringType = u.findMember("string");

            if (
                stringBasedObjects.every(
                    (kind) => u.findMember(kind) === undefined,
                ) &&
                stringType === undefined &&
                enumType === undefined
            )
                return;

            this.indent(() => {
                tokenCase("VALUE_STRING");

                this.indent(() => {
                    const fromVariable = "string";
                    this.emitLine(
                        `String ${fromVariable} = jsonParser.readValueAs(String.class);`,
                    );

                    stringBasedObjects.forEach((kind) => {
                        const type = u.findMember(kind);
                        if (type !== undefined) {
                            this.emitIgnoredTryCatchBlock(() => {
                                emitDeserializeType(type, fromVariable);
                            });
                        }
                    });

                    if (enumType !== undefined) {
                        this.emitIgnoredTryCatchBlock(() => {
                            emitDeserializeType(enumType, fromVariable);
                        });
                    }

                    // String should be the last one if exists, because it cannot fail, unlike the parsers.
                    if (stringType !== undefined) {
                        emitDeserializeType(stringType, fromVariable);
                    }

                    this.emitLine("break;");
                });
            });
        };

        const emitNumberDeserializer = (): void => {
            const integerType = u.findMember("integer");
            const doubleType = u.findMember("double");
            if (doubleType === undefined && integerType === undefined) return;

            this.indent(() => {
                tokenCase("VALUE_NUMBER_INT");
                if (integerType !== undefined) {
                    this.indent(() => {
                        emitDeserializeType(integerType);
                        this.emitLine("break;");
                    });
                }

                if (doubleType !== undefined) {
                    tokenCase("VALUE_NUMBER_FLOAT");
                    this.indent(() => {
                        emitDeserializeType(doubleType);
                        this.emitLine("break;");
                    });
                }
            });
        };

        const customObjectSerializer: TypeKind[] = [
            "time",
            "date",
            "date-time",
        ];

        const serializerCodeForType = (
            type: Type,
            fieldName: Sourcelike,
        ): Sourcelike => {
            switch (type.kind) {
                case "date":
                    return this._dateTimeProvider.convertDateToString(
                        fieldName,
                    );
                case "time":
                    return this._dateTimeProvider.convertTimeToString(
                        fieldName,
                    );
                case "date-time":
                    return this._dateTimeProvider.convertDateTimeToString(
                        fieldName,
                    );
                default:
                    return panic(
                        "Requested type doesn't have custom serializer code!",
                    );
            }
        };

        const emitSerializeType = (t: Type): void => {
            const { fieldName } = this.unionField(u, t, true);

            this.emitBlock(["if (obj.", fieldName, " != null)"], () => {
                if (
                    customObjectSerializer.some(
                        (customSerializerType) =>
                            t.kind === customSerializerType,
                    )
                ) {
                    this.emitLine(
                        "jsonGenerator.writeObject(",
                        serializerCodeForType(t, ["obj.", fieldName]),
                        ");",
                    );
                } else {
                    this.emitLine(
                        "jsonGenerator.writeObject(obj.",
                        fieldName,
                        ");",
                    );
                }

                this.emitLine("return;");
            });
        };

        const [maybeNull, nonNulls] = removeNullFromUnion(u);

        this.ensureBlankLine();
        this.emitBlock(
            [
                "static class Deserializer extends JsonDeserializer<",
                unionName,
                ">",
            ],
            () => {
                this.emitLine("@Override");
                this.emitBlock(
                    [
                        "public ",
                        unionName,
                        " deserialize(JsonParser jsonParser, DeserializationContext deserializationContext) throws IOException, JsonProcessingException",
                    ],
                    () => {
                        this.emitLine(
                            unionName,
                            " value = new ",
                            unionName,
                            "();",
                        );
                        this.emitLine("switch (jsonParser.currentToken()) {");
                        if (maybeNull !== null) emitNullDeserializer();
                        emitNumberDeserializer();
                        emitDeserializer(["VALUE_TRUE", "VALUE_FALSE"], "bool");
                        emitStringDeserializer();
                        emitArrayDeserializer();
                        emitDeserializer(["START_OBJECT"], "class");
                        emitDeserializer(["START_OBJECT"], "map");
                        this.indent(() =>
                            this.emitLine(
                                'default: throw new IOException("Cannot deserialize ',
                                unionName,
                                '");',
                            ),
                        );
                        this.emitLine("}");
                        this.emitLine("return value;");
                    },
                );
            },
        );
        this.ensureBlankLine();
        this.emitBlock(
            ["static class Serializer extends JsonSerializer<", unionName, ">"],
            () => {
                this.emitLine("@Override");
                this.emitBlock(
                    [
                        "public void serialize(",
                        unionName,
                        " obj, JsonGenerator jsonGenerator, SerializerProvider serializerProvider) throws IOException",
                    ],
                    () => {
                        for (const t of nonNulls) {
                            emitSerializeType(t);
                        }

                        if (maybeNull !== null) {
                            this.emitLine("jsonGenerator.writeNull();");
                        } else {
                            this.emitLine(
                                'throw new IOException("',
                                unionName,
                                ' must not be null");',
                            );
                        }
                    },
                );
            },
        );
    }

    protected emitEnumSerializationAttributes(_e: EnumType): void {
        this.emitLine("@JsonValue");
    }

    protected emitEnumDeserializationAttributes(_e: EnumType): void {
        this.emitLine("@JsonCreator");
    }

    protected emitOffsetDateTimeConverterModule(): void {
        this.emitLine("SimpleModule module = new SimpleModule();");

        if (this._dateTimeProvider.shouldEmitDateTimeConverter) {
            this.emitLine(
                "module.addDeserializer(",
                this._dateTimeProvider.dateTimeType,
                ".class, new JsonDeserializer<",
                this._dateTimeProvider.dateTimeType,
                ">() {",
            );
            this.indent(() => {
                this.emitLine("@Override");
                this.emitBlock(
                    [
                        "public ",
                        this._dateTimeProvider.dateTimeType,
                        " deserialize(JsonParser jsonParser, DeserializationContext deserializationContext) ",
                        "throws IOException, JsonProcessingException",
                    ],
                    () => {
                        this.emitLine("String value = jsonParser.getText();");
                        this.emitLine(
                            "return ",
                            this._dateTimeProvider.convertStringToDateTime(
                                "value",
                            ),
                            ";",
                        );
                    },
                );
            });
            this.emitLine("});");
        }

        if (!this._dateTimeProvider.shouldEmitTimeConverter) {
            this.emitLine(
                "module.addDeserializer(",
                this._dateTimeProvider.timeType,
                ".class, new JsonDeserializer<",
                this._dateTimeProvider.timeType,
                ">() {",
            );
            this.indent(() => {
                this.emitLine("@Override");
                this.emitBlock(
                    [
                        "public ",
                        this._dateTimeProvider.timeType,
                        " deserialize(JsonParser jsonParser, DeserializationContext deserializationContext) ",
                        "throws IOException, JsonProcessingException",
                    ],
                    () => {
                        this.emitLine("String value = jsonParser.getText();");
                        this.emitLine(
                            "return ",
                            this._dateTimeProvider.convertStringToTime("value"),
                            ";",
                        );
                    },
                );
            });
            this.emitLine("});");
        }

        if (!this._dateTimeProvider.shouldEmitDateConverter) {
            this.emitLine(
                "module.addDeserializer(",
                this._dateTimeProvider.dateType,
                ".class, new JsonDeserializer<",
                this._dateTimeProvider.dateType,
                ">() {",
            );
            this.indent(() => {
                this.emitLine("@Override");
                this.emitBlock(
                    [
                        "public ",
                        this._dateTimeProvider.dateType,
                        " deserialize(JsonParser jsonParser, DeserializationContext deserializationContext) ",
                        "throws IOException, JsonProcessingException",
                    ],
                    () => {
                        this.emitLine("String value = jsonParser.getText();");
                        this.emitLine(
                            "return ",
                            this._dateTimeProvider.convertStringToDate("value"),
                            ";",
                        );
                    },
                );
            });
            this.emitLine("});");
        }

        this.emitLine("mapper.registerModule(module);");
    }

    protected emitConverterClass(): void {
        this.startFile(this._converterClassname);
        this.emitCommentLines([
            "To use this code, add the following Maven dependency to your project:",
            "",
            this._options.lombok
                ? "    org.projectlombok : lombok : 1.18.2"
                : "",
            "    com.fasterxml.jackson.core     : jackson-databind          : 2.9.0",
            this._options.dateTimeProvider === "java8"
                ? "    com.fasterxml.jackson.datatype : jackson-datatype-jsr310   : 2.9.0"
                : "",
            "",
            "Import this package:",
            "",
        ]);
        this.emitLine(
            "//     import ",
            this._options.packageName,
            ".Converter;",
        );
        this.emitMultiline(`//
// Then you can deserialize a JSON string with
//`);
        this.forEachTopLevel("none", (t, name) => {
            this.emitLine(
                "//     ",
                this.javaType(false, t),
                " data = Converter.",
                this.decoderName(name),
                "(jsonString);",
            );
        });
        this.ensureBlankLine();
        const imports = [
            "java.io.IOException",
            "com.fasterxml.jackson.databind.*",
            "com.fasterxml.jackson.databind.module.SimpleModule",
            "com.fasterxml.jackson.core.JsonParser",
            "com.fasterxml.jackson.core.JsonProcessingException",
            "com.fasterxml.jackson.core.type.TypeReference",
            "java.util.*",
        ].concat(this._dateTimeProvider.converterImports);
        this.emitPackageAndImports(imports);
        this.ensureBlankLine();
        this.emitBlock(["public class Converter"], () => {
            this.emitLine("// Date-time helpers");
            this._dateTimeProvider.emitDateTimeConverters();

            this.emitLine("// Serialize/deserialize helpers");
            this.forEachTopLevel(
                "leading-and-interposing",
                (topLevelType, topLevelName) => {
                    const topLevelTypeRendered = this.javaType(
                        false,
                        topLevelType,
                    );
                    this.emitBlock(
                        [
                            "public static ",
                            topLevelTypeRendered,
                            " ",
                            this.decoderName(topLevelName),
                            "(String json) throws IOException",
                        ],
                        () => {
                            this.emitLine(
                                "return ",
                                this.readerGetterName(topLevelName),
                                "().readValue(json);",
                            );
                        },
                    );
                    this.ensureBlankLine();
                    this.emitBlock(
                        [
                            "public static String ",
                            this.encoderName(topLevelName),
                            "(",
                            topLevelTypeRendered,
                            " obj) throws JsonProcessingException",
                        ],
                        () => {
                            this.emitLine(
                                "return ",
                                this.writerGetterName(topLevelName),
                                "().writeValueAsString(obj);",
                            );
                        },
                    );
                },
            );
            this.forEachTopLevel(
                "leading-and-interposing",
                (topLevelType, topLevelName) => {
                    const readerName = this.fieldOrMethodName(
                        "reader",
                        topLevelName,
                    );
                    const writerName = this.fieldOrMethodName(
                        "writer",
                        topLevelName,
                    );
                    this.emitLine(
                        "private static ObjectReader ",
                        readerName,
                        ";",
                    );
                    this.emitLine(
                        "private static ObjectWriter ",
                        writerName,
                        ";",
                    );
                    this.ensureBlankLine();
                    this.emitBlock(
                        [
                            "private static void ",
                            this.methodName(
                                "instantiate",
                                "Mapper",
                                topLevelName,
                            ),
                            "()",
                        ],
                        () => {
                            const renderedForMapper =
                                this.mapperType(topLevelType);
                            this.emitLine(
                                "ObjectMapper mapper = new ObjectMapper();",
                            );
                            this.emitLine("mapper.findAndRegisterModules();");
                            this.emitLine(
                                "mapper.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);",
                            );
                            if (
                                iterableSome(
                                    this.typeGraph.allTypesUnordered(),
                                    (t) => t.kind === "integer",
                                )
                            ) {
                                this.emitLine(
                                    "mapper.configure(DeserializationFeature.ACCEPT_FLOAT_AS_INT, false);",
                                );
                            }
                            this.emitLine(
                                "mapper.configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false);",
                            );
                            this.emitOffsetDateTimeConverterModule();
                            this.emitLine(
                                readerName,
                                " = mapper.readerFor(",
                                renderedForMapper,
                                ");",
                            );
                            this.emitLine(
                                writerName,
                                " = mapper.writerFor(",
                                renderedForMapper,
                                ");",
                            );
                        },
                    );
                    this.ensureBlankLine();
                    this.emitBlock(
                        [
                            "private static ObjectReader ",
                            this.readerGetterName(topLevelName),
                            "()",
                        ],
                        () => {
                            this.emitLine(
                                "if (",
                                readerName,
                                " == null) ",
                                this.methodName(
                                    "instantiate",
                                    "Mapper",
                                    topLevelName,
                                ),
                                "();",
                            );
                            this.emitLine("return ", readerName, ";");
                        },
                    );
                    this.ensureBlankLine();
                    this.emitBlock(
                        [
                            "private static ObjectWriter ",
                            this.writerGetterName(topLevelName),
                            "()",
                        ],
                        () => {
                            this.emitLine(
                                "if (",
                                writerName,
                                " == null) ",
                                this.methodName(
                                    "instantiate",
                                    "Mapper",
                                    topLevelName,
                                ),
                                "();",
                            );
                            this.emitLine("return ", writerName, ";");
                        },
                    );
                },
            );
        });
        this.finishFile();
    }

    protected emitSourceStructure(): void {
        this.emitConverterClass();
        super.emitSourceStructure();
    }
}
