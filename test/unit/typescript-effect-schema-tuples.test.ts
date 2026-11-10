// Effect Schema expresses every tuple shape: S.Tuple for the items,
// S.optionalElement for optional ones, and a rest.  A tuple in a cycle has
// its types declared, like a class in a cycle has its encoded interface.

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
        lang: "typescript-effect-schema",
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
        "export const TopLevel = S.Tuple(S.String, S.Number);",
    ],
    [
        "without minItems, all items are present",
        {
            type: "array",
            items: [{ type: "integer" }, { type: "boolean" }],
        },
        "export const TopLevel = S.Tuple(S.Int, S.Boolean);",
    ],
    [
        "optional trailing items",
        {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "integer" }],
            minItems: 1,
        },
        "export const TopLevel = S.Tuple(S.String, S.optionalElement(S.Int));",
    ],
    [
        "rest elements (2020-12)",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
        },
        "export const TopLevel = S.Tuple([S.String], S.Int);",
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
        "export const TopLevel = S.Tuple([S.String], S.Union(S.Int, S.String));",
    ],
    [
        "optional items and a rest",
        {
            type: "array",
            items: [{ type: "string" }, { type: "boolean" }],
            additionalItems: { type: "integer" },
            minItems: 1,
        },
        "export const TopLevel = S.Tuple([S.String, S.optionalElement(S.Boolean)], S.Int);",
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
        "export const TopLevel = S.Tuple(S.String, S.String, S.optionalElement(S.Int));",
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
            "export const MemberScore = S.Tuple(S.String, S.Number);",
            "export type MemberScore = S.Schema.Type<typeof MemberScore>;",
        ].join("\n"),
    );
    expect(output).toContain("export const TopLevel = S.Array(MemberScore);");
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

// `S.Schema.Type<typeof TopLevel>` can't be used in TopLevel's own
// definition, so both of its types are declared.
test("a recursive tuple declares its types", async () => {
    const output = await renderSchema(recursiveTuple);
    expect(output).toContain(
        [
            "export type TopLevel = readonly [string, ReadonlyArray<TopLevel>];",
            "export type TopLevelEncoded = readonly [string, ReadonlyArray<TopLevelEncoded>];",
            "export const TopLevel = S.Tuple(S.String, S.Array(S.suspend((): S.Schema<TopLevel, TopLevelEncoded> => TopLevel)));",
        ].join("\n"),
    );
    expect(output).not.toMatch(/\bany\b/);
});

test("a recursive tuple declares its types in just-schema mode", async () => {
    const output = await renderSchema(recursiveTuple, { "just-schema": true });
    expect(output).toContain(
        "export type TopLevel = readonly [string, ReadonlyArray<TopLevel>];",
    );
    expect(output).toContain(
        "export type TopLevelEncoded = readonly [string, ReadonlyArray<TopLevelEncoded>];",
    );
});

// TypeScript resolves `...Array<R>` eagerly, so a tuple that is its own
// rest needs `...R[]`; `?` and `[]` bind tighter than `|`.
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
            "export type TopLevel = readonly [string, (number | string)?, ...TopLevel[]];",
            "export type TopLevelEncoded = readonly [string, (number | string)?, ...TopLevelEncoded[]];",
            "export const TopLevel = S.Tuple([S.String, S.optionalElement(S.Union(S.Int, S.String))], S.suspend((): S.Schema<TopLevel, TopLevelEncoded> => TopLevel));",
        ].join("\n"),
    );
});

// The class's encoded interface spells out the tuple with the encoded types
// of its items.
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
                            { type: "string", format: "integer" },
                            { $ref: "#/$defs/command" },
                        ],
                        items: { type: "string", format: "date-time" },
                        minItems: 1,
                    },
                },
                required: ["name", "sub"],
                additionalProperties: false,
            },
        },
    });
    expect(output).toContain(
        '    readonly "sub": readonly [string, TopLevelEncoded?, ...string[]];',
    );
    expect(output).toContain(
        '    "sub": S.Tuple([S.String.pipe(S.pattern(/^-?\\d+$/)), S.optionalElement(S.suspend((): S.Schema<TopLevel, TopLevelEncoded> => TopLevel))], S.String.pipe(',
    );
    expect(output).not.toMatch(/\bany\b/);
});

// A titled tuple and a class that refer to each other: the tuple's types are
// declared, and it refers to the class through an annotated S.suspend.
test("a class and a titled tuple in one cycle", async () => {
    const output = await renderSchema({
        $ref: "#/$defs/A",
        $defs: {
            A: {
                type: "object",
                properties: { t: { $ref: "#/$defs/T" } },
                required: ["t"],
                additionalProperties: false,
            },
            T: {
                title: "Pair",
                type: "array",
                prefixItems: [{ type: "string" }, { $ref: "#/$defs/A" }],
                minItems: 1,
            },
        },
    });
    expect(output).toContain(
        [
            "export type Pair = readonly [string, TopLevel?];",
            "export type PairEncoded = readonly [string, TopLevelEncoded?];",
            "export const Pair = S.Tuple(S.String, S.optionalElement(S.suspend((): S.Schema<TopLevel, TopLevelEncoded> => TopLevel)));",
            "",
            "export interface TopLevelEncoded {",
            '    readonly "t": PairEncoded;',
            "}",
            "",
            'export class TopLevel extends S.Class<TopLevel>("TopLevel")({',
            '    "t": Pair,',
            "}) {}",
        ].join("\n"),
    );
});

test("a union keeps a tuple and an array of tuples apart", async () => {
    const output = await renderSchema({
        oneOf: [pair, { type: "array", items: pair }],
    });
    expect(output).toContain(
        "export const TopLevel = S.Union(S.Array(S.Tuple(S.String, S.Number)), S.Tuple(S.String, S.Number));",
    );
});
