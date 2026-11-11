// Flow has tuple types, but flow-bin 0.66 (which the fixtures use) has
// neither optional tuple elements nor a spread in them: only fixed-length
// tuples are tuples, the others stay arrays of the union of their items.

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
        lang: "flow",
        rendererOptions,
    });
    return result.lines.join("\n");
}

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

// The Flow fixtures run with --explicit-unions.
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

test("with --just-types the declared union ends the cycle", async () => {
    const output = await renderSchema(recursiveThroughUnion, {
        "explicit-unions": true,
        "just-types": true,
    });
    expect(output).toContain("export type Node = number | [string, Node[]];");
});

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
        "optional items",
        {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "integer" }],
            minItems: 1,
        },
        "export type TopLevel = Array<number | string>;",
    ],
    [
        "a rest",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
        },
        "export type TopLevel = Array<number | string>;",
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

test("runtime checks validate tuples", async () => {
    const output = await renderSchema({
        type: "object",
        properties: { pair },
        required: ["pair"],
        additionalProperties: false,
    });
    expect(output).toContain("pair: [string, number];");
    expect(output).toContain('typ: tu(["", 3.14], 2)');
});
