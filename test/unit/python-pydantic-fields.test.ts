// The fields of pydantic models (`--pydantic-base-model`).

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
        lang: "python",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const pydantic = { "pydantic-base-model": true };

describe("from_dict", () => {
    const plain = {
        type: "object",
        properties: {
            name: { type: "string" },
            child: {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
            },
            count: { type: "integer" },
        },
        required: ["name", "child"],
    };

    // BaseModel.__init__ takes no positional arguments.
    test("constructs pydantic models with keyword arguments", async () => {
        const output = await renderSchema(plain, pydantic);
        expect(output).toContain("return Child(label=label)");
        expect(output).toContain(
            "return TopLevel(child=child, name=name, count=count)",
        );
    });

    test("constructs other classes with positional arguments", async () => {
        const output = await renderSchema(plain);
        expect(output).toContain("return Child(label)");
        expect(output).toContain("return TopLevel(child, name, count)");
    });
});
