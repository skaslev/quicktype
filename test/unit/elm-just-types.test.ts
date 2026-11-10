// Elm just-types output is a module of its own: it declares the module and
// its imports, and wraps recursive records in a custom type.

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

const recursiveSchema = {
    $ref: "#/definitions/Node",
    definitions: {
        Node: {
            type: "object",
            properties: {
                name: { type: "string" },
                children: {
                    type: "array",
                    items: { $ref: "#/definitions/Node" },
                },
            },
            required: ["name"],
            additionalProperties: false,
        },
    },
};

test("declares the module and its imports", async () => {
    const output = await renderSchema("elm", nullableString, {
        ...justTypes,
        module: "My.Types",
    });
    expect(output).toContain("module My.Types exposing (..)");
    expect(output).toContain("import Dict exposing (Dict)");
});

test("wraps recursive records in a custom type", async () => {
    const output = await renderSchema("elm", recursiveSchema, justTypes);
    expect(output).toMatch(/type TopLevel =\s+TopLevel\s+\{/);
    expect(output).not.toContain("type alias TopLevel");
});
