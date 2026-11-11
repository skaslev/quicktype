// The runtime checks of JavaScript, TypeScript and Flow describe the type
// a value failed to match.  For a union containing `null`, or a lone
// `null`, that description itself threw: `prettyTypeName` read
// `null.literal`.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { expect, test } from "vitest";

async function converter(schema: object): Promise<(json: string) => unknown> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);
    const result = await quicktype({ inputData, lang: "javascript" });

    const generatedModule = {
        exports: {} as { toTopLevel?: (json: string) => unknown },
    };
    new Function("module", result.lines.join("\n"))(generatedModule);
    const { toTopLevel } = generatedModule.exports;
    if (toTopLevel === undefined) {
        throw new Error("The converter wasn't exported");
    }

    return toTopLevel;
}

test.each([
    [
        "a nullable property",
        {
            type: "object",
            properties: { x: { type: ["string", "null"] } },
            required: ["x"],
        },
        '{"x":5}',
        'Invalid value for key "x" on TopLevel. Expected one of [null, string] but got 5',
    ],
    [
        "a union with null",
        {
            type: "array",
            items: { type: ["string", "boolean", "null"] },
        },
        "[1]",
        "Invalid value. Expected one of [boolean, null, string] but got 1",
    ],
    [
        "null",
        {
            type: "object",
            properties: { x: { type: "null" } },
            required: ["x"],
        },
        '{"x":1}',
        'Invalid value for key "x" on TopLevel. Expected null but got 1',
    ],
])("a value that isn't %s is reported as invalid", async (_, schema, json, message) => {
    const toTopLevel = await converter(schema);
    expect(() => toTopLevel(json)).toThrow(message);
});
