// In Go's multi-file output, a top-level that is a class, enum or union is
// in its type's file, which is written once: the top-level's comments, the
// package and all imports, the top-level's functions, then the type.

import { InputData, JSONSchemaInput, quicktypeMultiFile } from "quicktype-core";
import { afterEach, describe, expect, test, vi } from "vitest";

async function renderFiles(
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
        lang: "go",
        rendererOptions: { "multi-file-output": true, ...rendererOptions },
    });
    return new Map(
        Array.from(files, ([name, result]) => [name, result.lines.join("\n")]),
    );
}

// Whether all the imports come before the first declaration.
function importsFirst(source: string): boolean {
    const lines = source.split("\n");
    const firstDeclaration = lines.findIndex((l) =>
        /^(type|func|const|var) /.test(l),
    );
    const lastImport = lines.reduce(
        (last, l, i) => (l.startsWith("import ") ? i : last),
        -1,
    );
    return lastImport < firstDeclaration;
}

const point = {
    type: "object",
    properties: {
        x: { type: "integer" },
        at: { type: "string", format: "date-time" },
    },
    required: ["x"],
};

const topLevels: Array<[string, object, string]> = [
    ["class", point, "type TopLevel struct {"],
    [
        "union",
        {
            oneOf: [
                { type: "integer" },
                { type: "string", format: "date-time" },
                { $ref: "#/definitions/Point" },
            ],
            definitions: { Point: point },
        },
        "func (x *TopLevel) UnmarshalJSON(data []byte) error {",
    ],
    ["enum", { enum: ["a", "b"] }, "type TopLevel string"],
];

describe("Go multi-file top-levels", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    for (const [kind, schema, declaration] of topLevels) {
        test(`a top-level ${kind} is written once, in its type's file`, async () => {
            const log = vi.spyOn(console, "log").mockImplementation(() => {});
            const files = await renderFiles(schema);
            expect(log).not.toHaveBeenCalledWith(
                expect.stringContaining("more than once"),
            );

            const source = files.get("TopLevel.go") ?? "";
            expect(source).toMatch(/^\/\/ Code generated from JSON Schema/);
            expect(source.match(/^package main$/gm)).toHaveLength(1);
            expect(source).toContain('import "encoding/json"');
            expect(importsFirst(source)).toBe(true);
            const unmarshal = source.indexOf(
                "func UnmarshalTopLevel(data []byte) (TopLevel, error) {",
            );
            expect(unmarshal).toBeGreaterThan(0);
            expect(source).toContain(
                "func (r *TopLevel) Marshal() ([]byte, error) {",
            );
            expect(source.indexOf(declaration)).toBeGreaterThan(unmarshal);
        });
    }
});
