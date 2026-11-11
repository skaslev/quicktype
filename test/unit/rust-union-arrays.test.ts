// Rust keeps the arrays of JSON Schema array schemas apart in unions, if
// their item types can be told apart, as the variants of an untagged enum.
// serde tries those in turn, and a `Vec` only takes an array whose elements
// are all of its items.  The structs of arrays of classes kept apart reject
// unknown fields, like those of the classes of a union.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: "rust",
        rendererOptions: { density: "dense" },
    });
    return result.lines.join("\n");
}

function arrayOf(items: object): object {
    return { type: "array", items };
}

function closedObject(properties: Record<string, object>): object {
    return {
        type: "object",
        properties,
        required: Object.keys(properties).slice(0, 1),
        additionalProperties: false,
    };
}

const derive = "#[derive(Debug, Clone, Serialize, Deserialize)]";

describe("a union of arrays", () => {
    test("is an untagged enum of vectors", async () => {
        const output = await renderSchema({
            anyOf: [
                arrayOf({ type: "string" }),
                arrayOf({
                    title: "MemberScore",
                    ...closedObject({
                        member: { type: "string" },
                        score: { type: "number" },
                    }),
                }),
            ],
        });
        expect(output).toContain(
            [
                derive,
                "#[serde(untagged)]",
                "pub enum TopLevel {",
                "    MemberScoreArray(Vec<MemberScore>),",
                "    StringArray(Vec<String>),",
                "}",
            ].join("\n"),
        );
    });

    test("names arrays of unions after them", async () => {
        const output = await renderSchema({
            anyOf: [
                arrayOf({
                    title: "UnsignedInteger",
                    oneOf: [
                        { type: "integer" },
                        { type: "string", pattern: "^[0-9]+$" },
                    ],
                }),
                arrayOf(arrayOf({ type: "boolean" })),
            ],
        });
        expect(output).toContain(
            [
                "pub enum TopLevel {",
                "    BoolArrayArray(Vec<Vec<bool>>),",
                "    UnsignedIntegerArray(Vec<UnsignedInteger>),",
                "}",
            ].join("\n"),
        );
    });

    test("next to null is optional", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                reply: {
                    oneOf: [
                        { type: "null" },
                        arrayOf({ type: "string" }),
                        arrayOf({ type: "integer" }),
                    ],
                },
            },
            required: ["reply"],
            additionalProperties: false,
        });
        expect(output).toContain("    pub reply: Option<Reply>,");
        expect(output).toContain(
            [
                "pub enum Reply {",
                "    IntegerArray(Vec<i64>),",
                "    StringArray(Vec<String>),",
                "}",
            ].join("\n"),
        );
    });
});

describe("the structs of arrays of classes", () => {
    test("reject unknown fields if kept apart", async () => {
        const output = await renderSchema({
            oneOf: [
                arrayOf({
                    title: "Short",
                    ...closedObject({ a: { type: "integer" } }),
                }),
                arrayOf({
                    title: "Long",
                    ...closedObject({
                        b: { type: "string" },
                        a: { type: "integer" },
                    }),
                }),
            ],
        });
        expect(output).toContain(
            [
                "pub enum TopLevel {",
                "    LongArray(Vec<Long>),",
                "    ShortArray(Vec<Short>),",
                "}",
            ].join("\n"),
        );
        for (const name of ["Short", "Long"]) {
            expect(output).toContain(
                [
                    derive,
                    "#[serde(deny_unknown_fields)]",
                    `pub struct ${name} {`,
                ].join("\n"),
            );
        }
    });

    test("don't reject unknown fields next to arrays of other items", async () => {
        const output = await renderSchema({
            oneOf: [
                arrayOf({
                    title: "Short",
                    ...closedObject({ a: { type: "integer" } }),
                }),
                arrayOf({ type: "string" }),
            ],
        });
        expect(output).toContain("    ShortArray(Vec<Short>),");
        expect(output).not.toContain("deny_unknown_fields");
    });
});
