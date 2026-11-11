// A union with a transformed member, like a string with `"format":
// "integer"` in Python, becomes a choice of decoders by JSON type.  If the
// union keeps several arrays apart, a JSON array is any of them, and all of
// them stay in the union, each with its converters.

import {
    InputData,
    JSONSchemaInput,
    PythonTargetLanguage,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

// Python transforms unions, but doesn't keep arrays apart in them.
class PythonWithUnionArrays extends PythonTargetLanguage {
    public get supportsUnionsWithMultipleArrays(): boolean {
        return true;
    }
}

async function renderSchema(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: new PythonWithUnionArrays(),
    });
    return result.lines.join("\n");
}

function arrayOf(items: object): object {
    return { type: "array", items };
}

const a = {
    title: "A",
    type: "object",
    properties: { a: { type: "integer" } },
    required: ["a"],
    additionalProperties: false,
};

function withV(anyOf: object[]): object {
    return {
        type: "object",
        properties: { v: { anyOf } },
        required: ["v"],
    };
}

describe("unions of arrays with transformed members", () => {
    test("keep all arrays", async () => {
        const output = await renderSchema(
            withV([
                arrayOf({ type: "string" }),
                arrayOf(a),
                { type: "string", format: "integer" },
            ]),
        );
        expect(output).toContain("    v: list[str] | list[A] | int\n");
        expect(output).toContain(
            'v = from_union([lambda x: int(from_str(x)), lambda x: from_union([lambda x: from_list(from_str, x), lambda x: from_list(A.from_dict, x)], x)], obj["v"])',
        );
        expect(output).toContain(
            'result["v"] = from_union([lambda x: from_str((lambda x: str((lambda x: is_type(int, x))(x)))(x)), lambda x: from_list(from_str, (lambda x: is_type(list, x))(x)), lambda x: from_list(lambda x: to_class(A, x), (lambda x: is_type(list, x))(x))], self.v)',
        );
    });

    test("keep all arrays with null", async () => {
        const output = await renderSchema(
            withV([
                arrayOf({ type: "string" }),
                arrayOf({ type: "integer" }),
                { type: "string", format: "boolean" },
                { type: "null" },
            ]),
        );
        expect(output).toContain(
            "    v: list[str] | list[int] | bool | None = None\n",
        );
        expect(output).toContain(
            'v = from_union([from_none, lambda x: from_stringified_bool(from_str(x)), lambda x: from_union([lambda x: from_list(from_str, x), lambda x: from_list(from_int, x)], x)], obj["v"])',
        );
    });
});

// Arrays are kept apart by the types their items decode into.
describe("unions of arrays of transformed items", () => {
    // The items of the first array, integer and UUID strings, are a union
    // that becomes a transformed type, which unions after
    // MakeTransformations don't take for any type.
    test("stay apart after transformations", async () => {
        const output = await renderSchema(
            withV([
                arrayOf({ type: "string", format: "integer" }),
                arrayOf({ type: "string", format: "uuid" }),
                arrayOf(a),
            ]),
        );
        expect(output).toContain("    v: list[int | UUID] | list[A]\n");
        expect(output).toContain(
            'v = from_union([lambda x: from_list(lambda x: from_union([lambda x: from_union([lambda x: int(x), lambda x: UUID(x)], from_str(x))], x), x), lambda x: from_list(A.from_dict, x)], obj["v"])',
        );
    });

    // An array of integer strings and one of integers both decode into
    // lists of integers, which can't be told apart to encode them.
    test.each([
        ["integer", "integer", "    v: list[int]\n"],
        ["number", "integer", "    v: list[float | int]\n"],
        ["boolean", "boolean", "    v: list[bool]\n"],
    ])("an array of %s and one of %s strings are unified", async (type, format, expected) => {
        const output = await renderSchema(
            withV([arrayOf({ type }), arrayOf({ type: "string", format })]),
        );
        expect(output).toContain(expected);
    });

    test("an array of bool strings and one of numbers stay apart", async () => {
        const output = await renderSchema(
            withV([
                arrayOf({ type: "string", format: "boolean" }),
                arrayOf({ type: "number" }),
            ]),
        );
        expect(output).toContain("    v: list[bool] | list[float]\n");
    });
});
