// Go declares nullable top-levels as pointer types, with converters that take
// the value, and just-types enums without the code that needs encoding/json.

import {
    InputData,
    JSONSchemaInput,
    type LanguageName,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

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

describe("Go top-levels", () => {
    test("nullable primitives and classes", async () => {
        expect(await renderSchema("go", nullableString, justTypes)).toContain(
            "type TopLevel *string",
        );
        expect(await renderSchema("go", nullableObject, justTypes)).toContain(
            "type TopLevel *User",
        );
    });

    test("converters for a nullable top-level don't use a pointer receiver", async () => {
        const output = await renderSchema("go", nullableString);
        expect(output).toContain("type TopLevel *string");
        expect(output).toContain(
            "func MarshalTopLevel(r TopLevel) ([]byte, error)",
        );
        expect(output).not.toContain("func (r *TopLevel) Marshal()");
    });

    test("just-types enums don't emit UnmarshalJSON without its import", async () => {
        const output = await renderSchema(
            "go",
            { enum: ["a", "b"] },
            { "just-types-and-package": true },
        );
        expect(output).not.toContain("UnmarshalJSON");
    });
});
