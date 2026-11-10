// Effect Schema classes are emitted after the classes they refer to, so
// only references around a cycle are forward references, which need
// `S.suspend`.  The order used to be a heuristic that missed references
// through unions and placed a class after the classes it depended on
// rather than before the ones depending on it.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { expect, test } from "vitest";

async function renderSchema(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: "typescript-effect-schema",
    });
    return result.lines.join("\n");
}

function object(properties: Record<string, object>): object {
    return {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
    };
}

function classOrder(output: string): string[] {
    return Array.from(
        output.matchAll(/^export class (\w+) /gm),
        (match) => match[1],
    );
}

// `Variants` is reached after `Source`, which it refers to, but `Image`
// refers to it.
test.each([
    ["directly", { $ref: "#/$defs/variants" }, "Variants"],
    [
        "through an array of a union",
        {
            type: "array",
            items: {
                anyOf: [{ $ref: "#/$defs/variants" }, { type: "string" }],
            },
        },
        "S.Array(S.Union(S.String, Variants))",
    ],
])("a class comes before the classes that refer to it: %s", async (_, variants, expected) => {
    const output = await renderSchema({
        ...object({ image: { $ref: "#/$defs/image" } }),
        $defs: {
            image: object({ source: { $ref: "#/$defs/source" }, variants }),
            variants: object({ gif: { $ref: "#/$defs/source" } }),
            source: object({ url: { type: "string" } }),
        },
    });
    expect(classOrder(output)).toEqual([
        "Source",
        "Variants",
        "Image",
        "TopLevel",
    ]);
    expect(output).toContain(`"variants": ${expected},`);
    expect(output).not.toContain("S.suspend");
});

test("a reference around a cycle is suspended", async () => {
    const output = await renderSchema({
        ...object({ node: { $ref: "#/$defs/node" } }),
        $defs: {
            node: object({
                children: {
                    type: "array",
                    items: { $ref: "#/$defs/node" },
                },
                leaf: { $ref: "#/$defs/leaf" },
            }),
            leaf: object({ value: { type: "string" } }),
        },
    });
    expect(classOrder(output)).toEqual(["Leaf", "Node", "TopLevel"]);
    expect(output).toContain(
        '"children": S.Array(S.suspend((): S.Schema<Node, NodeEncoded> => Node)),',
    );
    expect(output).toContain('"leaf": Leaf,');
    expect(output).toContain('"node": Node,');
});
