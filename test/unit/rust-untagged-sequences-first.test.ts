// serde takes the first variant of an untagged enum that deserializes, and a
// struct also deserializes from a JSON array of its fields' values.  So an
// enum with a struct variant lists its array variant first: otherwise the
// struct would take the arrays of as many elements as it has fields.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderRust(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({ inputData, lang: "rust" });
    return result.lines.join("\n");
}

const alpha = {
    title: "Alpha",
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
};
const strings = { type: "array", items: { type: "string" } };

describe("an untagged enum", () => {
    test("lists an array variant before a struct variant", async () => {
        const output = await renderRust({
            oneOf: [alpha, strings, { type: "integer" }],
        });
        expect(output).toContain(
            [
                "pub enum TopLevel {",
                "    StringArray(Vec<String>),",
                "",
                "    Alpha(Alpha),",
                "",
                "    Integer(i64),",
                "}",
            ].join("\n"),
        );
    });

    test("lists an array variant before a boxed struct variant", async () => {
        const output = await renderRust({
            type: "object",
            properties: { node: { $ref: "#/definitions/Alpha" } },
            required: ["node"],
            definitions: {
                Alpha: {
                    type: "object",
                    properties: {
                        a: {
                            oneOf: [
                                { $ref: "#/definitions/Alpha" },
                                { type: "array", items: { type: "integer" } },
                            ],
                        },
                    },
                    required: ["a"],
                },
            },
        });
        expect(output).toMatch(
            /pub enum \w+ \{\n {4}IntegerArray\(Vec<i64>\),\n\n {4}Alpha\(Box<Alpha>\),\n\}/,
        );
    });

    test("without a struct variant lists its variants by name", async () => {
        const output = await renderRust({
            oneOf: [strings, { type: "integer" }],
        });
        expect(output).toContain(
            [
                "pub enum TopLevel {",
                "    Integer(i64),",
                "",
                "    StringArray(Vec<String>),",
                "}",
            ].join("\n"),
        );
    });
});
