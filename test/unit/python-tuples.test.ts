// Python keeps fixed-length tuples, `Tuple[A, B]`, and converts them with
// `from_tuple`/`to_tuple`.  Other tuple shapes stay arrays of a union.

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
        lang: "python",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
};

const withPair = {
    type: "object",
    properties: { pair },
    required: ["pair"],
    additionalProperties: false,
};

// A command whose last item is its subcommands.
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

describe("types", () => {
    test.each([
        ["3.10", {}, "    pair: tuple[str, float]"],
        ["3.9", { "python-version": "3.9" }, "    pair: tuple[str, float]"],
        ["3.7", { "python-version": "3.7" }, "    pair: Tuple[str, float]"],
        ["3.6", { "python-version": "3.6" }, "    pair: Tuple[str, float]"],
        [
            "just types",
            { "just-types": true },
            "class TopLevel:\n    pair: tuple[str, float]",
        ],
        [
            "pydantic",
            { "just-types": true, "pydantic-base-model": true },
            "class TopLevel(BaseModel):\n    pair: tuple[str, float]",
        ],
    ] as const)("%s", async (_, options, expected) => {
        expect(await renderSchema(withPair, options)).toContain(expected);
    });

    test("Tuple is imported from typing before 3.9", async () => {
        const output = await renderSchema(withPair, {
            "python-version": "3.7",
            "just-types": true,
        });
        expect(output).toMatch(/^from typing import .*\bTuple\b/m);
    });

    test("a tuple of one element", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { one: { type: "array", items: [{ type: "string" }] } },
            required: ["one"],
        });
        expect(output).toContain("    one: tuple[str]");
    });

    test("rest elements become an array", async () => {
        const output = await renderSchema(
            {
                type: "array",
                prefixItems: [{ type: "boolean" }],
                items: { type: "integer" },
            },
            { "just-types": true },
        );
        expect(output).not.toContain("tuple[");
    });

    test("a property named tuple doesn't shadow the builtin", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { tuple: pair },
            required: ["tuple"],
        });
        expect(output).not.toContain("    tuple:");
        expect(output).toContain('obj["tuple"]');
    });
});

describe("converters", () => {
    test("check the length and convert each item", async () => {
        const output = await renderSchema(withPair);
        expect(output).toContain(
            'pair = from_tuple([from_str, from_float], obj["pair"])',
        );
        expect(output).toContain(
            'result["pair"] = to_tuple([from_str, to_float], self.pair)',
        );
        expect(output).toContain(
            [
                "def from_tuple(fs: list[Callable[[Any], Any]], x: Any) -> tuple[Any, ...]:",
                "    assert isinstance(x, list) and len(x) == len(fs)",
                "    return tuple(f(y) for (f, y) in zip(fs, x))",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "def to_tuple(fs: list[Callable[[Any], Any]], x: Any) -> list[Any]:",
                "    assert isinstance(x, tuple) and len(x) == len(fs)",
                "    return [f(y) for (f, y) in zip(fs, x)]",
            ].join("\n"),
        );
    });

    test("use typing before 3.9", async () => {
        const output = await renderSchema(withPair, {
            "python-version": "3.7",
        });
        expect(output).toContain(
            "def from_tuple(fs: List[Callable[[Any], Any]], x: Any) -> Tuple[Any, ...]:",
        );
    });

    test("have no type hints in 3.5", async () => {
        const output = await renderSchema(withPair, {
            "python-version": "3.5",
        });
        expect(output).toContain("def from_tuple(fs, x):");
        expect(output).toContain(
            'pair = from_tuple([from_str, from_float], obj["pair"])',
        );
    });

    test("in a union", async () => {
        const output = await renderSchema({
            oneOf: [{ type: "null" }, { type: "integer" }, pair],
        });
        expect(output).toContain(
            "def top_level_from_dict(s: Any) -> int | tuple[str, float] | None:",
        );
        expect(output).toContain(
            "lambda x: from_tuple([from_str, from_float], x)",
        );
        expect(output).toContain("lambda x: to_tuple([from_str, to_float], x)");
    });

    test("are only emitted for tuples", async () => {
        const output = await renderSchema({
            type: "array",
            items: { type: "string" },
        });
        expect(output).not.toContain("tuple");
    });
});

describe("named tuples", () => {
    test("a titled tuple is a type alias with converters", async () => {
        const output = await renderSchema({
            type: "array",
            items: { ...pair, title: "MemberScore" },
        });
        expect(output).toContain("MemberScore = tuple[str, float]");
        expect(output).toContain(
            [
                "def from_member_score(x: Any) -> MemberScore:",
                "    return from_tuple([from_str, from_float], x)",
                "",
                "",
                "def to_member_score(x: MemberScore) -> Any:",
                "    return to_tuple([from_str, to_float], x)",
            ].join("\n"),
        );
        expect(output).toContain(
            "def top_level_from_dict(s: Any) -> list[MemberScore]:\n    return from_list(from_member_score, s)",
        );
    });

    test("a titled tuple in just-types output", async () => {
        const output = await renderSchema(
            {
                type: "object",
                properties: { score: { ...pair, title: "MemberScore" } },
                required: ["score"],
            },
            { "just-types": true },
        );
        expect(output).toContain("MemberScore = tuple[str, float]");
        expect(output).toContain("    score: MemberScore");
        expect(output).not.toContain("from_member_score");
    });

    test.each([
        ["3.10", {}, "TopLevel = tuple[str, list['TopLevel']]"],
        [
            "3.7",
            { "python-version": "3.7" },
            "TopLevel = Tuple[str, List['TopLevel']]",
        ],
        [
            // pydantic recurses forever into a plain recursive alias.
            "pydantic",
            { "pydantic-base-model": true, "just-types": true },
            'TopLevel = TypeAliasType("TopLevel", "tuple[str, list[TopLevel]]")',
        ],
    ] as const)("a recursive tuple refers to itself: %s", async (_, options, expected) => {
        const output = await renderSchema(node, options);
        expect(output).toContain(expected);
    });

    test("pydantic's TypeAliasType comes from typing_extensions", async () => {
        const output = await renderSchema(node, {
            "pydantic-base-model": true,
        });
        expect(output).toContain("from typing_extensions import TypeAliasType");
    });

    test("a recursive tuple's converters call themselves", async () => {
        const output = await renderSchema(node);
        expect(output).toContain(
            "return from_tuple([from_str, lambda x: from_list(from_top_level, x)], x)",
        );
        expect(output).toContain(
            "return to_tuple([from_str, lambda x: from_list(to_top_level, x)], x)",
        );
    });

    test("tuples that contain each other", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { a: { $ref: "#/$defs/a" } },
            required: ["a"],
            $defs: {
                a: {
                    type: "array",
                    items: [
                        { type: "integer" },
                        { type: "array", items: { $ref: "#/$defs/b" } },
                    ],
                },
                b: {
                    type: "array",
                    items: [
                        { type: "string" },
                        { oneOf: [{ type: "null" }, { $ref: "#/$defs/a" }] },
                    ],
                },
            },
        });
        // The union with a name that isn't declared yet is quoted as a
        // whole: `'A' | None` would fail at runtime.
        expect(output).toContain("B = tuple[str, 'A | None']");
        expect(output).toContain("A = tuple[int, list[B]]");
    });

    test("a tuple that refers to a class declared later", async () => {
        const output = await renderSchema(
            {
                $ref: "#/$defs/holder",
                $defs: {
                    holder: {
                        type: "object",
                        properties: {
                            pairs: {
                                type: "array",
                                items: { $ref: "#/$defs/holderPair" },
                            },
                        },
                        required: ["pairs"],
                    },
                    holderPair: {
                        title: "HolderPair",
                        type: "array",
                        items: [
                            { $ref: "#/$defs/holder" },
                            { type: "integer" },
                        ],
                    },
                },
            },
            { "python-version": "3.7" },
        );
        expect(output).toContain("HolderPair = Tuple['TopLevel', int]");
        expect(output).toContain("    pairs: List[HolderPair]");
    });

    test("converters don't take the names of the helpers", async () => {
        const output = await renderSchema({
            type: "array",
            items: {
                title: "Str",
                type: "array",
                items: [{ type: "string" }],
            },
        });
        expect(output.match(/^def from_str\(/gm)).toHaveLength(1);
    });
});
