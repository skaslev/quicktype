// Java renders a JSON Schema tuple as a class with a field per item, `item0`,
// `item1`, ... after the item's position, and a final `rest` list.  Jackson
// reads and writes it as a JSON array with a hand-written deserializer and
// serializer, which check the array's length and its items' JSON types.

import { InputData, JSONSchemaInput, quicktypeMultiFile } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<Map<string, string>> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktypeMultiFile({
        inputData,
        lang: "java",
        rendererOptions,
    });
    return new Map(
        Array.from(result, ([name, { lines }]) => [name, lines.join("\n")]),
    );
}

async function renderFile(
    schema: object,
    file: string,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const files = await renderSchema(schema, rendererOptions);
    const output = files.get(file);
    if (output === undefined) {
        throw new Error(`No ${file} in ${Array.from(files.keys()).join(", ")}`);
    }

    return output;
}

const justTypes = { "just-types": true };

// Java declares no type for a reply that isn't an object (it has no type
// aliases), so the reply is a property.
function inObject(property: { $defs?: object }): object {
    const { $defs, ...reply } = property;
    return {
        type: "object",
        properties: { reply },
        required: ["reply"],
        $defs,
    };
}

// ZRANGE WITHSCORES: `[member, score]` pairs.
const memberScores = inObject({
    type: "array",
    items: {
        title: "MemberScore",
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: [{ type: "string" }, { type: "number" }],
    },
});

// CLUSTER SLOTS: `[start, end, master, ...replicas]`.
const slotRanges = inObject({
    type: "array",
    items: {
        title: "SlotRange",
        type: "array",
        minItems: 3,
        items: [
            { type: "integer" },
            { type: "integer" },
            { $ref: "#/$defs/node" },
        ],
        additionalItems: { $ref: "#/$defs/node" },
    },
    $defs: {
        node: {
            title: "SlotNode",
            type: "array",
            items: [{ type: "string" }, { type: "integer" }],
        },
    },
});

const optionalItems = inObject({
    title: "Pending",
    type: "array",
    minItems: 1,
    items: [
        { type: "string" },
        { type: "integer" },
        { type: ["string", "null"] },
    ],
});

// ZRANK WITHSCORE, next to arrays: a JSON array is one of several types.
const arrayLikes = inObject({
    title: "Reply",
    oneOf: [
        { type: "null" },
        { type: "integer" },
        {
            title: "RankScore",
            type: "array",
            items: [{ type: "integer" }, { type: "number" }],
        },
        {
            title: "Named",
            type: "array",
            minItems: 1,
            items: [{ type: "string" }, { type: "integer" }],
        },
        { type: "array", items: { type: "string" } },
    ],
});

// COMMAND INFO: a command's last item are its subcommands.
const commands = inObject({
    type: "array",
    items: { $ref: "#/$defs/command" },
    $defs: {
        command: {
            title: "Command",
            type: "array",
            items: [
                { type: "string" },
                { type: "array", items: { $ref: "#/$defs/command" } },
            ],
        },
    },
});

describe("just types", () => {
    test("a tuple is a class with a field per item", async () => {
        const output = await renderFile(
            memberScores,
            "MemberScore.java",
            justTypes,
        );
        expect(output).toContain(
            [
                "public class MemberScore {",
                "    private String item0;",
                "    private double item1;",
                "",
                "    public String getItem0() { return item0; }",
                "    public void setItem0(String value) { this.item0 = value; }",
                "",
                "    public double getItem1() { return item1; }",
                "    public void setItem1(double value) { this.item1 = value; }",
                "}",
            ].join("\n"),
        );
        // Not a union of its items.
        expect(output).not.toContain("doubleValue");
        expect(
            await renderFile(memberScores, "TopLevel.java", justTypes),
        ).toContain("private List<MemberScore> reply;");
    });

    test("a rest is a final list or array", async () => {
        const output = await renderFile(
            slotRanges,
            "SlotRange.java",
            justTypes,
        );
        expect(output).toContain(
            [
                "    private long item0;",
                "    private long item1;",
                "    private SlotNode item2;",
                "    private List<SlotNode> rest;",
            ].join("\n"),
        );
        expect(output).toContain("import java.util.List;");
        expect(
            await renderFile(slotRanges, "SlotRange.java", {
                ...justTypes,
                "array-type": "array",
            }),
        ).toContain("    private SlotNode[] rest;");
    });

    test("optional items are null when missing", async () => {
        const output = await renderFile(
            optionalItems,
            "Pending.java",
            justTypes,
        );
        // An optional item that can be null is an Optional, so that a
        // missing item (null) and a null one (empty) differ.
        expect(output).toContain(
            [
                "    private String item0;",
                "    private Long item1;",
                "    private java.util.Optional<String> item2;",
            ].join("\n"),
        );
    });

    test("a tuple can contain itself", async () => {
        const output = await renderFile(commands, "Command.java", justTypes);
        expect(output).toContain(
            [
                "    private String item0;",
                "    private List<Command> item1;",
            ].join("\n"),
        );
    });

    test("tuples are members of unions", async () => {
        const output = await renderFile(arrayLikes, "Reply.java", justTypes);
        expect(output).toContain("public RankScore rankScoreValue;");
        expect(output).toContain("public Named namedValue;");
        expect(output).toContain("public List<String> stringArrayValue;");
    });

    test("lombok declares the accessors", async () => {
        const output = await renderFile(memberScores, "MemberScore.java", {
            ...justTypes,
            lombok: true,
        });
        expect(output).toContain(
            "@lombok.Data\npublic class MemberScore {\n    private String item0;\n    private double item1;\n}",
        );
    });

    // The named types in a top-level tuple's items aren't the top-level's
    // type; the tuple is.
    test("a top-level tuple is a class", async () => {
        const object = (name: string): object => ({
            title: name,
            type: "object",
            properties: { x: { type: "integer" } },
        });
        const files = await renderSchema(
            { type: "array", items: [object("A"), object("B")] },
            justTypes,
        );
        expect(files.get("TopLevel.java")).toContain(
            "    private A item0;\n    private B item1;",
        );
        expect(files.has("A.java") && files.has("B.java")).toBe(true);
    });
});

describe("Jackson", () => {
    test("a tuple has its own deserializer and serializer", async () => {
        const output = await renderFile(memberScores, "MemberScore.java");
        expect(output).toContain(
            [
                "@JsonDeserialize(using = MemberScore.Deserializer.class)",
                "@JsonSerialize(using = MemberScore.Serializer.class)",
                "public class MemberScore {",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "            if (jsonParser.currentToken() != JsonToken.START_ARRAY) {",
                '                throw new IOException("Cannot deserialize MemberScore: expected an array of 2 elements");',
                "            }",
                "            MemberScore value = new MemberScore();",
                "            JsonToken token = jsonParser.nextToken();",
                "            if (token == JsonToken.END_ARRAY) {",
                '                throw new IOException("Cannot deserialize MemberScore: expected an array of 2 elements");',
                "            }",
                "            if (token != JsonToken.VALUE_STRING) {",
                '                throw new IOException("Cannot deserialize MemberScore: unexpected " + token + " for item0");',
                "            }",
                "            value.item0 = jsonParser.readValueAs(String.class);",
                "            token = jsonParser.nextToken();",
            ].join("\n"),
        );
        // A number may also be an integer, and extra items are an error.
        expect(output).toContain(
            [
                "            if (token != JsonToken.VALUE_NUMBER_INT && token != JsonToken.VALUE_NUMBER_FLOAT) {",
                '                throw new IOException("Cannot deserialize MemberScore: unexpected " + token + " for item1");',
                "            }",
                "            value.item1 = jsonParser.readValueAs(Double.class);",
                "            token = jsonParser.nextToken();",
                "            if (token != JsonToken.END_ARRAY) {",
                '                throw new IOException("Cannot deserialize MemberScore: expected an array of 2 elements");',
                "            }",
                "            return value;",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "            jsonGenerator.writeStartArray();",
                "            jsonGenerator.writeObject(obj.item0);",
                "            jsonGenerator.writeObject(obj.item1);",
                "            jsonGenerator.writeEndArray();",
            ].join("\n"),
        );
    });

    test("the rest takes the remaining items", async () => {
        const output = await renderFile(slotRanges, "SlotRange.java");
        expect(output).toContain(
            [
                "            value.rest = new java.util.ArrayList<SlotNode>();",
                "            while (token != JsonToken.END_ARRAY) {",
                "                if (token != JsonToken.START_ARRAY) {",
                '                    throw new IOException("Cannot deserialize SlotRange: unexpected " + token + " for an item of the rest");',
                "                }",
                "                value.rest.add(jsonParser.readValueAs(SlotNode.class));",
                "                token = jsonParser.nextToken();",
                "            }",
                "            return value;",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "            if (obj.rest != null) {",
                "                for (SlotNode item : obj.rest) {",
                "                    jsonGenerator.writeObject(item);",
                "                }",
                "            }",
            ].join("\n"),
        );
    });

    test("an array of primitives is filled from a list", async () => {
        const output = await renderFile(
            inObject({
                type: "array",
                items: [{ type: "string" }],
                additionalItems: { type: "integer" },
            }),
            "Reply.java",
            { "array-type": "array" },
        );
        expect(output).toContain(
            [
                "            java.util.List<Long> rest = new java.util.ArrayList<Long>();",
                "            while (token != JsonToken.END_ARRAY) {",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "            value.rest = new long[rest.size()];",
                "            for (int i = 0; i < rest.size(); i++) {",
                "                value.rest[i] = rest.get(i);",
                "            }",
            ].join("\n"),
        );
    });

    test("optional items are read while there are elements", async () => {
        const output = await renderFile(optionalItems, "Pending.java");
        expect(output).toContain(
            [
                "            if (token != JsonToken.END_ARRAY) {",
                "                if (token != JsonToken.VALUE_STRING && token != JsonToken.VALUE_NULL) {",
                '                    throw new IOException("Cannot deserialize Pending: unexpected " + token + " for item2");',
                "                }",
                "                value.item2 = java.util.Optional.ofNullable(jsonParser.readValueAs(String.class));",
                "                token = jsonParser.nextToken();",
                "            }",
            ].join("\n"),
        );
        // JSON can't leave a gap.
        expect(output).toContain(
            [
                "            if (obj.item2 != null) {",
                "                if (obj.item1 == null) {",
                '                    throw new IOException("Cannot serialize Pending: an item follows a missing optional item");',
                "                }",
                "                jsonGenerator.writeObject(obj.item2.orElse(null));",
                "            }",
            ].join("\n"),
        );
    });

    test("a union tries its tuples on a JSON array, the array last", async () => {
        const output = await renderFile(arrayLikes, "Reply.java");
        expect(output).toContain(
            [
                "                case START_ARRAY: {",
                "                    TreeNode tree = jsonParser.readValueAsTree();",
                "                    try {",
                "                        value.rankScoreValue = tree.traverse(jsonParser.getCodec()).readValueAs(RankScore.class);",
                "                        break;",
                "                    } catch (Exception ex) {",
                "                        // Ignored",
                "                    }",
                "                    try {",
                "                        value.namedValue = tree.traverse(jsonParser.getCodec()).readValueAs(Named.class);",
                "                        break;",
                "                    } catch (Exception ex) {",
                "                        // Ignored",
                "                    }",
                "                    value.stringArrayValue = tree.traverse(jsonParser.getCodec()).<List<String>>readValueAs(new TypeReference<List<String>>() {});",
                "                    break;",
                "                }",
            ].join("\n"),
        );
    });

    test("a union with one array-like member reads it directly", async () => {
        const output = await renderFile(
            inObject({
                title: "Rank",
                oneOf: [
                    { type: "integer" },
                    {
                        type: "array",
                        items: [{ type: "integer" }, { type: "number" }],
                    },
                ],
            }),
            "Rank.java",
        );
        expect(output).toContain(
            [
                "                case START_ARRAY:",
                "                    value.rankTupleValue = jsonParser.readValueAs(RankTuple.class);",
                "                    break;",
            ].join("\n"),
        );
    });

    test("a tuple can contain itself", async () => {
        const output = await renderFile(commands, "Command.java");
        expect(output).toContain(
            "value.item1 = jsonParser.<List<Command>>readValueAs(new TypeReference<List<Command>>() {});",
        );
        expect(output).toContain("import com.fasterxml.jackson.core.type.*;");
    });
});
