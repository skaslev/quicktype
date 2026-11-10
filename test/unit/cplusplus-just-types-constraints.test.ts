// C++ classes check the constraints of their members in their setters, with
// helpers (ClassMemberConstraints, CheckConstraint) that only the full output
// has.  Just-types output has neither the helpers nor the checks.

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
        rendererOptions,
    });
    return result.lines.join("\n");
}

const constrained = {
    type: "object",
    properties: {
        age: { type: "integer", minimum: 0, maximum: 150 },
        score: { type: "number", minimum: 0.5 },
        name: {
            type: "string",
            minLength: 1,
            maxLength: 20,
            pattern: "^[a-z]+$",
        },
    },
    required: ["age", "name"],
    additionalProperties: false,
};

describe("C++ just-types classes with constrained members", () => {
    test.each([
        "with-getter-setter",
        "with-struct",
    ])("don't check constraints (%s)", async (codeFormat) => {
        const output = await renderSchema(constrained, {
            "just-types": true,
            "code-format": codeFormat,
        });
        expect(output).toContain("int64_t age;");
        expect(output).not.toContain("ClassMemberConstraints");
        expect(output).not.toContain("CheckConstraint");
        expect(output).not.toContain("_constraint");
        expect(output).not.toContain("#include <regex>");
    });

    test("have plain setters", async () => {
        const output = await renderSchema(constrained, { "just-types": true });
        expect(output).toContain("TopLevel() = default;");
        expect(output).toContain(
            "void set_age(const int64_t & value) { this->age = value; }",
        );
    });

    test("the full output still checks constraints", async () => {
        const output = await renderSchema(constrained);
        expect(output).toContain("ClassMemberConstraints age_constraint;");
        expect(output).toContain(
            'void set_age(const int64_t & value) { CheckConstraint("age", age_constraint, value); this->age = value; }',
        );
    });
});
