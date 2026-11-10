// Haskell just-types output declares the module and its imports, but no Aeson
// code.

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

const nullableString = { oneOf: [{ type: "string" }, { type: "null" }] };

test("declares the module and imports, but no Aeson code", async () => {
    const output = await renderSchema("haskell", nullableString, {
        ...justTypes,
        module: "My.Types",
    });
    expect(output).toContain("module My.Types");
    expect(output).toContain("import Data.Text (Text)");
    expect(output).not.toContain("decodeTopLevel");
});
