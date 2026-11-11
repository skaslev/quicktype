// A converter that returns a TypeVar must take a parameter that mentions
// it, or the TypeVar binds to nothing: mypy (since 0.981) rejects such a
// function ("A function returning TypeVar should receive at least one
// argument containing the same TypeVar").  The class parameter of
// is_type/to_enum is annotated `Type[T]`, which Python 3.6 output can't use
// (`typing.Type` is missing from 3.6.0), so there they return `Any`.

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
        lang: "python",
        rendererOptions,
    });
    return result.lines.join("\n");
}

// A class (to_class), an enum (to_enum), a union with a transformed member
// (is_type), an array (from_list) and a map (from_dict).
const converters = {
    type: "object",
    properties: {
        child: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
        },
        status: { type: "string", enum: ["ready", "done"] },
        value: {
            oneOf: [
                { type: "array", items: { type: "string" } },
                { type: "string", format: "integer" },
            ],
        },
        counts: { type: "object", additionalProperties: { type: "integer" } },
    },
    required: ["child", "status", "value", "counts"],
    additionalProperties: false,
};

// The TypeVars a file declares, and its functions' parameters and return
// annotations.
function typeVarsAndFunctions(output: string): {
    typeVars: string[];
    functions: { name: string; params: string; returns: string }[];
} {
    const typeVars = Array.from(
        output.matchAll(/^(\w+) = TypeVar\(/gm),
        (m) => m[1],
    );
    const functions = Array.from(
        output.matchAll(/^def (\w+)\((.*)\) -> (.+):$/gm),
        ([, name, params, returns]) => ({ name, params, returns }),
    );
    return { typeVars, functions };
}

test.each([
    "3.6",
    "3.7",
    "3.9",
    "3.10",
])("Python %s binds every TypeVar a converter returns", async (version) => {
    const output = await renderSchema(converters, {
        "python-version": version,
    });
    const { typeVars, functions } = typeVarsAndFunctions(output);
    for (const name of ["to_class", "to_enum", "is_type", "from_list"]) {
        expect(functions.map((f) => f.name)).toContain(name);
    }

    for (const { name, params, returns } of functions) {
        for (const tvar of typeVars) {
            if (new RegExp(`\\b${tvar}\\b`).test(returns)) {
                expect(params, name).toMatch(new RegExp(`\\b${tvar}\\b`));
            }
        }
    }
});

test("Python 3.6 returns Any from converters that take a class", async () => {
    const output = await renderSchema(converters, { "python-version": "3.6" });
    expect(output).toContain("def to_class(c, x: Any) -> dict:");
    expect(output).toContain("def to_enum(c, x: Any) -> Any:");
    expect(output).toContain("def is_type(t, x: Any) -> Any:");
    // No converter needs EnumT.
    expect(output).not.toContain("EnumT");
});

test("Python 3.7 keeps the TypeVars", async () => {
    const output = await renderSchema(converters, { "python-version": "3.7" });
    expect(output).toContain("def to_enum(c: Type[EnumT], x: Any) -> EnumT:");
    expect(output).toContain("def is_type(t: Type[T], x: Any) -> T:");
});
