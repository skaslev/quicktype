// C++ holds an optional property in an optional, empty if the property is
// absent.  Without --hide-null-optional, to_json wrote every empty optional
// as null, but from_json rejects null for an optional property that isn't
// nullable ("Unexpected null"), so the output of an object without such a
// property didn't read back.  Such properties are left out when empty;
// nullable ones are still written as null.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function render(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({
        inputData,
        lang: "cplusplus",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const optionals = {
    type: "object",
    properties: {
        opt: { type: "string" },
        optUnion: { oneOf: [{ type: "string" }, { type: "integer" }] },
        optNullable: { type: ["string", "null"] },
        optAny: {},
        n: { type: "integer" },
    },
    required: ["n"],
    additionalProperties: false,
};

describe("C++ absent optional properties", () => {
    test("aren't written as null if they aren't nullable", async () => {
        const output = await render(optionals);
        expect(output).toContain(
            'if (j.find("opt") != j.end() && j.at("opt").is_null()) throw std::runtime_error("Unexpected null");',
        );
        expect(output).toMatch(
            /if \(x\.get_opt\(\)\) \{\s+j\["opt"\] = x\.get_opt\(\);\s+\}/,
        );
        expect(output).toMatch(
            /if \(x\.get_opt_union\(\)\) \{\s+j\["optUnion"\] = x\.get_opt_union\(\);\s+\}/,
        );
    });

    test("without getters and setters", async () => {
        const output = await render(optionals, {
            "code-format": "with-struct",
        });
        expect(output).toMatch(/if \(x\.opt\) \{\s+j\["opt"\] = x\.opt;\s+\}/);
    });

    test("are written as null if they're nullable", async () => {
        const output = await render(optionals);
        expect(output).toContain('j["optNullable"] = x.get_opt_nullable();');
        expect(output).toContain('j["optAny"] = x.get_opt_any();');
        expect(output).not.toContain("if (x.get_opt_nullable())");
    });

    test("are left out with --hide-null-optional, nullable or not", async () => {
        const output = await render(optionals, { "hide-null-optional": true });
        expect(output).toContain("if (x.get_opt()) {");
        expect(output).toContain("if (x.get_opt_nullable()) {");
        expect(output).toContain("if (!x.get_opt_any().is_null()) {");
    });
});
