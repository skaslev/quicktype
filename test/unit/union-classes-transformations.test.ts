// A union with a transformed member, like a string with `"format":
// "integer"` in Python, becomes a choice of decoders by JSON type.  If the
// union keeps several classes apart, a JSON object is any of them, and all of
// them stay in the union, each with its converters.

import {
    InputData,
    JSONSchemaInput,
    PythonTargetLanguage,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

// Python transforms unions, but doesn't keep classes apart in them.
class PythonWithUnionClasses extends PythonTargetLanguage {
    public get supportsUnionsWithMultipleClasses(): boolean {
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
        lang: new PythonWithUnionClasses(),
    });
    return result.lines.join("\n");
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

const a = closedObject("A", { a: { type: "integer" } }, ["a"]);
const b = closedObject("B", { b: { type: "string" } }, ["b"]);

function withV(anyOf: object[]): object {
    return {
        type: "object",
        properties: { v: { anyOf } },
        required: ["v"],
    };
}

describe("unions of classes with transformed members", () => {
    test("keep all classes", async () => {
        const output = await renderSchema(
            withV([a, b, { type: "string", format: "integer" }]),
        );
        expect(output).toContain("    v: A | B | int");
        expect(output).toContain(
            'v = from_union([lambda x: int(from_str(x)), lambda x: from_union([A.from_dict, B.from_dict], x)], obj["v"])',
        );
        expect(output).toContain(
            'result["v"] = from_union([lambda x: from_str((lambda x: str((lambda x: is_type(int, x))(x)))(x)), lambda x: to_class(A, (lambda x: is_type(A, x))(x)), lambda x: to_class(B, (lambda x: is_type(B, x))(x))], self.v)',
        );
        expect(output).toContain("class A:");
        expect(output).toContain("class B:");
    });

    test("keep all classes with null", async () => {
        const output = await renderSchema(
            withV([
                a,
                b,
                { type: "string", format: "boolean" },
                { type: "null" },
            ]),
        );
        expect(output).toContain("    v: A | B | bool | None");
        expect(output).toContain(
            'v = from_union([from_none, lambda x: from_stringified_bool(from_str(x)), lambda x: from_union([A.from_dict, B.from_dict], x)], obj["v"])',
        );
    });
});
