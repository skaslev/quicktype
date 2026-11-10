// TypeScript keeps the classes of JSON Schema object schemas that forbid
// additional properties apart in unions, as `A | B`, and the converter checks
// a value against each class, to take it for the class it's of.

import { transform } from "esbuild";
import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

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

interface Converter {
    toTopLevel: (json: string) => unknown;
    topLevelToJson: (value: unknown) => string;
}

// Loads the converter of the TypeScript for `schema`.
async function loadConverter(schema: object): Promise<Converter> {
    const { code } = await transform(await renderSchema(schema), {
        loader: "ts",
        format: "cjs",
    });
    const module = { exports: {} as { Convert: Converter } };
    new Function("exports", "module", code)(module.exports, module);
    return module.exports.Convert;
}

function closedObject(
    properties: Record<string, object>,
    required: string[],
): object {
    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}

const summaryOrFull = {
    oneOf: [
        {
            title: "Summary",
            ...closedObject(
                { length: { type: "integer" }, groups: { type: "integer" } },
                ["length", "groups"],
            ),
        },
        {
            title: "Full",
            ...closedObject(
                {
                    length: { type: "integer" },
                    entries: { type: "array", items: { type: "string" } },
                    groups: { type: "array", items: { type: "string" } },
                },
                ["length", "entries", "groups"],
            ),
        },
    ],
};

describe("types", () => {
    test("a union of classes", async () => {
        const output = await renderSchema(summaryOrFull, {
            "just-types": true,
            "explicit-unions": true,
        });
        expect(output).toContain("export type TopLevel = Summary | Full;");
        expect(output).toContain("export interface Summary {");
        expect(output).toContain("export interface Full {");
    });

    test("an inline union of classes", async () => {
        const output = await renderSchema(
            {
                type: "object",
                properties: { reply: summaryOrFull },
                required: ["reply"],
                additionalProperties: false,
            },
            { "just-types": true },
        );
        expect(output).toContain("    reply: Summary | Full;");
    });
});

describe("converter", () => {
    test("checks a value against each class", async () => {
        const convert = await loadConverter(summaryOrFull);
        for (const value of [
            { length: 1, groups: 2 },
            { length: 1, entries: ["a"], groups: ["b"] },
        ]) {
            const json = JSON.stringify(value);
            expect(
                JSON.parse(convert.topLevelToJson(convert.toTopLevel(json))),
            ).toEqual(value);
        }

        for (const value of [
            { length: 1, groups: ["b"] },
            { length: 1, entries: ["a"], groups: 2 },
            { length: 1, groups: 2, extra: true },
        ]) {
            expect(() => convert.toTopLevel(JSON.stringify(value))).toThrow();
        }
    });

    // The converter checks other empty classes as any object.
    test("takes only empty objects for an empty class", async () => {
        const convert = await loadConverter({
            oneOf: [
                { type: "object", additionalProperties: false },
                closedObject({ at: { type: "string", format: "date-time" } }, [
                    "at",
                ]),
            ],
        });
        expect(convert.toTopLevel("{}")).toEqual({});
        const stamped = convert.toTopLevel(
            JSON.stringify({ at: "2026-11-10T12:00:00.000Z" }),
        ) as { at: unknown };
        expect(stamped.at).toBeInstanceOf(Date);
        expect(() =>
            convert.toTopLevel(JSON.stringify({ other: true })),
        ).toThrow();
    });
});
