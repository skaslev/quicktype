// C# keeps every tuple shape: a tuple is a class with a property per item,
// and with System.Text.Json and Json.NET a converter reads and writes it as
// a JSON array.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: "csharp",
        rendererOptions,
    });
    return result.lines.join("\n");
}

function withProperties(properties: Record<string, object>): object {
    return {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
    };
}

const justTypes = { "just-types": true };
const newtonsoft = { framework: "NewtonSoft" };

// ZRANGE WITHSCORES: `[member, score]`.
const memberScore = {
    title: "MemberScore",
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
};

// CLUSTER SLOTS: `[start, end, master, ...replicas]`.
const slotRange = {
    title: "SlotRange",
    type: "array",
    minItems: 3,
    items: [{ type: "integer" }, { type: "integer" }, { type: "string" }],
    additionalItems: { type: "string" },
};

// GEOSEARCH WITH*: a name, then up to two of distance and hash.
const geoResult = {
    title: "GeoResult",
    type: "array",
    minItems: 1,
    maxItems: 3,
    items: [{ type: "string" }],
    additionalItems: { type: "integer" },
};

// An optional item that can be null: missing and null are different.
const nullableOptional = {
    title: "Row",
    type: "array",
    minItems: 1,
    prefixItems: [{ type: "integer" }, { type: ["string", "null"] }],
};

describe("tuple classes", () => {
    test("a fixed-length tuple has a property per item", async () => {
        const output = await renderSchema(
            withProperties({ pairs: { type: "array", items: memberScore } }),
            justTypes,
        );
        expect(output).toContain("public MemberScore[] Pairs { get; set; }");
        expect(output).toContain(
            [
                "    public partial class MemberScore",
                "    {",
                "        public string Item1 { get; set; }",
                "        public double Item2 { get; set; }",
                "    }",
            ].join("\n"),
        );
    });

    test("optional items are nullable, the rest is an array", async () => {
        const output = await renderSchema(
            withProperties({ slots: slotRange, geo: geoResult }),
            justTypes,
        );
        expect(output).toContain(
            [
                "    public partial class SlotRange",
                "    {",
                "        public long Item1 { get; set; }",
                "        public long Item2 { get; set; }",
                "        public string Item3 { get; set; }",
                "        public string[] Rest { get; set; }",
                "    }",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "        public string Item1 { get; set; }",
                "        public long? Item2 { get; set; }",
                "        public long? Item3 { get; set; }",
            ].join("\n"),
        );
    });

    test("an optional item that can be null tells null from missing", async () => {
        const output = await renderSchema(
            withProperties({ row: nullableOptional }),
            justTypes,
        );
        expect(output).toContain(
            [
                "        public long Item1 { get; set; }",
                "        public string? Item2 { get; set; }",
                "        public bool HasItem2 { get; set; }",
            ].join("\n"),
        );
    });

    test("untitled tuples are named like classes", async () => {
        const output = await renderSchema(
            withProperties({
                entries: {
                    type: "array",
                    items: {
                        type: "array",
                        items: [{ type: "string" }, { type: "integer" }],
                    },
                },
            }),
            justTypes,
        );
        expect(output).toContain("public Entry[] Entries { get; set; }");
        expect(output).toContain("public partial class Entry");
    });

    test("a recursive tuple refers to its class", async () => {
        // COMMAND INFO: a command's last item are its subcommands.
        const output = await renderSchema(
            {
                ...withProperties({
                    commands: {
                        type: "array",
                        items: { $ref: "#/$defs/command" },
                    },
                }),
                $defs: {
                    command: {
                        title: "Command",
                        type: "array",
                        minItems: 1,
                        items: [
                            { type: "string" },
                            {
                                type: "array",
                                items: { $ref: "#/$defs/command" },
                            },
                        ],
                    },
                },
            },
            justTypes,
        );
        expect(output).toContain("public Command[]? Item2 { get; set; }");
    });

    test("a member can't have its class's name", async () => {
        const output = await renderSchema(
            withProperties({
                rest: { ...slotRange, title: "Rest" },
                item1: withProperties({ a: { type: "string" } }),
            }),
            justTypes,
        );
        expect(output).toContain("public Item1Class Item1 { get; set; }");
        expect(output).toContain("public RestTuple Rest { get; set; }");
        expect(output).toContain("public string[] Rest { get; set; }");
    });

    test("renderer options apply to tuple classes", async () => {
        const output = await renderSchema(
            withProperties({ slots: slotRange }),
            {
                ...justTypes,
                "array-type": "list",
                "use-records": true,
                virtual: true,
            },
        );
        expect(output).toContain("public partial record SlotRange");
        expect(output).toContain(
            "public virtual List<string> Rest { get; set; }",
        );
        expect(output).toContain("using System.Collections.Generic;");
    });
});

describe("System.Text.Json", () => {
    test("tuple converters are registered", async () => {
        const output = await renderSchema(
            withProperties({ pair: memberScore }),
        );
        // A tuple's class, not the union of its items.
        expect(output).toContain("public MemberScore Pair { get; set; }");
        expect(output).toContain(
            "                MemberScoreConverter.Singleton,",
        );
        expect(output).toContain(
            "internal class MemberScoreConverter : JsonConverter<MemberScore>",
        );
    });

    test("a fixed-length tuple is read and written item by item", async () => {
        const output = await renderSchema(
            withProperties({ pair: memberScore }),
        );
        expect(output).toContain(
            [
                "            var value = new MemberScore();",
                "            reader.Read();",
                "            if (reader.TokenType == JsonTokenType.EndArray || reader.TokenType == JsonTokenType.Null)",
                "            {",
                '                throw new JsonException("Cannot unmarshal type MemberScore");',
                "            }",
                "            value.Item1 = JsonSerializer.Deserialize<string>(ref reader, options)!;",
                "            reader.Read();",
                "            if (reader.TokenType == JsonTokenType.EndArray)",
                "            {",
                '                throw new JsonException("Cannot unmarshal type MemberScore");',
                "            }",
                "            value.Item2 = JsonSerializer.Deserialize<double>(ref reader, options);",
                "            reader.Read();",
                "            if (reader.TokenType != JsonTokenType.EndArray)",
                "            {",
                '                throw new JsonException("Cannot unmarshal type MemberScore");',
                "            }",
                "",
                "            return value;",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "            writer.WriteStartArray();",
                "            JsonSerializer.Serialize(writer, value.Item1, options);",
                "            JsonSerializer.Serialize(writer, value.Item2, options);",
                "            writer.WriteEndArray();",
            ].join("\n"),
        );
    });

    test("optional items are read while there are elements", async () => {
        const output = await renderSchema(
            withProperties({ row: nullableOptional }),
        );
        expect(output).toContain(
            [
                "            if (reader.TokenType != JsonTokenType.EndArray)",
                "            {",
                "                value.Item2 = JsonSerializer.Deserialize<string?>(ref reader, options);",
                "                value.HasItem2 = true;",
                "                reader.Read();",
                "            }",
            ].join("\n"),
        );
        expect(output).toContain(
            "var length = (value.HasItem2 || value.Item2 != null) ? 2 : 1;",
        );
    });

    test("optional items are written up to the last one present", async () => {
        const output = await renderSchema(withProperties({ geo: geoResult }));
        expect(output).toContain(
            [
                "            var length = value.Item3 != null ? 3 : value.Item2 != null ? 2 : 1;",
                "            writer.WriteStartArray();",
                "            JsonSerializer.Serialize(writer, value.Item1, options);",
                "            if (length > 1)",
                "            {",
                "                if (value.Item2 == null)",
                "                {",
                '                    throw new NotSupportedException("Cannot marshal type GeoResult");',
                "                }",
                "                JsonSerializer.Serialize(writer, value.Item2, options);",
                "            }",
            ].join("\n"),
        );
    });

    test("the rest is collected and written after the items", async () => {
        const output = await renderSchema(withProperties({ slots: slotRange }));
        expect(output).toContain(
            [
                "            var rest = new List<string>();",
                "            while (reader.TokenType != JsonTokenType.EndArray)",
                "            {",
                "                if (reader.TokenType == JsonTokenType.Null)",
                "                {",
                '                    throw new JsonException("Cannot unmarshal type SlotRange");',
                "                }",
                "                rest.Add(JsonSerializer.Deserialize<string>(ref reader, options)!);",
                "                reader.Read();",
                "            }",
                "            value.Rest = rest.ToArray();",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "            if (value.Rest != null)",
                "            {",
                "                foreach (var item in value.Rest)",
                "                {",
                "                    JsonSerializer.Serialize(writer, item, options);",
                "                }",
                "            }",
            ].join("\n"),
        );
    });

    test("items with converters use them", async () => {
        const output = await renderSchema(
            withProperties({
                t: {
                    type: "array",
                    items: [
                        { type: "integer", minimum: 0 },
                        { type: "string", format: "integer" },
                    ],
                },
            }),
        );
        expect(output).toContain(
            "value.Item1 = MinMaxValueCheckConverter.Singleton.Read(ref reader, typeof(long), options);",
        );
        expect(output).toContain(
            "value.Item2 = ParseStringConverter.Singleton.Read(ref reader, typeof(long), options);",
        );
        expect(output).toContain(
            "ParseStringConverter.Singleton.Write(writer, value.Item2, options);",
        );
    });

    test("a nullable item's converter is for the non-null type", async () => {
        // `typeof(string?)` doesn't compile.
        const output = await renderSchema(
            withProperties({
                t: {
                    type: "array",
                    items: [{ type: ["string", "null"], maxLength: 3 }],
                },
            }),
        );
        expect(output).toContain(
            "value.Item1 = reader.TokenType == JsonTokenType.Null ? null : (string?)MinMaxLengthCheckConverter.Singleton.Read(ref reader, typeof(string), options);",
        );
    });

    test("a top-level tuple's class has FromJson", async () => {
        const output = await renderSchema(memberScore);
        expect(output).toContain(
            [
                "    public partial class TopLevel",
                "    {",
                "        public static TopLevel FromJson(string json) => global::System.Text.Json.JsonSerializer.Deserialize<TopLevel>(json, QuickType.Converter.Settings);",
            ].join("\n"),
        );
    });

    test("attributes-only output has the converters", async () => {
        const output = await renderSchema(
            withProperties({ pair: memberScore }),
            {
                features: "attributes-only",
            },
        );
        expect(output).toContain("public MemberScore Pair { get; set; }");
        expect(output).toContain("MemberScoreConverter.Singleton,");
        expect(output).toContain(
            "if (reader.TokenType != JsonTokenType.StartArray)",
        );
        expect(output).not.toContain("FromJson");
    });

    test("just-types output has no converters", async () => {
        const output = await renderSchema(
            withProperties({ pair: memberScore }),
            justTypes,
        );
        expect(output).toContain("public partial class MemberScore");
        expect(output).not.toContain("Converter");
    });
});

describe("Json.NET", () => {
    test("items are checked for their JSON token", async () => {
        // Json.NET would convert e.g. a number to a string.
        const output = await renderSchema(
            withProperties({ pair: memberScore }),
            newtonsoft,
        );
        expect(output).toContain(
            "internal class MemberScoreConverter : JsonConverter",
        );
        expect(output).toContain(
            "                MemberScoreConverter.Singleton,",
        );
        expect(output).toContain(
            [
                "            if (reader.TokenType == JsonToken.EndArray || (reader.TokenType != JsonToken.String && reader.TokenType != JsonToken.Date))",
                "            {",
                '                throw new Exception("Cannot unmarshal type MemberScore");',
                "            }",
                "            value.Item1 = serializer.Deserialize<string>(reader);",
                "            reader.Read();",
                "            if (reader.TokenType == JsonToken.EndArray || (reader.TokenType != JsonToken.Integer && reader.TokenType != JsonToken.Float))",
            ].join("\n"),
        );
    });

    test("tuples are written as arrays", async () => {
        const output = await renderSchema(
            withProperties({ slots: slotRange }),
            newtonsoft,
        );
        expect(output).toContain(
            [
                "            var value = (SlotRange)untypedValue;",
                "            writer.WriteStartArray();",
                "            serializer.Serialize(writer, value.Item1);",
                "            serializer.Serialize(writer, value.Item2);",
                "            serializer.Serialize(writer, value.Item3);",
                "            if (value.Rest != null)",
            ].join("\n"),
        );
    });

    test("C# 5 output has no expression-bodied members", async () => {
        const output = await renderSchema(
            withProperties({ pair: memberScore }),
            { ...newtonsoft, "csharp-version": "5" },
        );
        expect(output).toContain(
            [
                "        public override bool CanConvert(Type t)",
                "        {",
                "            return t == typeof(MemberScore);",
                "        }",
            ].join("\n"),
        );
    });
});

describe("tuples in unions", () => {
    // XPENDING: a summary tuple, or an array of pending entries.
    const pending = {
        oneOf: [
            {
                type: "array",
                items: [
                    { type: "integer" },
                    { type: ["string", "null"] },
                    { type: ["string", "null"] },
                ],
            },
            {
                type: "array",
                items: {
                    title: "PendingEntry",
                    type: "array",
                    items: [{ type: "string" }, { type: "integer" }],
                },
            },
        ],
    };

    // ZRANK WITHSCORE: a rank and a score, a rank, or null.
    const rank = {
        oneOf: [
            { type: "null" },
            { type: "integer" },
            {
                title: "RankScore",
                type: "array",
                items: [{ type: "integer" }, { type: "number" }],
            },
        ],
    };

    test("members are named after the tuple's class", async () => {
        const output = await renderSchema(withProperties({ rank }), justTypes);
        expect(output).toContain("public RankScore? RankScore;");
        expect(output).toContain(
            "public bool IsNull => Integer == null && RankScore == null;",
        );
    });

    test("System.Text.Json tries a tuple, then reads the array again", async () => {
        const output = await renderSchema(withProperties({ pending }));
        expect(output).toContain(
            [
                "                case JsonTokenType.StartArray:",
                "                    {",
                "                        var arrayStart = reader;",
                "                        try",
                "                        {",
                "                            var arrayValue = JsonSerializer.Deserialize<PendingTuple>(ref reader, options);",
                "                            return new PendingUnion { PendingTuple = arrayValue };",
                "                        }",
                "                        catch (Exception e) when (e is JsonException || e is FormatException)",
                "                        {",
                "                            reader = arrayStart;",
                "                        }",
                "                    }",
                "                    {",
                "                        var arrayValue = JsonSerializer.Deserialize<PendingEntry[]>(ref reader, options);",
                "                        return new PendingUnion { PendingEntryArray = arrayValue };",
                "                    }",
            ].join("\n"),
        );
    });

    test("Json.NET converts the array's token to each member in turn", async () => {
        const output = await renderSchema(
            withProperties({ pending }),
            newtonsoft,
        );
        expect(output).toContain(
            [
                "                case JsonToken.StartArray:",
                "                    {",
                "                        var arrayToken = Newtonsoft.Json.Linq.JToken.ReadFrom(reader);",
                "                        try",
                "                        {",
                "                            var arrayValue = arrayToken.ToObject<PendingTuple>(serializer);",
                "                            return new PendingUnion { PendingTuple = arrayValue };",
                "                        }",
                "                        catch (Exception)",
                "                        {",
                "                        }",
                "                        {",
                "                            var arrayValue = arrayToken.ToObject<PendingEntry[]>(serializer);",
                "                            return new PendingUnion { PendingEntryArray = arrayValue };",
                "                        }",
                "                    }",
            ].join("\n"),
        );
    });

    test("a single tuple member is read directly", async () => {
        const output = await renderSchema(withProperties({ rank }));
        expect(output).toContain(
            [
                "                case JsonTokenType.StartArray:",
                "                    var arrayValue = JsonSerializer.Deserialize<RankScore>(ref reader, options);",
                "                    return new Rank { RankScore = arrayValue };",
            ].join("\n"),
        );
    });
});
