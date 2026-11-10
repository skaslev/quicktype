// Haskell output imports Data.Aeson unqualified, so generated types must not
// take names it exports, or uses of them are ambiguous.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { expect, test } from "vitest";

async function renderSchema(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({ inputData, lang: "haskell" });
    return result.lines.join("\n");
}

const object = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
};

test.each([
    "Key",
    "One",
    "Zero",
])("doesn't declare a type named %s", async (name) => {
    const output = await renderSchema({
        type: "object",
        properties: { [name.toLowerCase()]: object },
        required: [name.toLowerCase()],
        additionalProperties: false,
    });
    expect(output).not.toMatch(new RegExp(`^data ${name}\\b`, "m"));
});
