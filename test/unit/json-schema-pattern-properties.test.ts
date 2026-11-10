// An object schema with only `patternProperties` (and no other properties) is
// a map from strings to the pattern's type.

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

const patternMap = {
    type: "object",
    additionalProperties: false,
    patternProperties: { "^.*$": { type: "integer" } },
};

test.each([
    [
        "typescript",
        justTypes,
        "export type TopLevel = { [key: string]: number };",
    ],
    ["go", justTypes, "type TopLevel map[string]int64"],
    [
        "cplusplus",
        justTypes,
        "using TopLevel = std::map<std::string, int64_t>;",
    ],
    ["rust", {}, "pub type TopLevel = HashMap<String, i64>;"],
] as const)("%s maps an object with only patternProperties", async (lang, options, expected) => {
    expect(await renderSchema(lang, patternMap, options)).toContain(expected);
});
