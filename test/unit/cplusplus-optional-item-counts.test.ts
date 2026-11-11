// C++ classes check `minItems` and `maxItems` of their array properties in
// from_json with `j.at(key).size()`, which throws when an optional
// property is absent.  The checks only apply to properties that are present.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function render(
    schema: object,
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
        lang: "cplusplus",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const counted = {
    type: "object",
    properties: {
        xs: {
            type: "array",
            items: { type: "integer" },
            minItems: 1,
            maxItems: 3,
        },
        ys: { type: "array", items: { type: "string" }, maxItems: 2 },
    },
    required: ["ys"],
    additionalProperties: false,
};

describe("C++ item counts of array properties", () => {
    test.each([
        "with-getter-setter",
        "with-struct",
    ])("are checked if an optional property is present (%s)", async (codeFormat) => {
        const output = await render(counted, { "code-format": codeFormat });
        expect(output).toContain(
            'if (j.find("xs") != j.end() && j.at("xs").size() < 1) throw std::runtime_error("Too few items");',
        );
        expect(output).toContain(
            'if (j.find("xs") != j.end() && j.at("xs").size() > 3) throw std::runtime_error("Too many items");',
        );
    });

    test("are checked for required properties", async () => {
        const output = await render(counted);
        expect(output).toContain(
            'if (j.at("ys").size() > 2) throw std::runtime_error("Too many items");',
        );
    });
});
