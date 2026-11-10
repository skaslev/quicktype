// Effect Schema needs a type annotation on S.suspend for recursive
// references, or TypeScript infers `any` for the schema.

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

test("annotates suspended references", async () => {
    const output = await renderSchema(
        "typescript-effect-schema",
        recursiveSchema,
    );
    expect(output).toContain(
        "S.suspend((): S.Schema<TopLevel, TopLevelEncoded> => TopLevel)",
    );
});
