// C++ multi-source just-types headers don't refer to nlohmann/json, which
// just-types output doesn't include.

import { InputData, JSONSchemaInput, quicktypeMultiFile } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function multiSourceFiles(
    schema: object,
    rendererOptions: Record<string, string | boolean>,
): Promise<Map<string, string>> {
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
        rendererOptions: { "source-style": "multi-source", ...rendererOptions },
    });
    return new Map(
        Array.from(result, ([filename, serialized]) => [
            filename,
            serialized.lines.join("\n"),
        ]),
    );
}

const pointSchema = {
    type: "object",
    properties: {
        point: { $ref: "#/definitions/Point" },
        kind: { enum: ["a", "b"] },
        value: { anyOf: [{ type: "string" }, { type: "integer" }] },
    },
    required: ["point", "kind", "value"],
    additionalProperties: false,
    definitions: {
        Point: {
            type: "object",
            properties: { x: { type: "integer" } },
            required: ["x"],
            additionalProperties: false,
        },
    },
};

describe("C++ multi-source just-types headers", () => {
    test("don't use nlohmann::json without including it", async () => {
        const files = await multiSourceFiles(pointSchema, {
            "just-types": true,
        });
        expect(Array.from(files.keys()).sort()).toEqual([
            "Kind.hpp",
            "Point.hpp",
            "TopLevel.hpp",
            "Value.hpp",
            "quicktype.hpp",
        ]);
        for (const source of files.values()) {
            expect(source).not.toContain("json.hpp");
            expect(source).not.toContain("using nlohmann::json;");
        }
    });

    test("the full-mode headers still use nlohmann::json", async () => {
        const files = await multiSourceFiles(pointSchema, {});
        for (const filename of ["Kind.hpp", "Point.hpp", "TopLevel.hpp"]) {
            const source = files.get(filename) ?? "";
            expect(source).toContain('#include "json.hpp"');
            expect(source).toContain("using nlohmann::json;");
        }
    });
});
