// A C++ class member hides the type of the same name in the rest of the
// class, so members aren't named like types, even when the type and member
// naming styles are the same.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function render(
    rendererOptions: Record<string, string | boolean>,
): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "Top",
        schema: JSON.stringify({
            type: "object",
            properties: {
                point: { $ref: "#/definitions/Point" },
                kind: { enum: ["a", "b"] },
                top: { type: "string" },
            },
            required: ["point", "kind", "top"],
            additionalProperties: false,
            definitions: {
                Point: {
                    type: "object",
                    properties: { x: { type: "integer" } },
                    required: ["x"],
                    additionalProperties: false,
                },
            },
        }),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: "cplusplus",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const sameStyles = {
    "type-style": "pascal-case",
    "member-style": "pascal-case",
};

describe("C++ member names", () => {
    for (const codeFormat of ["with-struct", "with-getter-setter"]) {
        test(`aren't type names with the same styles, ${codeFormat}`, async () => {
            const output = await render({
                ...sameStyles,
                "code-format": codeFormat,
            });
            for (const type of ["Point", "Kind"]) {
                expect(output).not.toMatch(
                    new RegExp(`^ *${type} ${type};$`, "m"),
                );
                expect(output).toMatch(
                    new RegExp(`^ *${type} Top${type};$`, "m"),
                );
            }
            expect(output).not.toMatch(/^ *std::string Top;$/m);
        });
    }

    test("are unchanged with the default styles", async () => {
        const output = await render({ "code-format": "with-struct" });
        expect(output).toMatch(/^ *Point point;$/m);
        expect(output).toMatch(/^ *Kind kind;$/m);
        expect(output).toMatch(/^ *std::string top;$/m);
    });
});
