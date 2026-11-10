// Python keeps tuples with optional trailing items and a rest, except for
// pydantic, which has no rest tuples.  Which tuples a target keeps can
// depend on its renderer options.

import {
    InputData,
    JSONSchemaInput,
    PythonTargetLanguage,
    type TargetLanguage,
    type TupleSupport,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
    lang: string | TargetLanguage = "python",
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

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
};

describe("tuple support", () => {
    // A Python that keeps no tuples in just-types output.
    class OptionDependentPython extends PythonTargetLanguage {
        public getTupleSupport(
            rendererOptions: Record<string, unknown> = {},
        ): TupleSupport {
            return rendererOptions["just-types"] === true ? "none" : "fixed";
        }
    }

    test.each([
        ["keeps tuples", {}, "    pair: tuple[str, float]"],
        ["has none", { "just-types": true }, "    pair: list[float | str]"],
    ] as const)("can depend on the renderer options: %s", async (_, options, expected) => {
        const output = await renderSchema(
            {
                type: "object",
                properties: { pair },
                required: ["pair"],
            },
            options,
            new OptionDependentPython(),
        );
        expect(output).toContain(expected);
    });
});

const withX = (x: object): object => ({
    type: "object",
    properties: { x },
    required: ["x"],
});

// [str, float?, bool?]
const optional = {
    type: "array",
    prefixItems: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
    minItems: 1,
};

// [int, ...str]
const rest = {
    type: "array",
    prefixItems: [{ type: "integer" }],
    items: { type: "string" },
};

describe("optional items", () => {
    test.each([
        [
            "3.10",
            {},
            "    x: tuple[str] | tuple[str, float] | tuple[str, float, bool]",
        ],
        [
            "3.9",
            { "python-version": "3.9" },
            "    x: Union[tuple[str], tuple[str, float], tuple[str, float, bool]]",
        ],
        [
            "3.7",
            { "python-version": "3.7" },
            "    x: Union[Tuple[str], Tuple[str, float], Tuple[str, float, bool]]",
        ],
        [
            "just types",
            { "just-types": true },
            "    x: tuple[str] | tuple[str, float] | tuple[str, float, bool]",
        ],
    ] as const)("are a tuple for each length: %s", async (_, options, expected) => {
        expect(await renderSchema(withX(optional), options)).toContain(
            expected,
        );
    });

    test("may all be missing", async () => {
        const output = await renderSchema(
            withX({
                type: "array",
                prefixItems: [{ type: "string" }],
                minItems: 0,
            }),
        );
        expect(output).toContain("    x: tuple[()] | tuple[str]");
    });

    test("a rest that maxItems bounds becomes optional items", async () => {
        const output = await renderSchema(
            withX({
                type: "array",
                prefixItems: [{ type: "string" }],
                items: { type: "integer" },
                minItems: 1,
                maxItems: 3,
            }),
        );
        expect(output).toContain(
            "    x: tuple[str] | tuple[str, int] | tuple[str, int, int]",
        );
    });

    test.each([
        [
            "3.10",
            {},
            "    x: tuple[str] | tuple[str, float] | tuple[str, float, bool] | None = None",
        ],
        [
            "3.7",
            { "python-version": "3.7" },
            "    x: Optional[Union[Tuple[str], Tuple[str, float], Tuple[str, float, bool]]] = None",
        ],
    ] as const)("join the union they're in: %s", async (_, options, expected) => {
        const output = await renderSchema(
            withX({ anyOf: [{ type: "null" }, optional] }),
            options,
        );
        expect(output).toContain(expected);
    });

    test("convert the items present", async () => {
        const output = await renderSchema(withX(optional));
        expect(output).toContain(
            'x = from_tuple([from_str, from_float, from_bool], obj["x"], min_items=1)',
        );
        expect(output).toContain(
            'result["x"] = to_tuple([from_str, to_float, from_bool], self.x, min_items=1)',
        );
    });
});

describe("a rest", () => {
    test.each([
        ["3.10", {}, "    x: tuple[int, Unpack[tuple[str, ...]]]"],
        [
            "3.7",
            { "python-version": "3.7" },
            "    x: Tuple[int, Unpack[Tuple[str, ...]]]",
        ],
        [
            "just types",
            { "just-types": true },
            "    x: tuple[int, Unpack[tuple[str, ...]]]",
        ],
    ] as const)("is unpacked: %s", async (_, options, expected) => {
        const output = await renderSchema(withX(rest), options);
        expect(output).toContain(expected);
        expect(output).toContain("from typing_extensions import Unpack");
    });

    test("follows the optional items", async () => {
        const output = await renderSchema(
            withX({
                ...rest,
                prefixItems: [{ type: "integer" }, { type: "boolean" }],
                minItems: 1,
            }),
        );
        expect(output).toContain(
            "    x: tuple[int] | tuple[int, bool, Unpack[tuple[str, ...]]]",
        );
        expect(output).toContain(
            'x = from_tuple([from_int, from_bool], obj["x"], min_items=1, rest=from_str)',
        );
    });

    test("converts every element", async () => {
        const output = await renderSchema(withX(rest));
        expect(output).toContain(
            'x = from_tuple([from_int], obj["x"], rest=from_str)',
        );
        expect(output).toContain(
            'result["x"] = to_tuple([from_int], self.x, rest=from_str)',
        );
        expect(output).toContain(
            [
                "def from_tuple(fs: list[Callable[[Any], Any]], x: Any, min_items: int | None = None, rest: Callable[[Any], Any] | None = None) -> tuple[Any, ...]:",
                "    assert isinstance(x, list) and (len(fs) if min_items is None else min_items) <= len(x)",
                "    assert len(x) <= len(fs) or rest is not None",
                "    result = [f(y) for (f, y) in zip(fs, x)]",
                "    if rest is not None:",
                "        result += [rest(y) for y in x[len(fs):]]",
                "    return tuple(result)",
            ].join("\n"),
        );
    });

    test("has no type hints in 3.5", async () => {
        const output = await renderSchema(withX(rest), {
            "python-version": "3.5",
        });
        expect(output).toContain(
            "def from_tuple(fs, x, min_items=None, rest=None):",
        );
        expect(output).not.toContain("typing_extensions");
    });
});

describe("named tuples", () => {
    // CLUSTER SLOTS: start and end slot, the master, and the replicas.
    const clusterSlots = {
        type: "array",
        items: {
            title: "SlotRange",
            type: "array",
            minItems: 3,
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
                items: [{ type: "string" }, { type: "integer" }],
            },
        },
    };

    test("a titled tuple with a rest", async () => {
        const output = await renderSchema(clusterSlots);
        expect(output).toContain(
            "SlotRange = tuple[int, int, SlotNode, Unpack[tuple[SlotNode, ...]]]",
        );
        expect(output).toContain(
            "    return from_tuple([from_int, from_int, from_slot_node], x, rest=from_slot_node)",
        );
        expect(output).toContain(
            "    return to_tuple([from_int, from_int, to_slot_node], x, rest=to_slot_node)",
        );
        expect(output).toContain(
            "def top_level_from_dict(s: Any) -> list[SlotRange]:",
        );
    });

    test("a tuple whose rest is itself", async () => {
        const output = await renderSchema({
            $ref: "#/$defs/node",
            $defs: {
                node: {
                    type: "array",
                    prefixItems: [{ type: "string" }],
                    items: { $ref: "#/$defs/node" },
                },
            },
        });
        expect(output).toContain(
            "TopLevel = tuple[str, Unpack[tuple['TopLevel', ...]]]",
        );
        expect(output).toContain(
            "    return from_tuple([from_str], x, rest=from_top_level)",
        );
    });
});

describe("pydantic", () => {
    test.each([
        ["optional items", optional],
        ["a rest", rest],
    ] as const)("keeps an array for a tuple with %s", async (_, x) => {
        const output = await renderSchema(withX(x), {
            "pydantic-base-model": true,
            "just-types": true,
        });
        expect(output).toContain("    x: list[");
        expect(output).not.toContain("Unpack");
    });

    test("keeps fixed-length tuples", async () => {
        const output = await renderSchema(
            withX({ type: "array", prefixItems: [{ type: "string" }] }),
            { "pydantic-base-model": true, "just-types": true },
        );
        expect(output).toContain("    x: tuple[str]");
    });
});

describe("unions with transformed members", () => {
    test("try the tuples that take fewer lengths first", async () => {
        const output = await renderSchema(
            withX({
                anyOf: [
                    { type: "string", format: "integer" },
                    { type: "array", items: { type: "string" } },
                    {
                        type: "array",
                        prefixItems: [{ type: "string" }],
                        items: { type: "integer" },
                    },
                    {
                        type: "array",
                        prefixItems: [{ type: "boolean" }, { type: "boolean" }],
                        minItems: 1,
                    },
                    { type: "array", prefixItems: [{ type: "number" }] },
                ],
            }),
        );
        expect(output).toContain(
            "lambda x: from_union([lambda x: from_tuple([from_float], x), lambda x: from_tuple([from_bool, from_bool], x, min_items=1), lambda x: from_tuple([from_str], x, rest=from_int), lambda x: from_list(from_str, x)], x)",
        );
    });
});
