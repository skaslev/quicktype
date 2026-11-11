// Go tags optional union properties with `omitempty` unless the union is
// nullable.  A union without null is a pointer to its struct, which is only
// nil if the property is absent, so it stays absent when the value is
// encoded again, instead of becoming null.  A nullable union, like any
// nullable property, is nil both when absent and when null, and keeps
// writing null.

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

    const result = await quicktype({ inputData, lang: "go", rendererOptions });
    return result.lines.join("\n");
}

const unions = {
    type: "object",
    properties: {
        value: { oneOf: [{ type: "string" }, { type: "integer" }] },
        shape: {
            oneOf: [
                { type: "boolean" },
                { type: "array", items: { type: "integer" } },
                {
                    type: "object",
                    properties: { x: { type: "integer" } },
                    required: ["x"],
                },
            ],
        },
        required: { oneOf: [{ type: "boolean" }, { type: "number" }] },
        nullable: {
            oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }],
        },
        nullableString: { type: ["string", "null"] },
    },
    required: ["required"],
};

describe("Go omitempty for unions", () => {
    for (const [mode, options] of [
        ["full", {}],
        ["just-types-and-package", { "just-types-and-package": true }],
        ["omit-empty", { "omit-empty": true }],
    ] as const) {
        test(`optional unions without null, ${mode}`, async () => {
            const output = await renderSchema(unions, options);
            expect(output).toMatch(/Value +\*\w+ +`json:"value,omitempty"`/);
            expect(output).toMatch(/Shape +\*\w+ +`json:"shape,omitempty"`/);
            expect(output).toMatch(/Required +\*\w+ +`json:"required"`/);
            expect(output).toMatch(/Nullable +\*\w+ +`json:"nullable"`/);
            expect(output).toMatch(
                /NullableString +\*string +`json:"nullableString"`/,
            );
        });
    }
});
