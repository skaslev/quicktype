// Pike converts arrays of arrays element-wise.

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

test("converts arrays of arrays element-wise", async () => {
    const output = await renderSchema("pike", {
        type: "array",
        items: { type: "array", items: { $ref: "#/definitions/Item" } },
        definitions: {
            Item: {
                type: "object",
                properties: { a: { type: "string" } },
                additionalProperties: false,
            },
        },
    });
    expect(output).toContain("map(v, Item_from_JSON)");
    expect(output).not.toContain("array(Item)_from_JSON");
});
