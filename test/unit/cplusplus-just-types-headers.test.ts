// C++ just-types headers compile on their own: they include the standard
// headers they use, nlohmann/json.hpp only when needed, and keep every
// declaration in the requested namespace.

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

const nullableObject = {
    oneOf: [
        {
            title: "User",
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
        },
        { type: "null" },
    ],
};

const intMap = { type: "object", additionalProperties: { type: "integer" } };

describe("C++ just-types headers", () => {
    test("include the standard headers they use", async () => {
        const output = await renderSchema("cplusplus", intMap, justTypes);
        for (const header of ["<cstdint>", "<map>", "<string>"]) {
            expect(output).toContain(`#include ${header}`);
        }
        expect(output).not.toContain("nlohmann/json.hpp");
    });

    test("include nlohmann/json.hpp only for free-form values", async () => {
        const output = await renderSchema(
            "cplusplus",
            {
                type: "object",
                properties: { value: {} },
                required: ["value"],
                additionalProperties: false,
            },
            { ...justTypes, "include-location": "global-include" },
        );
        expect(output).toContain("#include <nlohmann/json.hpp>");
        expect(output).toContain("nlohmann::json value;");
    });

    test("include <memory> for nullable references that break a cycle", async () => {
        // `next` refers back to the class that holds it, so it's held in a
        // std::shared_ptr, although nothing is forward-declared.
        const output = await renderSchema(
            "cplusplus",
            {
                $ref: "#/definitions/List",
                definitions: {
                    List: {
                        type: "object",
                        properties: {
                            data: { type: "string" },
                            next: {
                                anyOf: [
                                    { $ref: "#/definitions/List" },
                                    { type: "null" },
                                ],
                            },
                        },
                        required: ["data", "next"],
                        additionalProperties: false,
                    },
                },
            },
            justTypes,
        );
        expect(output).toContain("std::shared_ptr<TopLevel> next;");
        expect(output).toContain("#include <memory>");
    });

    test("put the types in the requested namespace", async () => {
        const output = await renderSchema("cplusplus", nullableObject, {
            ...justTypes,
            namespace: "my::types",
        });
        const namespaceStart = output.indexOf("namespace types {");
        expect(namespaceStart).toBeGreaterThan(-1);
        expect(output.search(/(?:class|struct) User\b/)).toBeGreaterThan(
            namespaceStart,
        );
        expect(output.indexOf("using TopLevel")).toBeGreaterThan(
            namespaceStart,
        );
        expect(output.match(/namespace types \{/g)).toHaveLength(1);
    });
});
