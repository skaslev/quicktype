// The comments at the top of a Swift file say how to parse each top-level.

import {
    InputData,
    JSONSchemaInput,
    type RendererOptions,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";
import { describe, expect, test } from "vitest";

async function renderSwift(
    schema: object,
    rendererOptions: RendererOptions = {},
): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });

    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: "swift",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const point = {
    type: "object",
    properties: { x: { type: "integer" } },
    required: ["x"],
};
const convenienceUsage = "//   let topLevel = try TopLevel(json)";
const decoderUsage =
    "//   let topLevel = try? JSONDecoder().decode(TopLevel.self, from: jsonData)";

describe("Swift usage comments", () => {
    test.each([
        ["a union", { oneOf: [{ type: "string" }, point] }],
        ["a nullable class", { oneOf: [point, { type: "null" }] }],
        ["a string", { type: "string" }],
    ])("decode %s, which has no convenience initializers", async (_, schema) => {
        const output = await renderSwift(schema);

        expect(output).toContain(decoderUsage);
        expect(output).not.toContain(convenienceUsage);
        expect(output).not.toContain("extension TopLevel {");
    });

    test.each([
        ["a class", point],
        ["an array", { type: "array", items: point }],
        ["a map", { type: "object", additionalProperties: point }],
    ])("use the convenience initializers of %s", async (_, schema) => {
        const output = await renderSwift(schema);

        expect(output).toContain(convenienceUsage);
        expect(output).toContain("init(_ json: String");
    });

    test("aren't emitted for plain types, which aren't Codable", async () => {
        const output = await renderSwift(
            { type: "array", items: point },
            { "just-types": "true" },
        );

        expect(output).not.toContain("Codable");
        expect(output).toContain(
            "// This file was generated from JSON Schema using quicktype, do not modify it directly.",
        );
        expect(output).not.toContain("To parse the JSON");
        expect(output).not.toContain("let topLevel =");
    });
});
