// TypeScript keeps the arrays of JSON Schema array schemas apart in unions,
// as `A[] | B[]`, if their item types can be told apart, and the converter
// checks every element of a value against the items of each array, to take
// it for the array it's of.

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

function roundTrip(convert: Converter, value: unknown): unknown {
    return JSON.parse(
        convert.topLevelToJson(convert.toTopLevel(JSON.stringify(value))),
    );
}

function arrayOf(items: object): object {
    return { type: "array", items };
}

const membersOrScores = {
    anyOf: [
        arrayOf({ type: "string" }),
        arrayOf({
            title: "MemberScore",
            type: "object",
            properties: {
                member: { type: "string" },
                score: { type: "number" },
            },
            required: ["member", "score"],
            additionalProperties: false,
        }),
    ],
};

describe("types", () => {
    test("a union of arrays", async () => {
        const output = await renderSchema(membersOrScores, {
            "just-types": true,
            "explicit-unions": true,
        });
        expect(output).toContain(
            "export type TopLevel = string[] | MemberScore[];",
        );
    });

    test("an inline union of arrays", async () => {
        const output = await renderSchema(
            {
                type: "object",
                properties: { reply: membersOrScores },
                required: ["reply"],
                additionalProperties: false,
            },
            { "just-types": true },
        );
        expect(output).toContain("    reply: string[] | MemberScore[];");
    });
});

describe("converter", () => {
    test("checks every element against each array's items", async () => {
        const convert = await loadConverter(membersOrScores);
        for (const value of [["a", "b"], [{ member: "a", score: 1.5 }], []]) {
            expect(roundTrip(convert, value)).toEqual(value);
        }

        for (const value of [
            ["a", { member: "b", score: 1 }],
            [{ member: "a", score: 1 }, "b"],
            [1],
        ]) {
            expect(() => convert.toTopLevel(JSON.stringify(value))).toThrow();
        }
    });

    test("checks nested arrays", async () => {
        const convert = await loadConverter({
            oneOf: [
                arrayOf(arrayOf({ type: "string" })),
                arrayOf(arrayOf({ type: "integer" })),
            ],
        });
        for (const value of [[["a"], []], [[1, 2]], [[], []]]) {
            expect(roundTrip(convert, value)).toEqual(value);
        }

        expect(() => convert.toTopLevel('[["a"], [1]]')).toThrow();
    });

    // The converter checks other empty classes as any object.
    test("takes only empty objects for an empty class", async () => {
        const convert = await loadConverter({
            oneOf: [
                arrayOf({ type: "object", additionalProperties: false }),
                arrayOf({
                    type: "object",
                    properties: {
                        at: { type: "string", format: "date-time" },
                    },
                    required: ["at"],
                    additionalProperties: false,
                }),
            ],
        });
        expect(convert.toTopLevel("[{}, {}]")).toEqual([{}, {}]);
        const stamped = convert.toTopLevel(
            JSON.stringify([{ at: "2026-11-10T12:00:00.000Z" }]),
        ) as Array<{ at: unknown }>;
        expect(stamped[0].at).toBeInstanceOf(Date);
        expect(() => convert.toTopLevel('[{"other": true}]')).toThrow();
    });
});
