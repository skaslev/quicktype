// Unions, enums and stringified numbers are transformed types in C#: the
// type graph holds their JSON source type, and the C# type is the
// transformation's target.  The items of a nullable array or map have to
// be rendered as that target too, not as `object` or `string`.

import { describe, expect, test } from "vitest";

import {
    InputData,
    JSONSchemaInput,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";

async function renderCSharp(
    schema: object,
    framework: "NewtonSoft" | "SystemTextJson",
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
        lang: "csharp",
        rendererOptions: { framework },
    });
    return result.lines.join("\n");
}

const union = { oneOf: [{ type: "string" }, { type: "integer" }] };

describe("C# nullable arrays and maps of transformed types", () => {
    for (const framework of ["NewtonSoft", "SystemTextJson"] as const) {
        test(`${framework}: properties`, async () => {
            const output = await renderCSharp(
                {
                    type: "object",
                    properties: {
                        unions: { type: ["array", "null"], items: union },
                        unionMap: {
                            type: ["object", "null"],
                            additionalProperties: union,
                        },
                        kinds: {
                            type: ["array", "null"],
                            items: { title: "Kind", enum: ["a", "b"] },
                        },
                        counts: {
                            oneOf: [
                                { type: "null" },
                                {
                                    type: "array",
                                    items: {
                                        type: "string",
                                        format: "integer",
                                    },
                                },
                            ],
                        },
                    },
                    required: ["unions", "unionMap", "kinds", "counts"],
                },
                framework,
            );
            const properties = Object.fromEntries(
                [...output.matchAll(/public (.+) (\w+) \{ get; set; \}/g)].map(
                    (m) => [m[2], m[1]],
                ),
            );
            expect(properties).toEqual({
                Unions: "Union[]?",
                UnionMap: "Dictionary<string, Union>?",
                Kinds: "Kind[]?",
                Counts: "long[]?",
            });
        });

        test(`${framework}: top-level array of nullable arrays of a recursive union`, async () => {
            // Like Redis COMMAND INFO before tuples: `(R[] | null)[]` with
            // `R = string | R[]`.
            const output = await renderCSharp(
                {
                    type: "array",
                    items: {
                        oneOf: [
                            { type: "null" },
                            {
                                type: "array",
                                items: { $ref: "#/definitions/R" },
                            },
                        ],
                    },
                    definitions: {
                        R: {
                            oneOf: [
                                { type: "string" },
                                {
                                    type: "array",
                                    items: { $ref: "#/definitions/R" },
                                },
                            ],
                        },
                    },
                },
                framework,
            );
            expect(output).toMatch(
                /public static R\[\]\?\[\] FromJson\(string json\)/,
            );
            expect(output).toMatch(
                /public static string ToJson\(this R\[\]\?\[\] self\)/,
            );
        });
    }
});
