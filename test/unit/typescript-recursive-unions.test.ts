// A union that contains itself through arrays, maps and other unions only,
// with no class in between, e.g. `Node = string | Node[]`, can't be
// spelled out where it's used: TypeScript, Flow and the JavaScript runtime
// checks overflowed the stack trying.  It's declared by name instead.

import {
    InputData,
    JSONSchemaInput,
    type LanguageName,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    lang: LanguageName,
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

    const result = await quicktype({ inputData, lang, rendererOptions });
    return result.lines.join("\n");
}

const justTypes = { "just-types": true };

const node = {
    $ref: "#/$defs/node",
    $defs: {
        node: {
            anyOf: [
                { type: "string" },
                { type: "array", items: { $ref: "#/$defs/node" } },
            ],
        },
    },
};

// `R = R[] | string[]`: the two arrays are merged into one of `R | string`.
const arrays = {
    $ref: "#/$defs/r",
    $defs: {
        r: {
            anyOf: [
                { type: "array", items: { $ref: "#/$defs/r" } },
                { type: "array", items: { type: "string" } },
            ],
        },
    },
};

const nullable = {
    $ref: "#/$defs/n",
    $defs: {
        n: {
            anyOf: [
                { type: "null" },
                { type: "array", items: { $ref: "#/$defs/n" } },
            ],
        },
    },
};

const property = {
    type: "object",
    properties: { x: { $ref: "#/$defs/n" } },
    required: ["x"],
    additionalProperties: false,
    $defs: {
        n: {
            anyOf: [
                { type: "string" },
                { type: "array", items: { $ref: "#/$defs/n" } },
                { type: "object", additionalProperties: { $ref: "#/$defs/n" } },
            ],
        },
    },
};

describe.each(["typescript", "flow"] as const)("%s", (lang) => {
    test.each([
        ["a union", node, ["export type TopLevel = Array<TopLevel> | string;"]],
        [
            "R = R[] | string[]",
            arrays,
            [
                "export type TopLevel = Array<TopLevelElement>;",
                "export type TopLevelElement = Array<TopLevelElement> | string;",
            ],
        ],
        [
            "a nullable union",
            nullable,
            ["export type TopLevel = Array<TopLevel> | null;"],
        ],
        [
            "a property",
            property,
            [
                "x: N;",
                "export type N = Array<N> | { [key: string]: N } | string;",
            ],
        ],
    ])("declares a recursive union by name: %s", async (_, schema, expected) => {
        for (const options of [{}, justTypes]) {
            const output = await renderSchema(lang, schema, options);
            for (const line of expected) {
                expect(output).toContain(line);
            }
        }
    });

    test("a declared union still ends a cycle in just-types", async () => {
        // `N = null | TopLevel[]` is only inlined, through the declared
        // `TopLevel`.
        const output = await renderSchema(
            lang,
            {
                $ref: "#/$defs/u",
                $defs: {
                    u: {
                        anyOf: [
                            { type: "string" },
                            { type: "array", items: { $ref: "#/$defs/n" } },
                        ],
                    },
                    n: {
                        anyOf: [
                            { type: "null" },
                            { type: "array", items: { $ref: "#/$defs/u" } },
                        ],
                    },
                },
            },
            { ...justTypes, "explicit-unions": true },
        );
        expect(output).toContain(
            "export type TopLevel = (TopLevel[] | null)[] | string;",
        );
        expect(output).not.toContain("export type N ");
    });
});

describe.each([
    "typescript",
    "flow",
    "javascript",
] as const)("%s type map", (lang) => {
    test.each([
        [
            "a union",
            node,
            ['"TopLevel": u(a(r("TopLevel")), ""),'],
            'r("TopLevel")',
        ],
        [
            "R = R[] | string[]",
            arrays,
            ['"TopLevelElement": u(a(r("TopLevelElement")), ""),'],
            'a(r("TopLevelElement"))',
        ],
        [
            "a nullable union",
            nullable,
            ['"TopLevel": u(a(r("TopLevel")), null),'],
            'r("TopLevel")',
        ],
        [
            "a property",
            property,
            [
                '{ json: "x", js: "x", typ: r("N") },',
                '"N": u(a(r("N")), m(r("N")), ""),',
            ],
            'r("TopLevel")',
        ],
    ])("refers to a recursive union by name: %s", async (_, schema, entries, topLevel) => {
        const output = await renderSchema(lang, schema);
        for (const entry of entries) {
            expect(output).toContain(entry);
        }
        expect(output).toContain(`cast(JSON.parse(json), ${topLevel})`);
    });
});

interface Converters {
    toTopLevel: (json: string) => unknown;
    topLevelToJson: (value: unknown) => string;
}

async function converters(schema: object): Promise<Converters> {
    const generatedModule = { exports: {} as Partial<Converters> };
    new Function("module", await renderSchema("javascript", schema))(
        generatedModule,
    );
    const { toTopLevel, topLevelToJson } = generatedModule.exports;
    if (toTopLevel === undefined || topLevelToJson === undefined) {
        throw new Error("The converters weren't exported");
    }

    return { toTopLevel, topLevelToJson };
}

test.each([
    ["a union", node, [["a", ["b", []]], "c"], [["a", [1]], [null]]],
    ["R = R[] | string[]", arrays, [[["a"], [[], ["b"]]], []], [[1], "a"]],
    ["a nullable union", nullable, [[null, [[]]], null], [[1], "a"]],
    [
        "a property",
        property,
        [{ x: { a: ["b", { c: "d" }] } }, { x: [] }],
        [{ x: { a: [1] } }, { x: 1 }],
    ],
])("the converters check a recursive union: %s", async (_, schema, valid, invalid) => {
    const { toTopLevel, topLevelToJson } = await converters(schema);
    for (const value of valid) {
        const json = JSON.stringify(value);
        expect(JSON.parse(topLevelToJson(toTopLevel(json)))).toEqual(value);
    }
    for (const value of invalid) {
        expect(() => toTopLevel(JSON.stringify(value))).toThrow();
    }
});
