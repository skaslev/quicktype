// A union of types of the same kind is unified into one type, which has the
// constraints (`minItems`, `minLength`, `minimum`, `pattern`, ...) of all
// of them combined.  A type without a constraint allows any value there, so
// the unified type only has the constraints that all of them have.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function render(
    lang: string,
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

    const result = await quicktype({ inputData, lang, rendererOptions });
    return result.lines.join("\n");
}

// The JSON Schema that quicktype makes of the property `p` of the top-level
// class, whose schema is `schema`.
async function propertySchema(schema: object): Promise<object> {
    const output = JSON.parse(
        await render("schema", {
            type: "object",
            properties: { p: schema },
            required: ["p"],
        }),
    );
    return output.definitions.TopLevel.properties.p;
}

const strings = { type: "array", items: { type: "string" } };

describe("a union of types of the same kind", () => {
    test("of arrays only some of which have minItems has none", async () => {
        for (const oneOf of [
            [strings, { ...strings, minItems: 1 }],
            [{ ...strings, minItems: 1 }, strings],
        ]) {
            expect(await propertySchema({ oneOf })).toEqual(strings);
            expect(
                await render("typescript", { oneOf }, { "just-types": true }),
            ).toContain("export type TopLevel = string[];");
        }
    });

    test("of arrays that all have minItems has the smallest", async () => {
        expect(
            await propertySchema({
                oneOf: [
                    { ...strings, minItems: 2, maxItems: 3 },
                    { ...strings, minItems: 1 },
                ],
            }),
        ).toEqual({ ...strings, minItems: 1 });
    });

    test("of strings only some of which have a constraint has none", async () => {
        for (const constraint of [
            { minLength: 3 },
            { maxLength: 3 },
            { pattern: "^a" },
        ]) {
            expect(
                await propertySchema({
                    oneOf: [
                        { type: "string", ...constraint },
                        { type: "string" },
                    ],
                }),
            ).toEqual({ type: "string" });
        }
    });

    test("of a constrained string and an enum has no constraint", async () => {
        expect(
            await propertySchema({
                oneOf: [{ type: "string", minLength: 3 }, { enum: ["x", "y"] }],
            }),
        ).toEqual({ type: "string" });
    });

    test("of a constrained string and a date-time has no constraint", async () => {
        expect(
            await propertySchema({
                oneOf: [
                    { type: "string", minLength: 3 },
                    { type: "string", format: "date-time" },
                ],
            }),
        ).toEqual({ type: "string" });
    });

    test("of integers only some of which have a minimum has none", async () => {
        expect(
            await propertySchema({
                oneOf: [{ type: "integer", minimum: 0 }, { type: "integer" }],
            }),
        ).toEqual({ type: "integer" });
    });

    test("of a constrained integer and a number has no constraint", async () => {
        expect(
            await propertySchema({
                oneOf: [{ type: "integer", minimum: 0 }, { type: "number" }],
            }),
        ).toEqual({ type: "number" });
    });
});
