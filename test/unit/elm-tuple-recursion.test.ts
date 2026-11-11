// Elm decoders are values, and Elm rejects a value that is defined in terms
// of itself, so the decoder of a union that contains itself decodes that
// member lazily.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
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

    const result = await quicktype({ inputData, lang: "elm", rendererOptions });
    return result.lines.join("\n");
}

// A string, or an array of these.
const recursiveUnion = {
    $ref: "#/$defs/node",
    $defs: {
        node: {
            anyOf: [
                { type: "string" },
                { type: "array", items: { $ref: "#/$defs/node" } },
            ],
        },
    },
};

describe("recursive unions", () => {
    test("are decoded lazily where they contain themselves", async () => {
        const output = await renderSchema(recursiveUnion);
        expect(output).toContain(
            "Jdec.map UnionArrayInTopLevel (Jdec.lazy (\\_ -> Jdec.list topLevel ))",
        );
        expect(output).toContain("Jdec.map StringInTopLevel Jdec.string");
    });

    test("other unions are decoded as before", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                x: {
                    anyOf: [
                        { type: "string" },
                        { type: "array", items: { type: "integer" } },
                    ],
                },
            },
            required: ["x"],
        });
        expect(output).toContain(
            "Jdec.map IntegerArrayInX (Jdec.list Jdec.int )",
        );
        expect(output).not.toContain("Jdec.lazy");
    });
});
