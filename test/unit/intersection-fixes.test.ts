// Intersections (`allOf`) of JSON Schema types.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderTypeScript(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: "typescript",
        rendererOptions: { "just-types": true },
    });
    return result.lines.join("\n");
}

function object(
    properties: Record<string, object | boolean>,
    required: string[],
): object {
    return { type: "object", properties, required };
}

describe("an intersection of types without values in common", () => {
    test("types a required property like a `false` schema", async () => {
        const intersected = await renderTypeScript(
            object(
                {
                    a: { allOf: [{ type: "string" }, { type: "integer" }] },
                },
                ["a"],
            ),
        );
        expect(intersected).toContain("    a: unknown;");
        expect(intersected).toBe(
            await renderTypeScript(object({ a: false }, ["a"])),
        );
    });

    test("types a property both objects require", async () => {
        const output = await renderTypeScript({
            allOf: [
                object({ a: { type: "string" } }, ["a"]),
                object({ a: { type: "integer" } }, ["a"]),
            ],
        });
        expect(output).toContain("    a: unknown;");
    });

    test("types an optional property", async () => {
        const output = await renderTypeScript({
            allOf: [
                object({ a: { type: "string" }, b: { type: "boolean" } }, []),
                object({ a: { type: "integer" } }, []),
            ],
        });
        expect(output).toContain("    a?: unknown;");
        expect(output).toContain("    b?: boolean;");
    });

    test("is left out of a union", async () => {
        const output = await renderTypeScript({
            oneOf: [
                { type: "boolean" },
                { allOf: [{ type: "string" }, { type: "integer" }] },
            ],
        });
        expect(output).toContain("type TopLevel = boolean;");
    });

    test("is any value at the top level, like a `false` schema", async () => {
        const output = await renderTypeScript({
            allOf: [{ type: "string" }, { type: "integer" }],
        });
        expect(output).toContain("type TopLevel = unknown;");
    });
});
