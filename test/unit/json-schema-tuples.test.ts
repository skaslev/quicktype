// JSON Schema tuples (`prefixItems`, or an array-valued `items`) become tuple
// types for targets that can express them.  Every other target gets an array
// of the union of the item types, as before.

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

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
};

describe("targets without tuples", () => {
    // The tuple's array of the union of its items would contain itself
    // through arrays and unions only, which these renderers can't declare.
    test.each([
        ["java", "List<Object>"],
    ] as const)("%s: a tuple's reference to itself becomes any", async (lang, expected) => {
        const output = await renderSchema(lang, {
            type: "object",
            properties: { node: { $ref: "#/$defs/node" } },
            required: ["node"],
            additionalProperties: false,
            $defs: {
                node: {
                    type: "array",
                    items: [
                        { type: "string" },
                        { type: "array", items: { $ref: "#/$defs/node" } },
                    ],
                },
            },
        });
        expect(output).toContain(expected);
    });

    test("get an array of the union of the item types", async () => {
        const output = await renderSchema("kotlin", pair, justTypes);
        expect(output).toContain(
            "typealias TopLevel = ArrayList<TopLevelElement>",
        );
    });

    test("include draft-07 additionalItems in that union", async () => {
        const output = await renderSchema(
            "kotlin",
            {
                type: "array",
                items: [{ type: "string" }],
                additionalItems: { type: "integer" },
            },
            justTypes,
        );
        expect(output).toContain("IntegerValue(val value: Long)");
        expect(output).toContain("StringValue(val value: String)");
    });
});
