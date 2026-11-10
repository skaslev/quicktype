// serde (de)serializes Rust tuples as JSON arrays of exactly their length, so
// Rust keeps fixed-length tuples.  Other tuple shapes are tuple structs with
// their own impls, see rust-tuple-rest.test.ts.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { expect, test } from "vitest";

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
        lang: "rust",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
};

test.each([
    [
        "fixed length",
        { type: "array", items: pair },
        "pub type TopLevel = Vec<(String, f64)>;",
    ],
    [
        "one element",
        {
            type: "array",
            items: { type: "array", items: [{ type: "string" }] },
        },
        "pub type TopLevel = Vec<(String,)>;",
    ],
    [
        // Like a top-level union, which becomes a named enum.
        "a top-level tuple becomes a tuple struct",
        pair,
        "pub struct TopLevel(pub String, pub f64);",
    ],
    [
        "rest elements become a tuple struct",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
        },
        "pub struct TopLevel(pub String, pub Vec<i64>);",
    ],
] as const)("%s", async (_, schema, expected) => {
    expect(await renderSchema(schema)).toContain(expected);
});

test("a titled tuple becomes a tuple struct", async () => {
    const output = await renderSchema({
        type: "array",
        items: { ...pair, title: "MemberScore" },
    });
    expect(output).toContain("pub type TopLevel = Vec<MemberScore>;");
    expect(output).toContain("pub struct MemberScore(pub String, pub f64);");
});

test("a recursive tuple becomes a tuple struct", async () => {
    const output = await renderSchema(
        {
            $ref: "#/$defs/node",
            $defs: {
                node: {
                    type: "array",
                    items: [
                        { type: "string" },
                        { type: "array", items: { $ref: "#/$defs/node" } },
                    ],
                },
            },
        },
        { visibility: "public" },
    );
    expect(output).toContain(
        "pub struct TopLevel(pub String, pub Vec<TopLevel>);",
    );
});
