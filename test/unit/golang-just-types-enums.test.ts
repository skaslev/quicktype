// Go's just-types modes emit plain types without methods or imports, but
// enums still got an UnmarshalJSON method that calls json.Unmarshal, so
// their output didn't compile ("undefined: json").

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { expect, test } from "vitest";

async function renderGo(
    rendererOptions: Record<string, string | boolean>,
): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify({
            type: "object",
            properties: { role: { enum: ["master", "slave"] } },
            required: ["role"],
            additionalProperties: false,
        }),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({ inputData, lang: "go", rendererOptions });
    return result.lines.join("\n");
}

test.each([
    [{ "just-types": true }],
    [{ "just-types-and-package": true, package: "replies" }],
])("%o: enums have no methods", async (options) => {
    const output = await renderGo(options);
    expect(output).toContain(
        'const (\n\tMaster Role = "master"\n\tSlave  Role = "slave"\n)',
    );
    expect(output).not.toContain("func ");
    expect(output).not.toContain("json.Unmarshal");
});

test("enums still validate their values outside just-types", async () => {
    const output = await renderGo({});
    expect(output).toContain(
        "func (x *Role) UnmarshalJSON(data []byte) error {",
    );
});
