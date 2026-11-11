// A std::tuple has an element per item, so tuples with optional items or a
// rest are structs with a member per item, `item0`, `item1`, ..., a
// std::optional for each optional item and a std::vector `rest` for the
// rest.  Their from_json and to_json read and write a JSON array.

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

async function renderSchema(
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

const structs = { "code-format": "with-struct" };

// Our pipeline's options.
const pipeline = {
    "just-types": true,
    "code-format": "with-struct",
    namespace: "redis::replies::cluster_slots",
    "include-location": "global-include",
};

// CLUSTER SLOTS: `[start, end, master, ...replicas]`.
const slotRanges = {
    type: "array",
    items: {
        title: "SlotRange",
        type: "array",
        minItems: 3,
        maxItems: 4294967295,
        items: [
            { type: "integer" },
            { type: "integer" },
            { $ref: "#/$defs/node" },
        ],
        additionalItems: { $ref: "#/$defs/node" },
    },
    $defs: {
        node: {
            title: "SlotNode",
            type: "array",
            items: [{ type: ["string", "null"] }, { type: "integer" }],
        },
    },
};

// GEOSEARCH WITH*: a name, then up to three of distance, hash, coordinates.
const geoResults = {
    type: "array",
    items: {
        title: "GeoSearchResult",
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: [{ type: "string" }],
        additionalItems: {
            oneOf: [
                { type: "string" },
                { type: "integer" },
                {
                    title: "Coordinates",
                    type: "array",
                    items: [{ type: "number" }, { type: "number" }],
                },
            ],
        },
    },
};

// A string, an optional nullable string, then a rest of integers.
const row = {
    title: "Row",
    type: "array",
    minItems: 1,
    prefixItems: [{ type: "string" }, { type: ["string", "null"] }],
    items: { type: "integer" },
};

// A top-level tuple would be named after the top-level.
const withRow = {
    type: "object",
    properties: { row },
    required: ["row"],
    additionalProperties: false,
};

// Just-types output puts the types in the namespace, or not, depending on
// the version, so its lines are compared without their indentation.
function unindented(output: string): string {
    return output
        .split("\n")
        .map((line) => line.trim())
        .join("\n");
}

describe("declarations", () => {
    test("a rest is a std::vector member", async () => {
        const output = unindented(await renderSchema(slotRanges, pipeline));
        expect(output).toContain(
            [
                "struct SlotRange {",
                "int64_t item0;",
                "int64_t item1;",
                "SlotNode item2;",
                "std::vector<SlotNode> rest;",
                "};",
            ].join("\n"),
        );
        expect(output).toContain("using TopLevel = std::vector<SlotRange>;");
        // Fixed-length tuples stay std::tuple.
        expect(output).toContain(
            "using SlotNode = std::tuple<std::optional<std::string>, int64_t>;",
        );
        // Not an array of the union of the item types.
        expect(output).not.toContain("std::variant<int64_t, SlotNode>");
        // Just types: no conversions.
        expect(output).not.toContain("from_json");
    });

    test("optional items are optionals", async () => {
        const output = unindented(await renderSchema(geoResults, pipeline));
        expect(output).toContain(
            [
                "struct GeoSearchResult {",
                "std::string item0;",
                "std::optional<GeoSearchResultElement> item1;",
                "std::optional<GeoSearchResultElement> item2;",
                "std::optional<GeoSearchResultElement> item3;",
                "};",
            ].join("\n"),
        );
        expect(output).toContain("#include <optional>");
    });

    test("an optional nullable item tells null from missing", async () => {
        const output = await renderSchema(withRow, structs);
        expect(output).toContain(
            [
                "    struct Row {",
                "        std::string item0;",
                "        std::optional<std::optional<std::string>> item1;",
                "        std::vector<int64_t> rest;",
                "    };",
            ].join("\n"),
        );
    });

    test("with Boost, optional items are boost::optional", async () => {
        const output = await renderSchema(withRow, { ...structs, boost: true });
        expect(output).toContain(
            "boost::optional<boost::optional<std::string>> item1;",
        );
        expect(output).toContain("#include <boost/optional.hpp>");
    });

    test("they're structs in both code formats", async () => {
        const output = await renderSchema(withRow);
        expect(output).toContain(
            "    struct Row {\n        std::string item0;",
        );
        expect(output).toContain('x.set_row(j.at("row").get<Row>());');
    });

    test("<tuple> only where a std::tuple is used", async () => {
        const output = await renderSchema(withRow, { "just-types": true });
        expect(output).toContain("struct Row {");
        expect(output).not.toContain("#include <tuple>");
    });

    test("members are named in the member style", async () => {
        const output = await renderSchema(withRow, {
            ...structs,
            "member-style": "upper-underscore-case",
        });
        expect(output).toContain("        std::string ITEM0;");
        expect(output).toContain("        std::vector<int64_t> REST;");
    });

    test("members aren't named like types", async () => {
        // GCC rejects a member that changes what a name in the class means.
        const output = await renderSchema(
            {
                type: "array",
                prefixItems: [{ type: "string" }],
                items: { $ref: "#/$defs/rest" },
                $defs: {
                    rest: {
                        title: "Rest",
                        type: "object",
                        properties: { a: { type: "string" } },
                    },
                },
            },
            { ...structs, "member-style": "pascal-case" },
        );
        expect(output).toContain("        std::string Item0;");
        expect(output).toContain("        std::vector<Rest> PurpleRest;");
    });

    test("a recursive rest needs no indirection", async () => {
        const output = await renderSchema({
            $ref: "#/$defs/tree",
            $defs: {
                tree: {
                    type: "array",
                    prefixItems: [{ type: "string" }],
                    items: { $ref: "#/$defs/tree" },
                },
            },
        });
        expect(output).toContain(
            "    struct TopLevel {\n        std::string item0;\n        std::vector<TopLevel> rest;\n    };",
        );
    });

    test("an optional item of the tuple itself is a std::shared_ptr", async () => {
        const output = await renderSchema(
            {
                $ref: "#/$defs/chain",
                $defs: {
                    chain: {
                        type: "array",
                        minItems: 1,
                        items: [{ type: "integer" }, { $ref: "#/$defs/chain" }],
                    },
                },
            },
            structs,
        );
        expect(output).toContain("        std::shared_ptr<TopLevel> item1;");
        expect(output).toContain(
            "x.item1 = j.size() > 1 ? std::make_shared<TopLevel>(j.at(1).get<TopLevel>()) : std::shared_ptr<TopLevel>();",
        );
    });
});

describe("conversions", () => {
    test("from_json checks the length and reads the rest", async () => {
        const output = await renderSchema(slotRanges, structs);
        expect(output).toContain(
            [
                "    inline void from_json(const json & j, SlotRange & x) {",
                '        if (!j.is_array() || j.size() < 3 || j.size() > 4294967295) throw std::runtime_error("SlotRange: expected an array of 3 to 4294967295 elements");',
                '        if (!j.at(0).is_number_integer()) throw std::runtime_error("SlotRange: expected an integer");',
                "        x.item0 = j.at(0).get<int64_t>();",
                '        if (!j.at(1).is_number_integer()) throw std::runtime_error("SlotRange: expected an integer");',
                "        x.item1 = j.at(1).get<int64_t>();",
                "        x.item2 = j.at(2).get<SlotNode>();",
                "        x.rest.clear();",
                "        for (std::size_t i = 3; i < j.size(); i++) x.rest.push_back(j.at(i).get<SlotNode>());",
                "    }",
            ].join("\n"),
        );
    });

    test("to_json writes the items, then the rest", async () => {
        const output = await renderSchema(slotRanges, structs);
        expect(output).toContain(
            [
                "    inline void to_json(json & j, const SlotRange & x) {",
                "        j = json::array();",
                "        j.push_back(x.item0);",
                "        j.push_back(x.item1);",
                "        j.push_back(x.item2);",
                "        for (const SlotNode & item : x.rest) j.push_back(item);",
                "    }",
            ].join("\n"),
        );
    });

    test("optional items are read and written if there", async () => {
        const output = await renderSchema(geoResults, structs);
        expect(output).toContain(
            '        if (!j.is_array() || j.size() < 1 || j.size() > 4) throw std::runtime_error("GeoSearchResult: expected an array of 1 to 4 elements");',
        );
        expect(output).toContain(
            "        x.item3 = j.size() > 3 ? std::make_optional<GeoSearchResultElement>(j.at(3).get<GeoSearchResultElement>()) : std::optional<GeoSearchResultElement>();",
        );
        expect(output).toContain(
            [
                '        if ((!x.item1 && x.item2) || (!x.item2 && x.item3)) throw std::runtime_error("GeoSearchResult: an item follows a missing optional item");',
                "        j = json::array();",
                "        j.push_back(x.item0);",
                "        if (x.item1) j.push_back(*x.item1);",
            ].join("\n"),
        );
    });

    test("a nullable optional item reads null as a present item", async () => {
        const output = await renderSchema(withRow, structs);
        expect(output).toContain(
            "        x.item1 = j.size() > 1 ? std::make_optional<std::optional<std::string>>(j.at(1).get<std::optional<std::string>>()) : std::optional<std::optional<std::string>>();",
        );
        expect(output).toContain(
            '        if (!x.item1 && !x.rest.empty()) throw std::runtime_error("Row: an item follows a missing optional item");',
        );
        // Integers are checked: nlohmann/json would truncate a 1.5.
        expect(output).toContain(
            [
                "        for (std::size_t i = 2; i < j.size(); i++) {",
                '            if (!j.at(i).is_number_integer()) throw std::runtime_error("Row: expected an integer");',
                "            x.rest.push_back(j.at(i).get<int64_t>());",
                "        }",
            ].join("\n"),
        );
    });

    test("the schema's minItems and maxItems limit the rest", async () => {
        const atLeast = await renderSchema(
            {
                type: "array",
                minItems: 3,
                prefixItems: [{ type: "string" }],
                items: { type: "boolean" },
            },
            structs,
        );
        expect(atLeast).toContain(
            'if (!j.is_array() || j.size() < 3) throw std::runtime_error("TopLevel: expected an array of at least 3 elements");',
        );
        // vector<bool> has no references to its elements.
        expect(atLeast).toContain(
            "for (const bool & item : x.rest) j.push_back(item);",
        );

        const atMost = await renderSchema(
            {
                type: "array",
                maxItems: 10,
                prefixItems: [{ type: "string" }],
                items: { type: "boolean" },
            },
            structs,
        );
        expect(atMost).toContain(
            'if (!j.is_array() || j.size() < 1 || j.size() > 10) throw std::runtime_error("TopLevel: expected an array of 1 to 10 elements");',
        );
    });

    test("wide strings are converted item by item", async () => {
        const output = await renderSchema(withRow, {
            ...structs,
            wstring: "use-wstring",
        });
        expect(output).toContain("        std::wstring item0;");
        expect(output).toContain(
            "x.item0 = Utf16_Utf8<std::string, std::wstring>::convert(j.at(0).get<std::string>());",
        );
        expect(output).toContain(
            "if (x.item1) j.push_back(Utf16_Utf8<std::optional<std::wstring>, std::optional<std::string>>::convert(*x.item1));",
        );
        // That converts optionals, without optional class members.
        expect(output).toContain(
            "static toType convert(tag<std::optional<TF> >, tag<std::optional<TT> >, fromType opt)",
        );
    });

    test("east const", async () => {
        const output = await renderSchema(withRow, {
            ...structs,
            "const-style": "east-const",
        });
        expect(output).toContain(
            "inline void to_json(json & j, Row const & x) {",
        );
        expect(output).toContain(
            "for (int64_t const & item : x.rest) j.push_back(item);",
        );
    });
});

describe("unions", () => {
    test("tell tuples apart by their lengths", async () => {
        const output = await renderSchema({
            oneOf: [
                { type: "integer" },
                {
                    title: "Short",
                    type: "array",
                    minItems: 1,
                    items: [{ type: "string" }, { type: "integer" }],
                },
                {
                    title: "Long",
                    type: "array",
                    prefixItems: [
                        { type: "boolean" },
                        { type: "boolean" },
                        { type: "boolean" },
                    ],
                    items: { type: "integer" },
                },
            ],
        });
        expect(output).toContain(
            [
                "        else if (j.is_array() && j.size() >= 1 && j.size() <= 2)",
                "            x = j.get<quicktype::Short>();",
                "        else if (j.is_array() && j.size() >= 3)",
                "            x = j.get<quicktype::Long>();",
            ].join("\n"),
        );
    });

    test("try tuples whose lengths overlap in turn", async () => {
        const output = await renderSchema({
            oneOf: [
                { type: "string" },
                {
                    title: "Ints",
                    type: "array",
                    prefixItems: [{ type: "integer" }],
                    items: { type: "integer" },
                },
                {
                    title: "Strs",
                    type: "array",
                    minItems: 1,
                    items: [{ type: "string" }, { type: "string" }],
                },
            ],
        });
        expect(output).toContain(
            [
                "        if (j.is_array() && j.size() >= 1) {",
                "            try {",
                "                x = j.get<quicktype::Ints>();",
                "                return;",
                "            } catch (const std::exception &) {}",
                "        }",
                "        if (j.is_array() && j.size() >= 1 && j.size() <= 2) {",
                "            try {",
                "                x = j.get<quicktype::Strs>();",
                "                return;",
                "            } catch (const std::exception &) {}",
                "        }",
                "        if (j.is_string())",
            ].join("\n"),
        );
    });

    test("try tuples before an array", async () => {
        const output = await renderSchema({
            oneOf: [
                { type: "array", items: { type: "string" } },
                row,
                { type: "null" },
            ],
        });
        expect(output).toContain(
            [
                "        if (j.is_array() && j.size() >= 1) {",
                "            try {",
                "                x = j.get<quicktype::Row>();",
                "                return;",
                "            } catch (const std::exception &) {}",
                "        }",
                "        if (j.is_array())",
                "            x = j.get<std::vector<std::string>>();",
            ].join("\n"),
        );
    });
});

test("multi-source: a recursive union forward-declares the struct", async () => {
    const result = await quicktypeMultiFile({
        inputData: await schemaInput({
            type: "object",
            properties: { mixed: { $ref: "#/$defs/mixed" } },
            required: ["mixed"],
            additionalProperties: false,
            $defs: {
                mixed: {
                    title: "Mixed",
                    oneOf: [
                        { type: "string" },
                        {
                            title: "Node",
                            type: "array",
                            prefixItems: [{ type: "string" }],
                            items: { $ref: "#/$defs/mixed" },
                        },
                    ],
                },
            },
        }),
        lang: "cplusplus",
        outputFilename: "quicktype.hpp",
        rendererOptions: { "source-style": "multi-source" },
    });
    const file = (name: string): string =>
        result.get(name)?.lines.join("\n") ?? "";
    expect(file("Node.hpp")).toContain('#include "Mixed.hpp"');
    expect(file("Node.hpp")).toContain("std::vector<Mixed> rest;");
    // Including Node.hpp would be an include cycle.
    expect(file("Mixed.hpp")).not.toContain('#include "Node.hpp"');
    expect(file("Mixed.hpp")).toContain("    struct Node;");
    expect(file("Generators.hpp")).toContain(
        "inline void from_json(const json & j, Node & x) {",
    );
});
