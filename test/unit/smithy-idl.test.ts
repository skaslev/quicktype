// Smithy output is valid IDL: identifiers, doc comments, list shapes for
// nested arrays, and the alloy traits it uses.

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

test("declares nullable top-levels", async () => {
    expect(await renderSchema("smithy4a", nullableString, justTypes)).toContain(
        "string TopLevel",
    );
    expect(await renderSchema("smithy4a", nullableObject, justTypes)).toContain(
        "structure TopLevel {",
    );
});

describe("Smithy IDL", () => {
    const schema = {
        type: "object",
        properties: {
            "replication-offset": { type: "integer", description: "Offset." },
            state: { enum: ["caching-yes", "caching-no"] },
            value: { oneOf: [{ type: "string" }, { type: "integer" }] },
            groups: {
                type: "array",
                items: { type: "array", items: { type: "string" } },
            },
        },
        required: ["replication-offset"],
        additionalProperties: false,
    };

    test("emits valid identifiers, doc comments and alloy imports", async () => {
        const output = await renderSchema("smithy4a", schema, justTypes);
        expect(output).toContain(
            '@required @jsonName("replication-offset") replication_offset : Long',
        );
        expect(output).toContain('caching_yes = "caching-yes"');
        expect(output).toContain("/// Offset.");
        expect(output).not.toContain("/**");
        expect(output).toContain("use alloy#untagged");
    });

    test("defines nested list shapes", async () => {
        const output = await renderSchema("smithy4a", schema, justTypes);
        const referenced = [...output.matchAll(/member: (\w+List\d*)/g)].map(
            (m) => m[1],
        );
        for (const name of referenced) {
            expect(output).toMatch(new RegExp(`^list ${name} `, "m"));
        }
    });
});
