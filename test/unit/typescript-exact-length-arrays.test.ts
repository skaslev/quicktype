// An array with minItems >= 1 renders as a tuple of the guaranteed elements
// and a rest; one of exactly minItems == maxItems elements has no rest.

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

const justTypes = { "just-types": true };

test.each([
    [{ minItems: 2 }, "export type TopLevel = [number, number, ...number[]];"],
    [{ minItems: 2, maxItems: 2 }, "export type TopLevel = [number, number];"],
    [
        { minItems: 1, maxItems: 3 },
        "export type TopLevel = [number, ...number[]];",
    ],
] as const)("%o", async (bounds, expected) => {
    const schema = { type: "array", items: { type: "integer" }, ...bounds };
    expect(await renderSchema("typescript", schema, justTypes)).toContain(
        expected,
    );
});
