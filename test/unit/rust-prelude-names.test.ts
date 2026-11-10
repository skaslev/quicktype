// Enum variants and cases live in their enum's namespace, so they may be
// named after std prelude types such as String.

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

test("union variants may be named after prelude types", async () => {
    const output = await renderSchema("rust", {
        type: "array",
        items: { oneOf: [{ type: "string" }, { type: "integer" }] },
    });
    expect(output).toContain("    String(String),");
});
