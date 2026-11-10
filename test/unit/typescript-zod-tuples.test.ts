// zod expresses every tuple shape: z.tuple() for the items, .rest() for a
// rest.  zod 3's z.tuple() requires every item, so a tuple with optional
// items is a union of one tuple per length.

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
        lang: "typescript-zod",
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
        pair,
        "export const TopLevelSchema = z.tuple([z.string(), z.number()]);",
    ],
    [
        "without minItems, all items are present",
        {
            type: "array",
            items: [{ type: "integer" }, { type: "boolean" }],
        },
        "export const TopLevelSchema = z.tuple([z.number().int(), z.boolean()]);",
    ],
    [
        "optional trailing items",
        {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "integer" }],
            minItems: 1,
        },
        "export const TopLevelSchema = z.union([z.tuple([z.string(), z.number().int()]), z.tuple([z.string()])]);",
    ],
    [
        "rest elements (2020-12)",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
        },
        "export const TopLevelSchema = z.tuple([z.string()]).rest(z.number().int());",
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
        "export const TopLevelSchema = z.tuple([z.string()]).rest(z.union([z.number().int(), z.string()]));",
    ],
    [
        "optional items and a rest",
        {
            type: "array",
            items: [{ type: "string" }, { type: "boolean" }],
            additionalItems: { type: "integer" },
            minItems: 1,
        },
        "export const TopLevelSchema = z.union([z.tuple([z.string(), z.boolean()]).rest(z.number().int()), z.tuple([z.string()])]);",
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
        "export const TopLevelSchema = z.union([z.tuple([z.string(), z.string(), z.number().int()]), z.tuple([z.string(), z.string()])]);",
    ],
] as const)("%s", async (_, schema, expected) => {
    expect(await renderSchema(schema)).toContain(expected);
});

test("a titled tuple gets a schema and a type", async () => {
    const output = await renderSchema({
        type: "array",
        items: { ...pair, title: "MemberScore" },
    });
    expect(output).toContain(
        [
            "export const MemberScoreSchema = z.tuple([z.string(), z.number()]);",
            "export type MemberScore = z.infer<typeof MemberScoreSchema>;",
        ].join("\n"),
    );
    expect(output).toContain(
        "export const TopLevelSchema = z.array(MemberScoreSchema);",
    );
});

const recursiveTuple = {
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

test("a recursive tuple is lazy, with its type declared", async () => {
    const output = await renderSchema(recursiveTuple);
    expect(output).toContain(
        [
            "export type TopLevel = [string, Array<TopLevel>];",
            "export const TopLevelSchema: z.ZodType<TopLevel> = z.lazy(() => z.tuple([z.string(), z.array(TopLevelSchema)]));",
        ].join("\n"),
    );
});

test("a recursive tuple in just-schema mode", async () => {
    const output = await renderSchema(recursiveTuple, { "just-schema": true });
    expect(output).toContain(
        "export const TopLevelSchema: z.ZodType<any> = z.lazy(() => z.tuple([z.string(), z.array(TopLevelSchema)]));",
    );
    expect(output).not.toContain("export type");
});

// TypeScript resolves `...Array<R>` eagerly, so a tuple that is its own
// rest needs `...R[]`.
test("a recursive tuple with optional items and a rest", async () => {
    const output = await renderSchema({
        $ref: "#/$defs/node",
        $defs: {
            node: {
                type: "array",
                prefixItems: [
                    { type: "string" },
                    { oneOf: [{ type: "integer" }, { type: "string" }] },
                ],
                items: { $ref: "#/$defs/node" },
                minItems: 1,
            },
        },
    });
    expect(output).toContain(
        [
            "export type TopLevel = [string, number | string, ...TopLevel[]] | [string];",
            "export const TopLevelSchema: z.ZodType<TopLevel> = z.lazy(() => z.union([z.tuple([z.string(), z.union([z.number().int(), z.string()])]).rest(TopLevelSchema), z.tuple([z.string()])]));",
        ].join("\n"),
    );
});

// The class refers to itself through a tuple: its declared type spells the
// tuple out, as z.infer would.
test("a class in a cycle through a tuple", async () => {
    const output = await renderSchema({
        $ref: "#/$defs/command",
        $defs: {
            command: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    sub: {
                        type: "array",
                        prefixItems: [
                            { type: "integer" },
                            { $ref: "#/$defs/command" },
                        ],
                        items: { type: "string" },
                        minItems: 1,
                    },
                },
                required: ["name", "sub"],
                additionalProperties: false,
            },
        },
    });
    expect(output).toContain(
        '"sub": [number, TopLevel, ...string[]] | [number];',
    );
    expect(output).toContain(
        '"sub": z.union([z.tuple([z.number().int(), TopLevelSchema]).rest(z.string()), z.tuple([z.number().int()])]),',
    );
});

// A titled tuple's schema must come before the classes that use it, and
// after the classes it uses.
test("named tuples and classes are declared in dependency order", async () => {
    const output = await renderSchema({
        type: "object",
        properties: {
            entry: {
                title: "Entry",
                type: "array",
                items: [{ type: "string" }, { $ref: "#/$defs/point" }],
            },
        },
        required: ["entry"],
        additionalProperties: false,
        $defs: {
            point: {
                type: "object",
                properties: { x: { type: "number" } },
                required: ["x"],
                additionalProperties: false,
            },
        },
    });
    const point = output.indexOf("export const PointSchema =");
    const entry = output.indexOf(
        "export const EntrySchema = z.tuple([z.string(), PointSchema]);",
    );
    const topLevel = output.indexOf("export const TopLevelSchema = z.object({");
    expect(point).toBeGreaterThanOrEqual(0);
    expect(entry).toBeGreaterThan(point);
    expect(topLevel).toBeGreaterThan(entry);
});

test("a union keeps a tuple and an array of tuples apart", async () => {
    const output = await renderSchema({
        oneOf: [pair, { type: "array", items: pair }],
    });
    expect(output).toContain(
        "export const TopLevelSchema = z.union([z.array(z.tuple([z.string(), z.number()])), z.tuple([z.string(), z.number()])]);",
    );
});
