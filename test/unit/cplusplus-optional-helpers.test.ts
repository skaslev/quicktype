// nlohmann/json converts optionals and shared_ptrs with the adl_serializer
// specializations of the optional helpers.  They were only emitted when there
// were unions or optional properties, and, in single-source output, named
// types, so neither an array of nullable strings nor a required member held
// in a shared_ptr (a forward-declared class, in mutual recursion) compiled.
// Without getters and setters, the optional header the helpers use wasn't
// included either.

import {
    InputData,
    JSONSchemaInput,
    quicktype,
    quicktypeMultiFile,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

async function schemaInput(schema: object): Promise<InputData> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    return inputData;
}

async function render(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const result = await quicktype({
        inputData: await schemaInput(schema),
        lang: "cplusplus",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const nullableStrings = {
    type: "array",
    items: { type: ["string", "null"] },
};

// B is forward-declared, so TopLevel holds its required `b` in a shared_ptr.
const mutuallyRecursive = {
    $ref: "#/definitions/A",
    definitions: {
        A: {
            type: "object",
            properties: { b: { $ref: "#/definitions/B" } },
            required: ["b"],
            additionalProperties: false,
        },
        B: {
            type: "object",
            properties: {
                a: { type: "array", items: { $ref: "#/definitions/A" } },
                name: { type: "string" },
            },
            required: ["a", "name"],
            additionalProperties: false,
        },
    },
};

const requiredUnion = {
    type: "object",
    properties: {
        x: { oneOf: [{ type: "integer" }, { type: "string" }] },
    },
    required: ["x"],
    additionalProperties: false,
};

const optionalSerializer = "struct adl_serializer<std::optional<T>>";
const sharedPtrSerializer = "struct adl_serializer<std::shared_ptr<T>>";

describe("C++ optional helpers", () => {
    test("convert nullable types without named types", async () => {
        const output = await render(nullableStrings);
        expect(output).toContain(
            "using TopLevel = std::vector<std::optional<std::string>>;",
        );
        expect(output).toContain(optionalSerializer);
    });

    test("convert required members held in shared_ptrs", async () => {
        const output = await render(mutuallyRecursive);
        expect(output).toContain("std::shared_ptr<B> b;");
        expect(output).toContain(sharedPtrSerializer);
    });

    test("use Boost's optional with --boost", async () => {
        const output = await render(nullableStrings, { boost: true });
        expect(output).toContain("struct adl_serializer<boost::optional<T>>");
    });

    test.each([
        ["nullable types", nullableStrings],
        ["shared_ptrs", mutuallyRecursive],
        ["unions", requiredUnion],
    ])("include the optional header without getters and setters (%s)", async (_, schema) => {
        const output = await render(schema, { "code-format": "with-struct" });
        expect(output).toContain(optionalSerializer);
        expect(output).toContain("#include <optional>");
    });

    test("are in the multi-source helper header", async () => {
        const result = await quicktypeMultiFile({
            inputData: await schemaInput(mutuallyRecursive),
            lang: "cplusplus",
            outputFilename: "TopLevel.hpp",
            rendererOptions: {
                "source-style": "multi-source",
                "code-format": "with-struct",
            },
        });
        const helper = result.get("helper.hpp")?.lines.join("\n");
        expect(helper).toContain(sharedPtrSerializer);
        expect(helper).toContain("#include <optional>");
    });

    test("aren't emitted without optionals", async () => {
        const output = await render({
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
        });
        expect(output).not.toContain("adl_serializer");
    });

    test("aren't emitted in just-types output", async () => {
        const output = await render(mutuallyRecursive, { "just-types": true });
        expect(output).not.toContain("adl_serializer");
    });
});
