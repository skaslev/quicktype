// nlohmann/json converts std::tuple to and from JSON arrays, so C++ keeps
// fixed-length tuples.  Other tuple shapes stay arrays of a union.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { expect, test } from "vitest";

async function renderSchema(
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

    const result = await quicktype({
        inputData,
        lang: "cplusplus",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const justTypes = { "just-types": true };

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
};

const node = {
    $ref: "#/$defs/node",
    $defs: {
        node: {
            type: "array",
            items: [
                { type: "string" },
                { type: "array", items: { $ref: "#/$defs/node" } },
            ],
        },
    },
};

test.each([
    [
        "fixed length",
        { type: "array", items: pair },
        "using TopLevel = std::vector<std::tuple<std::string, double>>;",
    ],
    [
        "nullable items",
        {
            type: "array",
            items: {
                type: "array",
                items: [
                    { type: "boolean" },
                    { oneOf: [{ type: "integer" }, { type: "null" }] },
                ],
            },
        },
        "using TopLevel = std::vector<std::tuple<bool, std::optional<int64_t>>>;",
    ],
    [
        "a top-level tuple gets an alias",
        pair,
        "using TopLevel = std::tuple<std::string, double>;",
    ],
    [
        "rest elements become an array",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
        },
        "using TopLevel = std::vector<TopLevelElement>;",
    ],
] as const)("%s", async (_, schema, expected) => {
    expect(await renderSchema(schema, justTypes)).toContain(expected);
});

test("headers include <tuple>", async () => {
    for (const options of [{}, justTypes]) {
        const output = await renderSchema(
            { type: "array", items: pair },
            options,
        );
        expect(output).toContain("#include <tuple>");
    }
});

test("a titled tuple gets an alias", async () => {
    const output = await renderSchema(
        { type: "array", items: { ...pair, title: "MemberScore" } },
        justTypes,
    );
    expect(output).toContain(
        "using MemberScore = std::tuple<std::string, double>;",
    );
    expect(output).toContain("using TopLevel = std::vector<MemberScore>;");
});

test("a recursive tuple becomes a struct", async () => {
    const output = await renderSchema(node);
    expect(output).toContain(
        "struct TopLevel : std::tuple<std::string, std::vector<TopLevel>> {",
    );
    expect(output).toContain("x = j.get<TopLevel::base>();");
    expect(output).toContain("j = static_cast<const TopLevel::base &>(x);");
});

test("a tuple that may contain itself holds it in a shared_ptr", async () => {
    const output = await renderSchema(
        {
            $ref: "#/$defs/list",
            $defs: {
                list: {
                    type: "array",
                    items: [
                        { type: "integer" },
                        { oneOf: [{ type: "null" }, { $ref: "#/$defs/list" }] },
                    ],
                },
            },
        },
        justTypes,
    );
    expect(output).toContain(
        "struct TopLevel : std::tuple<int64_t, std::shared_ptr<TopLevel>> {",
    );
});

test("unions tell tuples apart by length", async () => {
    const output = await renderSchema({
        oneOf: [
            { type: "integer" },
            pair,
            { type: "array", items: [{ type: "boolean" }] },
        ],
    });
    expect(output).toContain(
        "else if (j.is_array() && j.size() == 2)\n            x = j.get<std::tuple<std::string, double>>();",
    );
    expect(output).toContain(
        "else if (j.is_array() && j.size() == 1)\n            x = j.get<std::tuple<bool>>();",
    );
});

test("unions try a tuple before an array of its length", async () => {
    const output = await renderSchema({
        oneOf: [pair, { type: "array", items: pair }],
    });
    expect(output).toContain(
        [
            "        if (j.is_array() && j.size() == 2) {",
            "            try {",
            "                x = j.get<std::tuple<std::string, double>>();",
            "                return;",
            "            } catch (const std::exception &) {}",
            "        }",
            "        if (j.is_array())",
            "            x = j.get<std::vector<std::tuple<std::string, double>>>();",
        ].join("\n"),
    );
});

test("wide strings convert tuples item by item", async () => {
    const output = await renderSchema(
        { type: "object", properties: { pair }, required: ["pair"] },
        { wstring: "use-wstring" },
    );
    expect(output).toContain(
        "static toType convert(tag<std::tuple<TF...> >, tag<std::tuple<TT...> >, fromType t)",
    );
    expect(output).toContain(
        "Utf16_Utf8<std::tuple<std::string, double>, std::tuple<std::wstring, double>>::convert(",
    );
});
