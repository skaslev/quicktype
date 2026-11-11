// In C++ multi-source output every named type has its own header, which
// includes the headers of the types it needs complete and forward declares
// the others.

import { InputData, JSONSchemaInput, quicktypeMultiFile } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function multiSourceFiles(schema: object): Promise<Map<string, string>> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktypeMultiFile({
        inputData,
        lang: "cplusplus",
        outputFilename: "quicktype.hpp",
        rendererOptions: { "source-style": "multi-source" },
    });
    return new Map(
        Array.from(result, ([filename, serialized]) => [
            filename,
            serialized.lines.join("\n"),
        ]),
    );
}

async function header(schema: object, filename: string): Promise<string> {
    const source = (await multiSourceFiles(schema)).get(filename);
    if (source === undefined) throw new Error(`No ${filename}`);
    return source;
}

// The headers a header includes, and the types it forward declares.
function includedHeaders(source: string): string[] {
    return Array.from(
        source.matchAll(/^#include "(\w+)\.hpp"$/gm),
        (m) => m[1],
    );
}

function forwardDeclarations(source: string): string[] {
    return Array.from(
        source.matchAll(/^ *(?:class|struct) (\w+);$/gm),
        (m) => m[1],
    );
}

function object(properties: object, required: string[]): object {
    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}

const ref = (name: string) => ({ $ref: `#/definitions/${name}` });
const arrayOf = (items: object) => ({ type: "array", items });

// Whether a header includes the header of a type or declares it.
async function inclusion(
    schema: object,
    filename: string,
    type: string,
): Promise<string[]> {
    const source = await header(schema, filename);
    return [
        ...(includedHeaders(source).includes(type) ? ["include"] : []),
        ...(forwardDeclarations(source).includes(type) ? ["forward"] : []),
    ];
}

const leaf = {
    type: "object",
    properties: { value: { type: "integer" } },
    required: ["value"],
    additionalProperties: false,
};

describe("C++ multi-source recursive unions", () => {
    const node = {
        $ref: "#/definitions/Node",
        definitions: {
            Node: {
                anyOf: [
                    { $ref: "#/definitions/Leaf" },
                    { type: "array", items: { $ref: "#/definitions/Node" } },
                ],
            },
            Leaf: leaf,
        },
    };

    test("a union of a class and an array of itself includes the class", async () => {
        const source = await header(node, "TopLevel.hpp");
        expect(source).toContain(
            "struct TopLevel : std::variant<std::vector<TopLevel>, Leaf> {",
        );
        expect(includedHeaders(source)).toContain("Leaf");
    });

    test("a union of a string and an array of itself", async () => {
        const source = await header(
            {
                $ref: "#/definitions/R",
                definitions: {
                    R: {
                        anyOf: [
                            {
                                type: "array",
                                items: { $ref: "#/definitions/R" },
                            },
                            { type: "string" },
                        ],
                    },
                },
            },
            "TopLevel.hpp",
        );
        expect(source).toContain(
            "struct TopLevel : std::variant<std::vector<TopLevel>, std::string> {",
        );
    });

    test("a class with a recursive union member includes the union's class", async () => {
        const source = await header(
            {
                type: "object",
                properties: { node: { $ref: "#/definitions/Node" } },
                required: ["node"],
                additionalProperties: false,
                definitions: node.definitions,
            },
            "TopLevel.hpp",
        );
        expect(includedHeaders(source)).toEqual(
            expect.arrayContaining(["Node", "Leaf"]),
        );
        expect(forwardDeclarations(source)).toEqual([]);
    });
});

describe("C++ multi-source nested unions", () => {
    test("a union includes a union in its arrays", async () => {
        // The shape of Redis' GEORADIUS reply without tuples.
        const source = await header(
            {
                anyOf: [
                    {
                        type: "array",
                        items: {
                            anyOf: [
                                { type: "string" },
                                { type: "array", items: { type: "integer" } },
                            ],
                        },
                    },
                    { type: "integer" },
                ],
            },
            "TopLevel.hpp",
        );
        expect(source).toContain(
            "using TopLevel = std::variant<std::vector<TopLevelElement>, int64_t>;",
        );
        expect(includedHeaders(source)).toContain("TopLevelElement");
    });

    test("a union includes a union in its maps", async () => {
        const source = await header(
            {
                anyOf: [
                    { type: "integer" },
                    {
                        type: "object",
                        additionalProperties: {
                            anyOf: [{ type: "string" }, leaf],
                        },
                    },
                ],
            },
            "TopLevel.hpp",
        );
        expect(source).toContain(
            "using TopLevel = std::variant<int64_t, std::map<std::string, TopLevelValue>>;",
        );
        expect(includedHeaders(source)).toContain("TopLevelValue");
    });
});

describe("C++ multi-source mutually recursive types", () => {
    test("classes held in std::shared_ptr don't include each other", async () => {
        const schema = {
            $ref: "#/definitions/A",
            definitions: {
                A: object({ name: { type: "string" }, b: ref("B") }, [
                    "name",
                    "b",
                ]),
                B: object({ a: ref("A") }, []),
            },
        };
        expect(await header(schema, "TopLevel.hpp")).toContain(
            "std::shared_ptr<B> b;",
        );
        expect(await inclusion(schema, "TopLevel.hpp", "B")).toEqual([
            "forward",
        ]);
        expect(await inclusion(schema, "B.hpp", "TopLevel")).toEqual([
            "forward",
        ]);
    });

    test("classes in each other's arrays don't include each other", async () => {
        const schema = {
            $ref: "#/definitions/A",
            definitions: {
                A: object({ bs: arrayOf(ref("B")) }, ["bs"]),
                B: object({ as: arrayOf(ref("A")) }, ["as"]),
            },
        };
        expect(await inclusion(schema, "TopLevel.hpp", "B")).toEqual([
            "forward",
        ]);
        expect(await inclusion(schema, "B.hpp", "TopLevel")).toEqual([
            "forward",
        ]);
    });

    test("a union doesn't include a class that contains it", async () => {
        const schema = {
            $ref: "#/definitions/U",
            definitions: {
                U: { anyOf: [arrayOf(ref("A")), { type: "string" }] },
                A: object({ u: ref("U") }, ["u"]),
            },
        };
        expect(await inclusion(schema, "TopLevel.hpp", "A")).toEqual([
            "forward",
        ]);
        expect(await inclusion(schema, "A.hpp", "TopLevel")).toEqual([
            "include",
        ]);
    });

    test("a class outside the cycle includes the classes in it", async () => {
        const schema = {
            ...object({ nodes: arrayOf(ref("Node")), root: ref("Node") }, [
                "nodes",
                "root",
            ]),
            definitions: {
                Node: object({ children: arrayOf(ref("Child")) }, ["children"]),
                Child: object({ parent: ref("Node") }, []),
            },
        };
        expect(await inclusion(schema, "TopLevel.hpp", "Node")).toEqual([
            "include",
        ]);
        expect(await inclusion(schema, "Node.hpp", "Child")).toEqual([
            "forward",
        ]);
        expect(await inclusion(schema, "Child.hpp", "Node")).toEqual([
            "forward",
        ]);
    });
});
