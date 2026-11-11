// A union member that is an array or a map is named after its items'
// type.  In C#, unions, enums and stringified numbers are transformed
// types, which the type graph holds as their JSON source type, so the
// names have to come from the transformation's target type: an array of
// unions was named `AnythingArray`, an array of enums `StringArray`.

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

function unionMembers(output: string): string[] {
    return [...output.matchAll(/^ {8}public (.+) (\w+);$/gm)].map(
        (m) => `${m[1]} ${m[2]}`,
    );
}

describe("C# union member names of arrays and maps", () => {
    for (const framework of ["NewtonSoft", "SystemTextJson"] as const) {
        test(`${framework}: a recursive union`, async () => {
            const output = await renderCSharp(
                {
                    $ref: "#/definitions/R",
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
            expect(unionMembers(output)).toEqual([
                "string? String",
                "TopLevelElement[]? UnionArray",
            ]);
        });

        test(`${framework}: arrays and maps of transformed types`, async () => {
            const withBool = (other: object) => ({
                oneOf: [{ type: "boolean" }, other],
            });
            const output = await renderCSharp(
                {
                    type: "object",
                    properties: {
                        kinds: withBool({
                            type: "array",
                            items: { title: "Kind", enum: ["x", "y"] },
                        }),
                        unions: withBool({
                            type: "object",
                            additionalProperties: {
                                title: "Value",
                                oneOf: [
                                    { type: "string" },
                                    { type: "integer" },
                                ],
                            },
                        }),
                        counts: withBool({
                            type: "array",
                            items: { type: "string", format: "integer" },
                        }),
                    },
                    required: ["kinds", "unions", "counts"],
                },
                framework,
            );
            expect(unionMembers(output)).toEqual(
                expect.arrayContaining([
                    "Kind[]? EnumArray",
                    "Dictionary<string, Value>? UnionMap",
                    "long[]? IntegerArray",
                ]),
            );
            expect(output).not.toMatch(/Anything|StringArray/);
        });
    }
});
