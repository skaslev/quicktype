// Smithy lists and maps are separate shapes, named after the property they
// come from.  A nested list has the same combined name as its parent, so
// `string[][]` came out as `list aList { member: aList }`, a list of
// itself; nested lists of top-level arrays and of unions, nullable arrays,
// and arrays in maps were referenced but never defined; and properties of
// the same name with different array types shared one shape.

import { describe, expect, test } from "vitest";

import {
    InputData,
    JSONSchemaInput,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";

async function renderSmithy(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: "smithy4a",
        rendererOptions: { package: "p" },
    });
    return result.lines.join("\n");
}

function collections(output: string): string[] {
    return output
        .split("\n")
        .filter((l) => /^(list|map) /.test(l))
        .map((l) => l.replace(/\s+/g, " "));
}

const strings = { type: "array", items: { type: "string" } };

describe("Smithy list and map shapes", () => {
    test("nested lists", async () => {
        const output = await renderSmithy({
            type: "object",
            properties: {
                a: { type: "array", items: strings },
                b: {
                    type: "array",
                    items: { type: "array", items: { type: "integer" } },
                },
                c: { type: "array", items: { type: "array", items: strings } },
            },
            required: ["a", "b", "c"],
        });
        expect(output).toContain("@required a : aList,");
        expect(output).toContain("@required b : bList,");
        expect(output).toContain("@required c : cList");
        expect(collections(output)).toEqual([
            "list aList { member: aList2 }",
            "list bList { member: bList2 }",
            "list cList { member: aList }",
            "list aList2 { member: String }",
            "list bList2 { member: Long }",
        ]);
    });

    test("a top-level list of lists", async () => {
        const output = await renderSmithy({ type: "array", items: strings });
        expect(collections(output)).toEqual([
            "list TopLevel { member : TopLevelList}",
            "list TopLevelList { member: String }",
        ]);
    });

    test("lists in unions and maps, and nullable lists", async () => {
        const output = await renderSmithy({
            type: "object",
            properties: {
                u: {
                    oneOf: [
                        { type: "string" },
                        {
                            type: "array",
                            items: {
                                type: "array",
                                items: { type: "integer" },
                            },
                        },
                    ],
                },
                m: { type: "object", additionalProperties: strings },
                n: { type: ["array", "null"], items: { type: "boolean" } },
            },
            required: ["u", "m", "n"],
        });
        expect(collections(output)).toEqual([
            "map mMap { key: String, value: mList }",
            "list nList { member: Boolean }",
            "list uList { member: uList2 }",
            "list mList { member: String }",
            "list uList2 { member: Long }",
        ]);
    });

    test("properties of the same name", async () => {
        const output = await renderSmithy({
            type: "object",
            properties: {
                items: strings,
                inner: {
                    type: "object",
                    properties: {
                        items: { type: "array", items: { type: "integer" } },
                    },
                    required: ["items"],
                },
            },
            required: ["items", "inner"],
        });
        expect(collections(output)).toEqual([
            "list itemsList { member: String }",
            "list itemsList2 { member: Long }",
        ]);
    });
});
