// With --prefer-const-values a single-value enum is written as its value, so
// a top-level of one value needs an alias of its own.

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

const justTypes = { "just-types": true };

test("declares a single-value top-level as its value", async () => {
    const output = await renderSchema(
        "typescript",
        { type: "string", const: "OK", description: "Always OK." },
        { ...justTypes, "prefer-const-values": true },
    );
    expect(output).toContain('export type TopLevel = "OK";');
    expect(output.match(/Always OK/g)).toHaveLength(1);
});
