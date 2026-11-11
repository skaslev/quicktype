// JavaScript has no type declarations, but its runtime checks validate
// every tuple shape: the length, each item's type, optional trailing items
// and a rest.

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

    const result = await quicktype({ inputData, lang: "javascript" });
    return result.lines.join("\n");
}

interface Converters {
    toTopLevel: (json: string) => unknown;
    topLevelToJson: (value: unknown) => string;
}

async function converters(schema: object): Promise<Converters> {
    const generatedModule = { exports: {} as Partial<Converters> };
    new Function("module", await renderSchema(schema))(generatedModule);
    const { toTopLevel, topLevelToJson } = generatedModule.exports;
    if (toTopLevel === undefined || topLevelToJson === undefined) {
        throw new Error("The converters weren't exported");
    }

    return { toTopLevel, topLevelToJson };
}

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
};

const node = {
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
};

test.each([
    ["fixed length", pair, 'tu(["", 3.14], 2)'],
    [
        "optional trailing items",
        {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "integer" }],
            minItems: 1,
        },
        'tu(["", i(0)], 1)',
    ],
    [
        "a rest",
        {
            type: "array",
            items: [{ type: "string" }],
            additionalItems: { type: "integer" },
        },
        'tu([""], 1, i(0))',
    ],
] as const)("the type map has tuples: %s", async (_, schema, expected) => {
    expect(await renderSchema({ type: "array", items: schema })).toContain(
        `cast(JSON.parse(json), a(${expected}))`,
    );
});

test("a recursive tuple is referenced by name", async () => {
    const output = await renderSchema(node);
    expect(output).toContain('"TopLevel": tu(["", a(r("TopLevel"))], 2),');
    expect(output).toContain('cast(JSON.parse(json), r("TopLevel"))');
});

test("a tuple of two classes doesn't take the top-level's name", async () => {
    const object = (p: string): object => ({
        title: p.toUpperCase(),
        type: "object",
        properties: { [p]: { type: "string" } },
        required: [p],
    });
    const output = await renderSchema({
        oneOf: [
            { type: "null" },
            { type: "array", items: [object("a"), object("b")] },
        ],
    });
    expect(output).toContain(
        'cast(JSON.parse(json), u(null, tu([r("A"), r("B")], 2)))',
    );
});

describe("the converters check tuples", () => {
    test.each([
        [
            "a fixed-length tuple",
            pair,
            [["a", 1.5]],
            [["a"], ["a", 1, 2], [1, "a"]],
        ],
        [
            "optional items",
            {
                type: "array",
                prefixItems: [{ type: "string" }, { type: "integer" }],
                minItems: 1,
            },
            [["a"], ["a", 2]],
            [[], ["a", "b"], ["a", 2, 3]],
        ],
        [
            "a rest",
            {
                type: "array",
                prefixItems: [{ type: "string" }],
                items: { type: "integer" },
            },
            [["a"], ["a", 1, 2, 3]],
            [[], [1], ["a", 1, "b"]],
        ],
        [
            "a tuple in a union with an array, another tuple and null",
            {
                oneOf: [
                    pair,
                    { type: "array", items: [{ type: "integer" }] },
                    { type: "array", items: { type: "string" } },
                    { type: "null" },
                ],
            },
            [["a", 1.5], [1], ["a", "b", "c"], null],
            [["a", "b", 1], [1.5], [1, 2]],
        ],
        [
            "a recursive tuple",
            node,
            [["a", [["b", []]]]],
            [
                ["a", [["b"]]],
                ["a", [[1, []]]],
            ],
        ],
    ] as const)("%s", async (_, schema, valid, invalid) => {
        const { toTopLevel, topLevelToJson } = await converters(schema);
        for (const value of valid) {
            const json = JSON.stringify(value);
            expect(JSON.parse(topLevelToJson(toTopLevel(json)))).toEqual(value);
        }

        for (const value of invalid) {
            expect(() => toTopLevel(JSON.stringify(value))).toThrow();
            expect(() => topLevelToJson(value)).toThrow();
        }
    });
});
