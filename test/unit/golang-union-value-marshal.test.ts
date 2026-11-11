// Go unions marshal with a value receiver, as time.Time does, so that a
// union value, such as a top-level union returned by UnmarshalTopLevel,
// marshals as the JSON value it holds with json.Marshal, not as a struct of
// its members.  UnmarshalJSON keeps its pointer receiver.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({ inputData, lang: "go" });
    return result.lines.join("\n");
}

describe("Go union marshaling", () => {
    test("a top-level union marshals by value", async () => {
        const output = await renderSchema({
            oneOf: [
                { type: "string" },
                { type: "integer" },
                { type: "array", items: { type: "integer" } },
            ],
        });
        expect(output).toContain(
            "func (x TopLevel) MarshalJSON() ([]byte, error) {",
        );
        expect(output).toContain(
            "func (x *TopLevel) UnmarshalJSON(data []byte) error {",
        );
        expect(output).not.toContain("func (x *TopLevel) MarshalJSON()");
    });

    test("so do the unions of properties", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                value: {
                    oneOf: [
                        { type: "string" },
                        { type: "integer" },
                        { type: "null" },
                    ],
                },
            },
            required: ["value"],
        });
        expect(output).toContain('Value *Value `json:"value"`');
        expect(output).toContain(
            "func (x Value) MarshalJSON() ([]byte, error) {",
        );
        expect(output).toContain(
            "func (x *Value) UnmarshalJSON(data []byte) error {",
        );
    });
});
