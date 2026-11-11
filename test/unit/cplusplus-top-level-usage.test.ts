// The header comment of full C++ output says how to read the top-level
// types: `TopLevel data = nlohmann::json::parse(jsonString);`.  That
// copy-initialization doesn't use the generated adl_serializers when the
// type has a converting constructor that takes the JSON: std::optional's
// reads the value type, so a nullable top level throws on null, and
// boost::variant's is ambiguous, as the JSON converts to every alternative,
// so it doesn't compile.  For those types the comment says to use `get`.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function render(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({
        inputData,
        lang: "cplusplus",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const implicit = "//     TopLevel data = nlohmann::json::parse(jsonString);";
const withGet =
    "//     TopLevel data = nlohmann::json::parse(jsonString).get<TopLevel>();";

const nullableUnion = {
    oneOf: [{ type: "integer" }, { type: "string" }, { type: "null" }],
};
const union = { oneOf: [{ type: "integer" }, { type: "string" }] };
const object = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
};

describe("C++ usage comment", () => {
    test("reads nullable top levels with get", async () => {
        const output = await render(nullableUnion);
        expect(output).toContain(
            "using TopLevel = std::optional<std::variant<int64_t, std::string>>;",
        );
        expect(output).toContain(withGet);
        expect(output).not.toContain(implicit);
    });

    test("converts boost::optional", async () => {
        const output = await render(nullableUnion, { boost: true });
        expect(output).toContain(implicit);
    });

    test.each([
        ["unions", union],
        ["classes", object],
    ])("converts %s", async (_, schema) => {
        const output = await render(schema);
        expect(output).toContain(implicit);
    });

    const recursiveUnion = {
        $ref: "#/definitions/R",
        definitions: {
            R: {
                anyOf: [
                    { type: "string" },
                    { type: "array", items: { $ref: "#/definitions/R" } },
                ],
            },
        },
    };

    test.each([
        [
            "unions",
            union,
            "using TopLevel = boost::variant<int64_t, std::string>;",
        ],
        [
            "recursive unions",
            recursiveUnion,
            "struct TopLevel : boost::variant<std::vector<TopLevel>, std::string> {",
        ],
    ])("reads boost::variant %s with get", async (_, schema, declaration) => {
        const output = await render(schema, { boost: true });
        expect(output).toContain(declaration);
        expect(output).toContain(withGet);
        expect(output).not.toContain(implicit);
    });

    test("converts classes with Boost", async () => {
        const output = await render(object, { boost: true });
        expect(output).toContain(implicit);
    });

    test("isn't in just-types output", async () => {
        const output = await render(nullableUnion, { "just-types": true });
        expect(output).not.toContain("nlohmann::json::parse");
    });
});
