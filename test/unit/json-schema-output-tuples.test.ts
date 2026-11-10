// The JSON Schema target writes tuples as draft-06 tuples: `items` is the
// items, `additionalItems` the rest or `false`, `minItems`/`maxItems` the
// lengths.  Reading that output back gives the same tuples.

import Ajv from "ajv";
import draft06MetaSchema from "ajv/dist/refs/json-schema-draft-06.json";
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

    const result = await quicktype({ inputData, lang: "schema" });
    return result.lines.join("\n");
}

async function render(schema: object): Promise<object> {
    return JSON.parse(await renderSchema(schema));
}

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
};

const string = { type: "string" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };

test.each([
    [
        "fixed length",
        pair,
        {
            type: "array",
            items: [string, { type: "number" }],
            additionalItems: false,
            minItems: 2,
            maxItems: 2,
        },
    ],
    [
        "without minItems, all items are present",
        { type: "array", items: [integer, boolean] },
        {
            type: "array",
            items: [integer, boolean],
            additionalItems: false,
            minItems: 2,
            maxItems: 2,
        },
    ],
    [
        "optional trailing items",
        { type: "array", prefixItems: [string, integer], minItems: 1 },
        {
            type: "array",
            items: [string, integer],
            additionalItems: false,
            minItems: 1,
            maxItems: 2,
        },
    ],
    [
        "only optional items: minItems 0 is kept",
        { type: "array", prefixItems: [string], minItems: 0 },
        {
            type: "array",
            items: [string],
            additionalItems: false,
            minItems: 0,
            maxItems: 1,
        },
    ],
    [
        "rest elements (2020-12)",
        { type: "array", prefixItems: [string], items: integer },
        {
            type: "array",
            items: [string],
            additionalItems: integer,
            minItems: 1,
        },
    ],
    [
        "rest elements (draft-07 additionalItems)",
        {
            type: "array",
            items: [string, boolean],
            additionalItems: integer,
            minItems: 1,
        },
        {
            type: "array",
            items: [string, boolean],
            additionalItems: integer,
            minItems: 1,
        },
    ],
    [
        "a few rest elements become optional items",
        {
            type: "array",
            items: [string, string],
            additionalItems: integer,
            minItems: 2,
            maxItems: 3,
        },
        {
            type: "array",
            items: [string, string, integer],
            additionalItems: false,
            minItems: 2,
            maxItems: 3,
        },
    ],
    [
        "the lengths of a rest the shape doesn't capture are kept",
        {
            type: "array",
            items: [string],
            additionalItems: integer,
            minItems: 3,
            maxItems: 100,
        },
        {
            type: "array",
            items: [string],
            additionalItems: integer,
            minItems: 3,
            maxItems: 100,
        },
    ],
] as const)("%s", async (_, schema, expected) => {
    // As a property: a top-level tuple is named, and so a definition.
    const output = (await render({
        type: "object",
        properties: { tuple: schema },
        required: ["tuple"],
        additionalProperties: false,
    })) as { definitions: { TopLevel: { properties: object } } };
    expect(output.definitions.TopLevel.properties).toEqual({
        tuple: expected,
    });
});

test("a titled tuple is a definition", async () => {
    const output = await render({
        type: "array",
        items: { ...pair, title: "MemberScore" },
    });
    expect(output).toMatchObject({
        type: "array",
        items: { $ref: "#/definitions/MemberScore" },
        definitions: {
            MemberScore: {
                type: "array",
                items: [string, { type: "number" }],
                additionalItems: false,
                minItems: 2,
                maxItems: 2,
                title: "MemberScore",
            },
        },
    });
});

const recursiveTuple = {
    $ref: "#/$defs/node",
    $defs: {
        node: {
            type: "array",
            items: [string, { type: "array", items: { $ref: "#/$defs/node" } }],
        },
    },
};

test("a recursive tuple is a definition", async () => {
    expect(await render(recursiveTuple)).toEqual({
        $schema: "http://json-schema.org/draft-06/schema#",
        $ref: "#/definitions/TopLevel",
        definitions: {
            TopLevel: {
                type: "array",
                items: [
                    string,
                    {
                        type: "array",
                        items: { $ref: "#/definitions/TopLevel" },
                    },
                ],
                additionalItems: false,
                minItems: 2,
                maxItems: 2,
                title: "TopLevel",
            },
        },
    });
});

test("a union keeps a tuple and an array of tuples apart", async () => {
    const output = await render({
        oneOf: [pair, { type: "array", items: pair }],
    });
    expect(output).toMatchObject({
        definitions: {
            TopLevel: {
                anyOf: [
                    { type: "array", items: { items: [string, {}] } },
                    { type: "array", items: [string, {}] },
                ],
            },
        },
    });
});

// Redis' CLUSTER SLOTS reply: slot ranges of a start, an end, a master node
// and any number of replica nodes, each node a 4-tuple.
const clusterSlots = {
    type: "array",
    items: {
        title: "SlotRange",
        type: "array",
        minItems: 3,
        maxItems: 4294967295,
        items: [integer, integer, { $ref: "#/$defs/node" }],
        additionalItems: { $ref: "#/$defs/node" },
    },
    $defs: {
        node: {
            title: "SlotNode",
            type: "array",
            minItems: 4,
            maxItems: 4,
            items: [
                { oneOf: [string, { type: "null" }] },
                integer,
                string,
                {
                    type: "object",
                    additionalProperties: false,
                    properties: { hostname: string, ip: string },
                },
            ],
        },
    },
};

describe("output read back", () => {
    test.each([
        ["a tuple", pair],
        [
            "optional items and a rest",
            {
                type: "array",
                items: [string, boolean],
                additionalItems: integer,
                minItems: 1,
            },
        ],
        ["a recursive tuple", recursiveTuple],
        ["CLUSTER SLOTS", clusterSlots],
    ] as const)("keeps the tuples: %s", async (_, schema) => {
        const output = await renderSchema(schema);
        expect(output).toContain('"items": [');
        expect(await renderSchema(JSON.parse(output))).toEqual(output);
    });
});

test("validators accept tuples of the right shape only", async () => {
    const ajv = new Ajv({ strictTuples: false });
    ajv.addMetaSchema(draft06MetaSchema);
    const validate = ajv.compile(await render(clusterSlots));
    const node = ["127.0.0.1", 30001, "09dbe972", { hostname: "a" }];
    expect(validate([[0, 5460, node]])).toBe(true);
    expect(validate([[0, 5460, node, node, node]])).toBe(true);
    expect(validate([[0, 5460, [null, 30001, "09dbe972", {}]]])).toBe(true);
    // No master
    expect(validate([[0, 5460]])).toBe(false);
    // A node of three items
    expect(validate([[0, 5460, node.slice(0, 3)]])).toBe(false);
    // A replica of five items
    expect(validate([[0, 5460, node, [...node, 1]]])).toBe(false);
    // The end slot as a string
    expect(validate([[0, "5460", node]])).toBe(false);
    // The master first
    expect(validate([[node, 0, 5460]])).toBe(false);
    // The port before the host
    expect(validate([[0, 5460, [30001, "127.0.0.1", "09dbe972", {}]]])).toBe(
        false,
    );
});
