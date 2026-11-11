// A JSON Schema tuple the target can't express becomes an array of the union
// of its item types.  If an item refers back to the tuple, that union
// contains itself through arrays and unions only.  Targets that can declare
// such a union (`supportsRecursiveUnions`) keep the reference; the others get
// `any` for it.

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

// Like a Redis COMMAND INFO reply: a node is a name, its leaves and its
// child nodes.  The trailing items are optional, so targets with fixed-length
// tuples only also get the array.
const tree = {
    type: "object",
    properties: { root: { $ref: "#/$defs/node" } },
    required: ["root"],
    additionalProperties: false,
    $defs: {
        node: {
            type: "array",
            minItems: 1,
            items: [
                { type: "string" },
                {
                    type: "array",
                    items: {
                        title: "Leaf",
                        type: "object",
                        properties: { name: { type: "string" } },
                        required: ["name"],
                        additionalProperties: false,
                    },
                },
                { type: "array", items: { $ref: "#/$defs/node" } },
            ],
        },
    },
};

// A node whose second item is a node itself.
const chain = {
    $ref: "#/$defs/node",
    $defs: {
        node: {
            type: "array",
            minItems: 1,
            items: [{ type: "string" }, { $ref: "#/$defs/node" }],
        },
    },
};

describe("targets that declare recursive unions", () => {
    // The node's items are a string or an array of leaves and nodes: two
    // unions that contain each other through arrays.
    test.each([
        ["csharp", ["public Leaf? Leaf;", "public TopLevelNode[]? "]],
        [
            "kotlin",
            [
                /LeafValue\(val value: Leaf\)/,
                /UnionArrayValue\(val value: List<TopLevelNode>\)/,
            ],
        ],
        ["pike", ["typedef Leaf|array(TopLevelNode) PurpleNode;"]],
        // Unions are `dynamic` and `id`, but the leaves' class is declared.
        ["dart", ["class Leaf {"]],
        ["objective-c", ["@interface QTLeaf : NSObject"]],
    ] as const)("%s keeps a tuple's reference to itself", async (lang, expected) => {
        const output = await renderSchema(lang, tree, justTypes);
        for (const e of expected) {
            if (typeof e === "string") expect(output).toContain(e);
            else expect(output).toMatch(e);
        }
    });

    test.each([
        ["csharp", /public TopLevelElement\[\]\? \w+;/],
        ["kotlin", /UnionArrayValue\(val value: List<TopLevelElement>\)/],
        ["pike", /typedef string\|array\(TopLevelElement\) TopLevelElement;/],
    ] as const)("%s keeps a tuple that is its own item", async (lang, expected) => {
        const output = await renderSchema(lang, chain, justTypes);
        expect(output).toMatch(expected);
    });
});

describe("other targets", () => {
    // Crystal would declare recursive aliases, which JSON::Serializable
    // can't parse; the Ruby and PHP renderers fail on such unions.
    test.each([
        ["crystal", "Array(JSON::Any?)"],
        ["ruby", "Types.Array(Types::Any)"],
        ["php", "private array $root;"],
    ] as const)("%s gets any for a tuple's reference to itself", async (lang, expected) => {
        const output = await renderSchema(lang, tree);
        expect(output).toContain(expected);
        expect(output).not.toContain("Leaf");
    });
});
