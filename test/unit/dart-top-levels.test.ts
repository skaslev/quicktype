// Dart declares typedefs for top-levels that aren't classes.

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
    expect(await renderSchema("dart", nullableString, justTypes)).toContain(
        "typedef TopLevel = String?;",
    );
    expect(await renderSchema("dart", nullableObject, justTypes)).toContain(
        "typedef TopLevel = User?;",
    );
});

test("doesn't name the class after a nullable top-level", async () => {
    const output = await renderSchema("dart", nullableObject, justTypes);
    expect(output).toContain("class User {");
    expect(output).not.toContain("class TopLevel");
});
