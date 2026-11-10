// Scala 3 aliases nullable top-levels, and declares NullValue in just-types
// mode, where unions with null use it.

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

test("declares nullable top-levels", async () => {
    expect(await renderSchema("scala3", nullableString, justTypes)).toContain(
        "type TopLevel = Option[String]",
    );
    expect(await renderSchema("scala3", nullableObject, justTypes)).toContain(
        "type TopLevel = Option[User]",
    );
});

test("declares NullValue for unions with null in just-types mode", async () => {
    const output = await renderSchema(
        "scala3",
        { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
        justTypes,
    );
    expect(output).toContain("type NullValue = None.type");
});
