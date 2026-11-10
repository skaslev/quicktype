// In just-types mode a top-level enum takes the top-level name; otherwise the
// name goes to the class with the FromJson converter.

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

describe("C# top-level enums", () => {
    const ok = { type: "string", const: "OK" };

    test("take the top-level name in just-types mode", async () => {
        expect(await renderSchema("csharp", ok, justTypes)).toContain(
            "public enum TopLevel { Ok };",
        );
    });

    test("leave it to the FromJson class otherwise", async () => {
        const output = await renderSchema("csharp", ok);
        expect(output).toContain("public enum TopLevelEnum { Ok };");
        expect(output).toContain("public class TopLevel");
    });
});
