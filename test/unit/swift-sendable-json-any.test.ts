// With `--sendable`, types that hold a `JSONAny` are Sendable, so JSONAny
// has to be, too.

import {
    InputData,
    JSONSchemaInput,
    type RendererOptions,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";
import { describe, expect, test } from "vitest";

async function renderSwift(rendererOptions: RendererOptions): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify({
            type: "object",
            properties: { value: {} },
            required: ["value"],
        }),
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

describe("Swift's JSONAny", () => {
    test("is final and Sendable with --sendable", async () => {
        const output = await renderSwift({ sendable: "true" });

        expect(output).toContain("struct TopLevel: Codable, Sendable {");
        expect(output).toContain(
            "final class JSONAny: Codable, @unchecked Sendable {",
        );
        expect(output).toContain("final class JSONCodingKey: CodingKey {");
    });

    test("is a final and Sendable NSObject with --objective-c-support", async () => {
        const output = await renderSwift({
            sendable: "true",
            "struct-or-class": "class",
            "objective-c-support": "true",
        });

        expect(output).toContain(
            "@objcMembers final class JSONAny: NSObject, Codable, @unchecked Sendable {",
        );
        expect(output).toContain("final class JSONCodingKey: CodingKey {");
    });

    test("is neither without --sendable", async () => {
        const output = await renderSwift({});

        expect(output).toContain("\nclass JSONAny: Codable {");
        expect(output).toContain("\nclass JSONCodingKey: CodingKey {");
    });
});
