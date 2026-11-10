// Python's converters check a union member's type with is_type(t, x), i.e.
// isinstance.  For arrays that must be the builtin `list`: typing's `List`
// isn't imported in Python 3.5 output, which has no type hints.

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
        lang: "python",
        rendererOptions,
    });
    return result.lines.join("\n");
}

// A union with a transformed member is converted with is_type checks.
const schema = {
    type: "object",
    properties: {
        v: {
            oneOf: [
                { type: "array", items: { type: "string" } },
                { type: "string", format: "integer" },
            ],
        },
    },
    required: ["v"],
    additionalProperties: false,
};

test.each([
    "3.5",
    "3.6",
    "3.7",
])("Python %s checks arrays with the builtin list", async (version) => {
    const output = await renderSchema(schema, { "python-version": version });
    expect(output).toContain("is_type(list, ");
    expect(output).not.toContain("is_type(List, ");
});
