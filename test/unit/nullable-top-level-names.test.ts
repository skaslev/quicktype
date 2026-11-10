// A nullable top-level (`T | null`) is never declared as a named type, so it
// must not take the top-level name: the name would go undeclared.  Renderers
// declare an alias for such top-levels instead.

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

test.each([
    [
        "cplusplus",
        justTypes,
        "using TopLevel = std::optional<std::string>;",
        "using TopLevel = std::optional<User>;",
    ],
    [
        "rust",
        {},
        "pub type TopLevel = Option<String>;",
        "pub type TopLevel = Option<User>;",
    ],
    [
        "elm",
        justTypes,
        "type alias TopLevel = Maybe String",
        "type alias TopLevel = Maybe User",
    ],
    [
        "haskell",
        justTypes,
        "type TopLevel = Maybe Text",
        "type TopLevel = Maybe User",
    ],
] as const)("%s declares nullable top-levels", async (lang, options, primitive, object) => {
    expect(await renderSchema(lang, nullableString, options)).toContain(
        primitive,
    );
    expect(await renderSchema(lang, nullableObject, options)).toContain(object);
});
