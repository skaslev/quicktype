// TypeScript expresses every tuple shape: fixed items, optional trailing
// items and a rest.

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
        lang: "typescript",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const justTypes = { "just-types": true };

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
};

test.each([
    ["fixed length", pair, "export type TopLevel = [string, number];"],
    [
        "without minItems, all items are present",
        {
            type: "array",
            items: [{ type: "integer" }, { type: "boolean" }],
        },
        "export type TopLevel = [number, boolean];",
    ],
    [
        "optional trailing items",
        {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "integer" }],
            minItems: 1,
        },
        "export type TopLevel = [string, number?];",
    ],
    [
        "rest elements (2020-12)",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
        },
        "export type TopLevel = [string, ...number[]];",
    ],
    [
        "rest elements (draft-07 additionalItems)",
        {
            type: "array",
            items: [{ type: "string" }],
            additionalItems: {
                oneOf: [{ type: "integer" }, { type: "string" }],
            },
            minItems: 1,
        },
        "export type TopLevel = [string, ...(number | string)[]];",
    ],
    [
        "a few rest elements become optional items",
        {
            type: "array",
            items: [{ type: "string" }, { type: "string" }],
            additionalItems: { type: "integer" },
            minItems: 2,
            maxItems: 3,
        },
        "export type TopLevel = [string, string, number?];",
    ],
    [
        "without minItems, the elements of a bounded rest are optional",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
            maxItems: 3,
        },
        "export type TopLevel = [string, number?, number?];",
    ],
] as const)("%s", async (_, schema, expected) => {
    expect(await renderSchema(schema, justTypes)).toContain(expected);
});

test("a titled tuple gets a type alias", async () => {
    const output = await renderSchema(
        { type: "array", items: { ...pair, title: "MemberScore" } },
        justTypes,
    );
    expect(output).toContain("export type TopLevel = MemberScore[];");
    expect(output).toContain("export type MemberScore = [string, number];");
});

test("a recursive tuple gets a type alias", async () => {
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
        justTypes,
    );
    expect(output).toContain("export type TopLevel = [string, TopLevel[]];");
});

test("a union keeps a tuple and an array of tuples apart", async () => {
    const output = await renderSchema(
        { oneOf: [pair, { type: "array", items: pair }] },
        justTypes,
    );
    expect(output).toContain(
        "export type TopLevel = [string, number][] | [string, number];",
    );
});

test("a union keeps an array of tuples and a tuple with minItems apart", async () => {
    const one = { type: "array", items: [{ type: "string" }], minItems: 1 };
    const output = await renderSchema(
        { anyOf: [{ type: "array", items: one }, one] },
        justTypes,
    );
    expect(output).toContain("export type TopLevel = [string][] | [string];");
});

test("runtime checks validate tuples", async () => {
    const output = await renderSchema({
        type: "object",
        properties: { pair },
        required: ["pair"],
        additionalProperties: false,
    });
    expect(output).toContain('typ: tu(["", 3.14], 2)');
    expect(output).toContain("function transformTuple(");
});

// The tuple type only expresses `minItems` up to the positional items, and
// `maxItems` up to a few optional ones.
test.each([
    [
        "minItems above the positional items",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
            minItems: 3,
        },
        'tu([""], 3, i(0))',
    ],
    [
        "maxItems above the optional items",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
            maxItems: 10,
        },
        'tu([""], 1, i(0), 10)',
    ],
    [
        "maxItems below the positional items",
        {
            type: "array",
            prefixItems: [
                { type: "string" },
                { type: "integer" },
                { type: "integer" },
            ],
            items: false,
            minItems: 1,
            maxItems: 2,
        },
        'tu(["", i(0), i(0)], 1, undefined, 2)',
    ],
] as const)("runtime checks enforce the schema's bounds: %s", async (_, tuple, expected) => {
    const output = await renderSchema({
        type: "object",
        properties: { tuple },
        required: ["tuple"],
        additionalProperties: false,
    });
    expect(output).toContain(`typ: ${expected}`);
    expect(output).toContain("(typ.max !== undefined && val.length > typ.max)");
});

test("runtime checks for output without tuples are unchanged", async () => {
    const output = await renderSchema({
        type: "object",
        properties: { a: { type: "string" } },
    });
    expect(output).not.toContain("transformTuple");
    expect(output).not.toContain("function tu(");
});

// A tuple that contains itself through a union, and isn't named by the
// schema.
const recursiveThroughUnion = {
    type: "object",
    properties: {
        node: {
            type: "array",
            items: [
                { type: "string" },
                {
                    type: "array",
                    items: {
                        oneOf: [
                            { $ref: "#/properties/node" },
                            { type: "integer" },
                        ],
                    },
                },
            ],
        },
    },
    required: ["node"],
};

// The runtime checks' type map spells out declared unions too, so there the
// tuple needs a name (the Flow fixtures run with --explicit-unions).
test("a tuple that contains itself through a declared union is named for the runtime checks", async () => {
    const output = await renderSchema(recursiveThroughUnion, {
        "explicit-unions": true,
    });
    expect(output).toContain(
        "export type NodeTuple = [string, NodeElement[]];",
    );
    expect(output).toContain(
        '"NodeTuple": tu(["", a(u(i(0), r("NodeTuple")))], 2),',
    );
});

test("with --explicit-unions and --just-types the declared union ends the cycle", async () => {
    const output = await renderSchema(recursiveThroughUnion, {
        "explicit-unions": true,
        "just-types": true,
    });
    expect(output).toContain("export type Node = number | [string, Node[]];");
});
