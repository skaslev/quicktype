// A union that contains itself through arrays and maps, with no class in
// between, e.g. `Node = string | Node[]` from a recursive `anyOf`, or
// `R = R[] | string[]`, overflowed the stack: the imports of a union were
// those of all its members, so they went around the cycle forever.  A
// union that isn't just nullable is its own class, referred to by name, so
// it needs no imports where it's used.

import { InputData, JSONSchemaInput, quicktypeMultiFile } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderJava(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<Map<string, string>> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const files = await quicktypeMultiFile({
        inputData,
        lang: "java",
        rendererOptions,
    });
    return new Map(
        Array.from(files, ([name, result]) => [name, result.lines.join("\n")]),
    );
}

function file(files: Map<string, string>, name: string): string {
    const contents = files.get(name);
    if (contents === undefined) {
        throw new Error(
            `${name} wasn't generated: ${Array.from(files.keys())}`,
        );
    }

    return contents;
}

const node = {
    $ref: "#/$defs/node",
    $defs: {
        node: {
            anyOf: [
                { type: "string" },
                { type: "array", items: { $ref: "#/$defs/node" } },
            ],
        },
    },
};

// `R = R[] | string[]`: the two arrays are merged into one of `R | string`.
const arrays = {
    $ref: "#/$defs/r",
    $defs: {
        r: {
            anyOf: [
                { type: "array", items: { $ref: "#/$defs/r" } },
                { type: "array", items: { type: "string" } },
            ],
        },
    },
};

const property = {
    type: "object",
    properties: { x: { $ref: "#/$defs/n" } },
    required: ["x"],
    additionalProperties: false,
    $defs: {
        n: {
            anyOf: [
                { type: "string", format: "date-time" },
                { type: "array", items: { $ref: "#/$defs/n" } },
                { type: "object", additionalProperties: { $ref: "#/$defs/n" } },
            ],
        },
    },
};

const variants = [
    ["full", {}],
    ["just types", { "just-types": true }],
    ["arrays", { "array-type": "array" }],
] as const;

describe.each(variants)("%s", (_, options) => {
    const list = options["array-type"] !== "array";

    test("a recursive top-level union", async () => {
        const files = await renderJava(node, options);
        expect(file(files, "TopLevel.java")).toContain(
            list
                ? "public List<TopLevel> unionArrayValue;"
                : "public TopLevel[] unionArrayValue;",
        );
    });

    test("R = R[] | string[]", async () => {
        const files = await renderJava(arrays, options);
        // The union takes the top-level's name.
        expect(file(files, "TopLevel.java")).toContain(
            list
                ? "public List<TopLevel> unionArrayValue;"
                : "public TopLevel[] unionArrayValue;",
        );
    });

    test("a recursive union property", async () => {
        const files = await renderJava(property, options);
        const n = file(files, "N.java");
        expect(n).toContain(
            list
                ? "public List<N> unionArrayValue;"
                : "public N[] unionArrayValue;",
        );
        expect(n).toContain("public Map<String, N> unionMapValue;");
        expect(n).toContain("import java.time.OffsetDateTime;");
        expect(n).toContain("import java.util.Map;");

        // The class refers to the union by name: it uses none of the
        // types the union's members need.
        const topLevel = file(files, "TopLevel.java");
        expect(topLevel).toContain("private N x;");
        expect(topLevel).not.toMatch(/^import java\.(time|util)\./m);
    });
});

test("a nullable union still imports what its member needs", async () => {
    const files = await renderJava({
        type: "object",
        properties: {
            x: {
                anyOf: [
                    { type: "null" },
                    { type: "array", items: { type: "string" } },
                ],
            },
        },
        required: ["x"],
        additionalProperties: false,
    });
    const topLevel = file(files, "TopLevel.java");
    expect(topLevel).toContain("private List<String> x;");
    expect(topLevel).toContain("import java.util.List;");
});
