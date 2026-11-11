// C++ keeps the classes of JSON Schema object schemas that forbid additional
// properties apart in unions, as alternatives of a variant.  Its `from_json`
// tries them in turn on an object, so their `from_json` rejects objects of
// the others: unknown properties as well as missing required ones.

import {
    InputData,
    JSONSchemaInput,
    quicktype,
    quicktypeMultiFile,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

async function inputDataFor(schema: object): Promise<InputData> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);
    return inputData;
}

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const result = await quicktype({
        inputData: await inputDataFor(schema),
        lang: "cplusplus",
        rendererOptions: { namespace: "qt", ...rendererOptions },
    });
    return result.lines.join("\n");
}

function closedObject(
    properties: Record<string, object>,
    required: string[],
): object {
    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}

// Short's required properties are a subset of Long's.
const defs = {
    Short: closedObject({ a: { type: "integer" }, c: { type: "string" } }, [
        "a",
    ]),
    Long: closedObject(
        {
            a: { type: "integer" },
            b: { type: "string" },
            c: { type: "string" },
        },
        ["a", "b"],
    ),
};

const shortOrLong = {
    oneOf: [{ $ref: "#/$defs/Short" }, { $ref: "#/$defs/Long" }],
    $defs: defs,
};

const unknownPropertiesCheck = (keys: string[]): string =>
    [
        "        for (auto it = j.begin(); it != j.end(); ++it) {",
        "            const auto & key = it.key();",
        `            if (${keys.map((k) => `key != "${k}"`).join(" && ")}) throw std::runtime_error("Unexpected property " + key);`,
        "        }",
    ].join("\n");

const tryClass = (name: string): string =>
    [
        "            try {",
        `                x = j.get<qt::${name}>();`,
        "                return;",
        "            } catch (const std::exception &) {}",
    ].join("\n");

describe("types", () => {
    test("a union of classes is a variant of them", async () => {
        const output = await renderSchema(shortOrLong, {
            "just-types": true,
            "code-format": "with-struct",
        });
        expect(output).toContain("using TopLevel = std::variant<Short, Long>;");
        expect(output).toContain("struct Short {");
        expect(output).toContain("struct Long {");
    });

    test("next to other types", async () => {
        const output = await renderSchema(
            {
                ...closedObject(
                    {
                        reply: {
                            anyOf: [
                                { $ref: "#/$defs/Short" },
                                { $ref: "#/$defs/Long" },
                                { type: "string" },
                                { type: "null" },
                            ],
                        },
                    },
                    ["reply"],
                ),
                $defs: defs,
            },
            { "just-types": true, "code-format": "with-struct" },
        );
        expect(output).toContain(
            "using Reply = std::optional<std::variant<Short, Long, std::string>>;",
        );
    });
});

describe("from_json", () => {
    test("tries the classes, those with more required properties first", async () => {
        const output = await renderSchema({
            oneOf: [...shortOrLong.oneOf, { type: "string" }],
            $defs: defs,
        });
        expect(output).toContain(
            [
                "        if (j.is_string())",
                "            x = j.get<std::string>();",
                "        else if (j.is_object()) {",
                tryClass("Long"),
                tryClass("Short"),
                '            throw std::runtime_error("Could not deserialise!");',
                "        }",
                '        else throw std::runtime_error("Could not deserialise!");',
            ].join("\n"),
        );
    });

    test("a union of only classes", async () => {
        const output = await renderSchema(shortOrLong, { boost: true });
        expect(output).toContain(
            [
                "        if (j.is_object()) {",
                tryClass("Long"),
                tryClass("Short"),
                '            throw std::runtime_error("Could not deserialise!");',
                "        }",
                '        else throw std::runtime_error("Could not deserialise!");',
            ].join("\n"),
        );
        expect(output).toContain("switch (x.which())");
    });

    test("of a union class rejects unknown properties", async () => {
        for (const codeFormat of ["with-struct", "with-getter-setter"]) {
            const output = await renderSchema(shortOrLong, {
                "code-format": codeFormat,
            });
            expect(output).toContain(
                [
                    "    inline void from_json(const json & j, Long& x) {",
                    '        if (!j.is_object()) throw std::runtime_error("Expected object");',
                    unknownPropertiesCheck(["a", "b", "c"]),
                ].join("\n"),
            );
            expect(output).toContain(
                [
                    "    inline void from_json(const json & j, Short& x) {",
                    '        if (!j.is_object()) throw std::runtime_error("Expected object");',
                    unknownPropertiesCheck(["a", "c"]),
                ].join("\n"),
            );
        }
    });

    // `get_untyped` takes a missing property for null.
    test("of a union class requires untyped properties", async () => {
        const output = await renderSchema({
            oneOf: [
                closedObject({ any: {}, maybe: {} }, ["any"]),
                closedObject({ b: { type: "boolean" } }, ["b"]),
            ],
        });
        expect(output).toContain(
            [
                '        j.at("any");',
                '        x.set_any(get_untyped(j, "any"));',
                '        x.set_maybe(get_untyped(j, "maybe"));',
            ].join("\n"),
        );
    });

    test("of an empty union class only takes empty objects", async () => {
        const output = await renderSchema({
            anyOf: [
                { type: "object", additionalProperties: false },
                defs.Short,
            ],
        });
        expect(output).toContain(
            [
                '        if (!j.is_object()) throw std::runtime_error("Expected object");',
                '        if (!j.empty()) throw std::runtime_error("Unexpected property " + j.begin().key());',
                "        (void)x;",
                "    }",
            ].join("\n"),
        );
    });

    test("of other classes takes unknown properties", async () => {
        const output = await renderSchema({
            ...closedObject(
                {
                    reply: {
                        oneOf: [{ $ref: "#/$defs/Short" }, { type: "null" }],
                    },
                },
                ["reply"],
            ),
            $defs: defs,
        });
        expect(output).not.toContain("Unexpected property");
        expect(output).not.toContain("std::exception");
    });
});

test("classes that allow additional properties are unified", async () => {
    const output = await renderSchema(
        {
            oneOf: [
                { type: "object", properties: { a: { type: "integer" } } },
                { type: "object", properties: { b: { type: "string" } } },
            ],
        },
        { "just-types": true, "code-format": "with-struct" },
    );
    expect(output).toMatch(
        /struct TopLevel \{\s+std::optional<int64_t> a;\s+std::optional<std::string> b;\s+\};/,
    );
    expect(output).not.toContain("variant");
});

// A recursive union is a struct deriving from the variant, so its header
// includes the classes it holds by value.
test("multi-source headers of recursive unions include their classes", async () => {
    const result = await quicktypeMultiFile({
        inputData: await inputDataFor({
            $ref: "#/$defs/Node",
            $defs: {
                Node: {
                    oneOf: [
                        { $ref: "#/$defs/Leaf" },
                        { $ref: "#/$defs/Branch" },
                    ],
                },
                Leaf: closedObject({ value: { type: "integer" } }, ["value"]),
                Branch: closedObject(
                    {
                        children: {
                            type: "array",
                            items: { $ref: "#/$defs/Node" },
                        },
                    },
                    ["children"],
                ),
            },
        }),
        lang: "cplusplus",
        outputFilename: "TopLevel.hpp",
        rendererOptions: { namespace: "qt", "source-style": "multi-source" },
    });
    const header = result.get("TopLevel.hpp")?.lines.join("\n");
    expect(header).toContain(
        "    struct TopLevel : std::variant<Leaf, std::shared_ptr<Branch>> {",
    );
    expect(header).toContain('#include "Leaf.hpp"');
    expect(header).toContain("    class Branch;");
});
