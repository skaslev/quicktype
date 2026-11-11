// Objective-C declares marshaling functions for a top level that isn't a
// class, and pads the return types `NSData` and `NSString` to the length
// of the top level's name.  A name shorter than those (`QTTop`) used to
// fail with "Cannot repeat a string a negative number of times".

import { describe, expect, test } from "vitest";

import {
    InputData,
    JSONSchemaInput,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";

async function renderObjectiveC(name: string, schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({ name, schema: JSON.stringify(schema) });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({ inputData, lang: "objective-c" });
    return result.lines.join("\n");
}

const unionArray = {
    type: "array",
    items: { oneOf: [{ type: "string" }, { type: "integer" }] },
};

describe("Objective-C top-level functions", () => {
    for (const [what, schema] of [
        ["an array of a union", unionArray],
        ["an array", { type: "array", items: { type: "string" } }],
        ["a union", { oneOf: [{ type: "string" }, { type: "integer" }] }],
    ] as const) {
        test(`${what} with a short name`, async () => {
            const output = await renderObjectiveC("Top", schema);
            expect(output).toContain(
                "NSData *_Nullable QTTopToData(QTTop *top, NSError **error);",
            );
            expect(output).toContain(
                "NSString *_Nullable QTTopToJSON(QTTop *top, NSStringEncoding encoding, NSError **error);",
            );
        });
    }

    test("a long name still aligns the return types", async () => {
        const output = await renderObjectiveC("TopLevel", unionArray);
        expect(output).toContain(
            "QTTopLevel *_Nullable QTTopLevelFromData(NSData *data, NSError **error);",
        );
        expect(output).toContain(
            "NSData     *_Nullable QTTopLevelToData(QTTopLevel *topLevel, NSError **error);",
        );
        expect(output).toContain(
            "NSString   *_Nullable QTTopLevelToJSON(QTTopLevel *topLevel, NSStringEncoding encoding, NSError **error);",
        );
    });
});
