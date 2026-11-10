// cJSON stores nullable top-level numbers, bools and enums behind a pointer,
// which is NULL for null.

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

test("nullable top-level numbers are allocated, and NULL for null", async () => {
    const output = await renderSchema("cjson", {
        oneOf: [{ type: "integer" }, { type: "null" }],
    });
    expect(output).toContain("int64_t * value;");
    expect(output).toContain(
        "if (NULL != (x->value = cJSON_malloc(sizeof(int64_t))))",
    );
    expect(output).toContain("*x->value = cJSON_GetNumberValue(j);");
    expect(output).toContain(
        "j = NULL != x->value ? cJSON_CreateNumber(*x->value) : cJSON_CreateNull();",
    );
    expect(output).toContain("cJSON_free(x->value);");
});
