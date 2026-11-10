// Rust union declarations leave out null; references add it back as
// Option<...>.  A top-level union of null and two or more other types is
// therefore an alias that adds the null back.

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

test("a top-level union with null is an Option alias", async () => {
    const output = await renderSchema("rust", {
        oneOf: [{ type: "null" }, { type: "integer" }, { type: "string" }],
    });
    expect(output).toContain("pub type TopLevel = Option<TopLevelUnion>;");
    expect(output).toContain("pub enum TopLevelUnion {");
});
