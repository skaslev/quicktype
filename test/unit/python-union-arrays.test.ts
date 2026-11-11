// Python keeps the arrays of JSON Schema array schemas whose items can be
// told apart in unions, as `list[A] | list[B]`, except for pydantic.
// `from_union` tries the arrays in turn, so the classes of their items
// reject unknown properties, and the encoders of their items reject the
// items of the others.

import {
    InputData,
    JSONSchemaInput,
    PythonTargetLanguage,
    type TargetLanguage,
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

function arrayOf(items: object): object {
    return { type: "array", items };
}

function closedObject(
    title: string,
    properties: Record<string, object>,
    required: string[],
): object {
    return {
        title,
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}

function withReply(anyOf: object[]): object {
    return {
        type: "object",
        properties: { reply: { anyOf } },
        required: ["reply"],
        additionalProperties: false,
    };
}

const stringsOrIntegers = withReply([
    arrayOf({ type: "string" }),
    arrayOf({ type: "integer" }),
]);

describe("support for unions with several arrays", () => {
    // A Python that keeps no arrays apart in just-types output.
    class OptionDependentPython extends PythonTargetLanguage {
        public getSupportsUnionsWithMultipleArrays(
            rendererOptions: Record<string, unknown> = {},
        ): boolean {
            return rendererOptions["just-types"] !== true;
        }
    }

    test.each([
        ["keeps arrays apart", {}, "    reply: list[str] | list[int]\n"],
        [
            "unifies them",
            { "just-types": true },
            "    reply: list[int | str]\n",
        ],
    ] as const)("can depend on the renderer options: %s", async (_, options, expected) => {
        const output = await renderSchema(
            stringsOrIntegers,
            options,
            new OptionDependentPython(),
        );
        expect(output).toContain(expected);
    });
});

const memberScore = closedObject(
    "MemberScore",
    { member: { type: "string" }, score: { type: "number" } },
    ["member", "score"],
);

// Like Redis' ZRANGE reply: members, or members with their scores.
const membersOrScores = withReply([
    arrayOf({ type: "string" }),
    arrayOf(memberScore),
]);

describe("types", () => {
    test.each([
        ["3.10", "    reply: list[str] | list[MemberScore]\n"],
        ["3.9", "    reply: Union[list[str], list[MemberScore]]\n"],
        ["3.7", "    reply: Union[List[str], List[MemberScore]]\n"],
    ])("a union of arrays in Python %s", async (version, expected) => {
        const output = await renderSchema(membersOrScores, {
            "just-types": true,
            "python-version": version,
        });
        expect(output).toContain(expected);
    });

    // pydantic 1 would take `[1, 2]` for `list[str]`, see
    // `getSupportsUnionsWithMultipleArrays`.
    test("pydantic unifies them", async () => {
        const output = await renderSchema(membersOrScores, {
            "just-types": true,
            "pydantic-base-model": true,
        });
        expect(output).toContain("    reply: list[MemberScore | str]\n");
    });
});

describe("converters", () => {
    test("try the arrays in turn", async () => {
        const output = await renderSchema(membersOrScores);
        expect(output).toContain(
            'reply = from_union([lambda x: from_list(from_str, x), lambda x: from_list(MemberScore.from_dict, x)], obj["reply"])',
        );
        expect(output).toContain(
            'result["reply"] = from_union([lambda x: from_list(from_str, x), lambda x: from_list(lambda x: to_class(MemberScore, x), x)], self.reply)',
        );
        // No other array has classes.
        expect(output).not.toContain("assert set(obj)");
    });

    // `from_list(A.from_dict, x)` would take a list of `B` values, which
    // have the property of `A`, too.
    test("the classes of arrays of classes reject unknown properties", async () => {
        const a = closedObject("A", { a: { type: "integer" } }, ["a"]);
        const b = closedObject(
            "B",
            { a: { type: "integer" }, b: { type: "string" } },
            ["a", "b"],
        );
        const c = closedObject("C", { c: { type: "integer" } }, ["c"]);
        const output = await renderSchema(
            withReply([arrayOf(a), arrayOf(arrayOf(b)), arrayOf(c)]),
        );
        expect(output).toContain(
            "    reply: list[A] | list[list[B]] | list[C]\n",
        );
        expect(output).toContain('        assert set(obj) <= {"a"}\n');
        expect(output).toContain('        assert set(obj) <= {"a", "b"}\n');
        expect(output).toContain('        assert set(obj) <= {"c"}\n');
    });

    // `str` takes any value, and `to_float` booleans.
    test("the items of arrays check their values", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                u: {
                    anyOf: [
                        arrayOf({ type: "string", format: "uuid" }),
                        arrayOf({ type: "integer" }),
                    ],
                },
                i: {
                    anyOf: [
                        arrayOf({ type: "string", format: "integer" }),
                        arrayOf({ type: "boolean" }),
                    ],
                },
                n: {
                    anyOf: [
                        arrayOf({ type: "number" }),
                        arrayOf({ type: "string", format: "boolean" }),
                    ],
                },
                f: arrayOf({ type: "number" }),
                g: { type: "string", format: "uuid" },
            },
            required: ["u", "i", "n", "f", "g"],
            additionalProperties: false,
        });
        expect(output).toContain(
            'result["u"] = from_union([lambda x: from_list(lambda x: str((lambda x: is_type(UUID, x))(x)), x), lambda x: from_list(from_int, x)], self.u)',
        );
        expect(output).toContain(
            'result["i"] = from_union([lambda x: from_list(lambda x: from_str((lambda x: str(from_int(x)))(x)), x), lambda x: from_list(from_bool, x)], self.i)',
        );
        expect(output).toContain(
            'result["n"] = from_union([lambda x: from_list(from_float, x), lambda x: from_list(lambda x: from_str((lambda x: str(from_bool(x)).lower())(x)), x)], self.n)',
        );
        // The same array type outside a union, and a UUID.
        expect(output).toContain('result["f"] = from_list(to_float, self.f)');
        expect(output).toContain('result["g"] = str(self.g)');
    });

    test("a transformed union keeps its arrays", async () => {
        const output = await renderSchema(
            withReply([
                arrayOf({ type: "number" }),
                arrayOf({ type: "string", format: "boolean" }),
                { type: "string", format: "integer" },
            ]),
        );
        expect(output).toContain("    reply: list[float] | list[bool] | int\n");
        expect(output).toContain(
            'reply = from_union([lambda x: int(from_str(x)), lambda x: from_union([lambda x: from_list(from_float, x), lambda x: from_list(lambda x: from_stringified_bool(from_str(x)), x)], x)], obj["reply"])',
        );
        expect(output).toContain(
            'result["reply"] = from_union([lambda x: from_str((lambda x: str((lambda x: is_type(int, x))(x)))(x)), lambda x: from_list(from_float, (lambda x: is_type(list, x))(x)), lambda x: from_list(lambda x: from_str((lambda x: str(from_bool(x)).lower())(x)), (lambda x: is_type(list, x))(x))], self.reply)',
        );
    });
});
