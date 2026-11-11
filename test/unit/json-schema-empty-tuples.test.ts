// A tuple schema becomes an array of the union of its item types.  An empty
// one (`items: []`, `prefixItems: []`) has no item types, and quicktype
// failed with "Trying to make an empty union" in every target language.  It
// doesn't constrain the array's elements, so they're `any`.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function render(
    schema: object,
    lang: string,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({
        inputData,
        lang,
        rendererOptions,
    });
    return result.lines.join("\n");
}

function withProperty(e: object): object {
    return {
        type: "object",
        properties: { e },
        required: ["e"],
        additionalProperties: false,
    };
}

describe("empty JSON Schema tuples", () => {
    test.each([
        ["items", { type: "array", items: [] }],
        ["prefixItems", { type: "array", prefixItems: [] }],
    ])("are arrays of anything (%s)", async (_, e) => {
        const output = await render(withProperty(e), "typescript", {
            "just-types": true,
        });
        expect(output).toContain("e: unknown[];");
    });

    test("with a rest are arrays of the rest", async () => {
        const output = await render(
            withProperty({
                type: "array",
                prefixItems: [],
                items: { type: "string" },
            }),
            "typescript",
            { "just-types": true },
        );
        expect(output).toContain("e: string[];");
    });

    test("at the top level", async () => {
        const output = await render(
            { type: "array", items: [] },
            "typescript",
            { "just-types": true },
        );
        expect(output).toContain("export type TopLevel = unknown[];");
    });

    test("in C++", async () => {
        const output = await render(
            withProperty({ type: "array", items: [] }),
            "cplusplus",
        );
        expect(output).toContain("std::vector<nlohmann::json> e;");
    });
});
