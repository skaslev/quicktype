// Rust output imports serde only when a declared type derives its traits.

import {
    InputData,
    JSONSchemaInput,
    type LanguageName,
    quicktype,
} from "quicktype-core";
import { expect, test } from "vitest";

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

const nullableObject = {
    oneOf: [
        {
            title: "User",
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
        },
        { type: "null" },
    ],
};

test("files with only aliases don't import serde", async () => {
    const output = await renderSchema("rust", {
        type: "array",
        items: { type: "string" },
    });
    expect(output).toContain("pub type TopLevel = Vec<String>;");
    expect(output).not.toContain("use serde");
});

test("files with structs import serde", async () => {
    const output = await renderSchema("rust", nullableObject.oneOf[0]);
    expect(output).toContain("use serde::{Serialize, Deserialize};");
});
