// Elixir declares a typespec module for each top-level, and just-types output
// doesn't use Jason.

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
    expect(await renderSchema("elixir", nullableString, justTypes)).toContain(
        "@type t :: nil | String.t()",
    );
    expect(await renderSchema("elixir", nullableObject, justTypes)).toContain(
        "@type t :: User.t() | nil",
    );
});

test("just-types enums don't use Jason", async () => {
    const output = await renderSchema(
        "elixir",
        { enum: ["on", "off"] },
        justTypes,
    );
    expect(output).toContain("def decode(value)");
    expect(output).not.toContain("Jason");
});
