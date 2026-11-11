// C++ keeps the arrays of JSON Schema array schemas apart in unions, if
// their item types can be told apart, as alternatives of a variant.  Its
// `from_json` tries them in turn on an array, and an array only takes a JSON
// array whose elements are all of its items: nlohmann's `get` would round
// numbers into integers and take booleans for numbers, so the elements of
// arrays of numbers are checked first, and the classes of arrays that need
// to be told apart reject unknown properties.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

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
        rendererOptions: { namespace: "qt", ...rendererOptions },
    });
    return result.lines.join("\n");
}

function arrayOf(items: object): object {
    return { type: "array", items };
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

const memberScore = {
    title: "MemberScore",
    ...closedObject({ member: { type: "string" }, score: { type: "number" } }, [
        "member",
        "score",
    ]),
};

// Like Redis' ZRANGE reply.
const membersOrScores = {
    anyOf: [arrayOf({ type: "string" }), arrayOf(memberScore)],
};

const tryArray = (type: string, indent = ""): string =>
    [
        `${indent}            try {`,
        `${indent}                x = j.get<${type}>();`,
        `${indent}                return;`,
        `${indent}            } catch (const std::exception &) {}`,
    ].join("\n");

const allOf = (e: string, condition: string): string =>
    `std::all_of(${e}.begin(), ${e}.end(), [](const json & ${e === "j" ? "e" : `${e}1`}) { return ${condition}; })`;

describe("types", () => {
    test("a union of arrays is a variant of vectors", async () => {
        const output = await renderSchema(membersOrScores, {
            "just-types": true,
            "code-format": "with-struct",
        });
        expect(output).toContain(
            "using TopLevel = std::variant<std::vector<std::string>, std::vector<MemberScore>>;",
        );
        expect(output).not.toContain("#include <algorithm>");
    });

    test("next to null and other types", async () => {
        const output = await renderSchema(
            closedObject(
                {
                    reply: {
                        oneOf: [
                            { type: "null" },
                            { type: "integer" },
                            arrayOf({ type: "string" }),
                            arrayOf(arrayOf({ type: "boolean" })),
                        ],
                    },
                },
                ["reply"],
            ),
            { "just-types": true, "code-format": "with-struct", boost: true },
        );
        expect(output).toContain(
            "using Reply = boost::optional<boost::variant<std::vector<std::string>, std::vector<std::vector<bool>>, int64_t>>;",
        );
    });
});

describe("from_json", () => {
    test("tries the arrays in the order of the variant", async () => {
        const output = await renderSchema(membersOrScores);
        expect(output).toContain(
            [
                "        if (j.is_array()) {",
                tryArray("std::vector<std::string>"),
                tryArray("std::vector<qt::MemberScore>"),
                '            throw std::runtime_error("Could not deserialise!");',
                "        }",
                '        else throw std::runtime_error("Could not deserialise!");',
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "            case 0:",
                "                j = std::get<std::vector<std::string>>(x);",
                "                break;",
                "            case 1:",
                "                j = std::get<std::vector<qt::MemberScore>>(x);",
                "                break;",
            ].join("\n"),
        );

        // MemberScore needn't be told apart from another class, and strings
        // are checked by `get`.
        expect(output).not.toContain("Unexpected property");
        expect(output).not.toContain("#include <algorithm>");
    });

    test("checks the elements of arrays of numbers", async () => {
        const output = await renderSchema({
            anyOf: [
                arrayOf({ type: "integer" }),
                arrayOf({ type: "boolean" }),
                arrayOf(arrayOf({ type: ["number", "null"] })),
            ],
        });
        expect(output).toContain(
            [
                "        if (j.is_array()) {",
                `            if (${allOf("j", "e.is_number_integer()")}) {`,
                tryArray("std::vector<int64_t>", "    "),
                "            }",
                tryArray("std::vector<bool>"),
                `            if (${allOf("j", allOf("e", "e1.is_null() || e1.is_number()"))}) {`,
                tryArray(
                    "std::vector<std::vector<std::optional<double>>>",
                    "    ",
                ),
                "            }",
                '            throw std::runtime_error("Could not deserialise!");',
                "        }",
            ].join("\n"),
        );
        expect(output).toContain("#include <algorithm>");
    });

    test("checks the elements of the one array of a union", async () => {
        const output = await renderSchema({
            anyOf: [
                arrayOf({
                    title: "Item",
                    oneOf: [{ type: "string" }, arrayOf({ type: "integer" })],
                }),
                arrayOf(arrayOf({ type: "boolean" })),
            ],
        });
        expect(output).toContain(
            `            if (${allOf("j", `!e.is_array() || ${allOf("e", "e1.is_number_integer()")}`)}) {`,
        );
    });

    // nlohmann's `get` of a std::tuple takes longer arrays, too.
    test("checks the elements and lengths of tuples", async () => {
        const fixed = await renderSchema({
            anyOf: [
                arrayOf({
                    type: "array",
                    items: [{ type: "integer" }, { type: "string" }],
                    minItems: 2,
                    maxItems: 2,
                }),
                arrayOf(arrayOf({ type: "boolean" })),
            ],
        });
        expect(fixed).toContain(
            `            if (${allOf("j", "e.is_array() && e.size() == 2 && e[0].is_number_integer()")}) {`,
        );

        const withRest = await renderSchema({
            anyOf: [
                arrayOf({
                    type: "array",
                    items: [{ type: "boolean" }, { type: "number" }],
                    minItems: 1,
                    additionalItems: { type: "integer" },
                }),
                arrayOf({ type: "string" }),
            ],
        });
        expect(withRest).toContain(
            `            if (${allOf("j", "e.is_array() && e.size() >= 1 && (e.size() <= 1 || e[1].is_number()) && (e.size() <= 2 || std::all_of(e.begin() + 2, e.end(), [](const json & e2) { return e2.is_number_integer(); }))")}) {`,
        );
    });

    test("the classes of several arrays of classes reject unknown properties", async () => {
        const output = await renderSchema({
            oneOf: [
                arrayOf({
                    title: "AOrString",
                    oneOf: [
                        {
                            title: "A",
                            ...closedObject({ a: { type: "string" } }, ["a"]),
                        },
                        { type: "string" },
                    ],
                }),
                arrayOf({
                    title: "B",
                    ...closedObject({ b: { type: "string" } }, ["b"]),
                }),
            ],
        });
        for (const name of ["a", "b"]) {
            expect(output).toContain(
                [
                    `    inline void from_json(const json & j, ${name.toUpperCase()}& x) {`,
                    '        if (!j.is_object()) throw std::runtime_error("Expected object");',
                    "        for (auto it = j.begin(); it != j.end(); ++it) {",
                    "            const auto & key = it.key();",
                    `            if (key != "${name}") throw std::runtime_error("Unexpected property " + key);`,
                    "        }",
                ].join("\n"),
            );
        }
    });

    test("unions with a single array are as before", async () => {
        const output = await renderSchema({
            oneOf: [arrayOf({ type: "integer" }), { type: "string" }],
        });
        expect(output).toContain(
            [
                "        if (j.is_string())",
                "            x = j.get<std::string>();",
                "        else if (j.is_array())",
                "            x = j.get<std::vector<int64_t>>();",
                '        else throw std::runtime_error("Could not deserialise!");',
            ].join("\n"),
        );
        expect(output).not.toContain("#include <algorithm>");
    });
});

test("arrays of the same items are unified", async () => {
    const output = await renderSchema(
        { anyOf: [arrayOf({ type: "string" }), arrayOf({ enum: ["a", "b"] })] },
        { "just-types": true },
    );
    expect(output).toContain("using TopLevel = std::vector<std::string>;");
});
