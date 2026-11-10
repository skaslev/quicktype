// Python declares type aliases for top-levels that aren't classes.

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
    expect(await renderSchema("python", nullableString, justTypes)).toContain(
        "TopLevel = str | None",
    );
    expect(await renderSchema("python", nullableObject, justTypes)).toContain(
        "TopLevel = User | None",
    );
});

test("doesn't declare aliases without type hints (Python 3.5)", async () => {
    const output = await renderSchema("python", nullableString, {
        "python-version": "3.5",
    });
    expect(output).not.toContain("TopLevel =");
    expect(output).not.toContain("Optional");
});
