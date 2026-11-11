// For targets that support unions with several arrays, a union keeps the
// array types of JSON Schema array schemas apart if their item types can be
// told apart.  Every other array type in a union, and every union of a
// target without the support, is unified into a single array of the union of
// the item types, as before.

import {
    InputData,
    JSONSchemaInput,
    RustTargetLanguage,
    type TargetLanguage,
    TypeScriptTargetLanguage,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

class TypeScriptWithUnionArrays extends TypeScriptTargetLanguage {
    public get supportsUnionsWithMultipleArrays(): boolean {
        return true;
    }

    public get supportsUnionsWithMultipleClasses(): boolean {
        return false;
    }
}

class TypeScriptWithUnionArraysAndClasses extends TypeScriptWithUnionArrays {
    public get supportsUnionsWithMultipleClasses(): boolean {
        return true;
    }
}

class TypeScriptWithoutUnionArrays extends TypeScriptTargetLanguage {
    public get supportsUnionsWithMultipleArrays(): boolean {
        return false;
    }
}

class RustWithUnionArrays extends RustTargetLanguage {
    public get supportsUnionsWithMultipleArrays(): boolean {
        return true;
    }
}

async function render(
    schema: object,
    lang: TargetLanguage,
    rendererOptions: Record<string, string | boolean>,
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

async function renderSchema(
    schema: object,
    lang: TargetLanguage = new TypeScriptWithUnionArrays(),
): Promise<string> {
    return await render(schema, lang, {
        "just-types": true,
        "explicit-unions": true,
    });
}

function arrayOf(items: object | boolean, extra: object = {}): object {
    return { type: "array", items, ...extra };
}

// Explicit unions declare the item union.
const merged = [
    "export type TopLevel = TopLevelElement[];",
    "",
    "export type TopLevelElement = number | string;",
].join("\n");

const strings = arrayOf({ type: "string" });
const integers = arrayOf({ type: "integer" });

function closedObject(property: string, type: string): object {
    return {
        type: "object",
        properties: { [property]: { type } },
        required: [property],
        additionalProperties: false,
    };
}

describe("unions keep arrays apart", () => {
    test("of a oneOf", async () => {
        expect(await renderSchema({ oneOf: [strings, integers] })).toContain(
            "export type TopLevel = string[] | number[];",
        );
    });

    test("of tuples and of strings", async () => {
        const output = await renderSchema({
            anyOf: [
                strings,
                arrayOf({
                    title: "MemberScore",
                    type: "array",
                    items: [{ type: "string" }, { type: "number" }],
                }),
            ],
        });
        // Without tuples, the tuples are arrays of the union of their items.
        expect(output).toMatch(
            /^export type TopLevel = string\[\] \| (Array<.*>|MemberScore\[\]);$/m,
        );
        expect(output).not.toContain("Array<string |");
    });

    test("next to other types", async () => {
        const output = await renderSchema({
            oneOf: [{ type: "null" }, { type: "string" }, strings, integers],
        });
        expect(output).toContain(
            "export type TopLevel = string[] | number[] | null | string;",
        );
    });

    test("that are nested", async () => {
        expect(
            await renderSchema({
                oneOf: [arrayOf(strings), arrayOf(integers)],
            }),
        ).toContain(
            "export type TopLevel = Array<string[]> | Array<number[]>;",
        );
    });

    test("of unions", async () => {
        expect(
            await renderSchema({
                oneOf: [
                    arrayOf({ title: "Scalar", type: ["string", "boolean"] }),
                    integers,
                ],
            }),
        ).toContain("export type TopLevel = Scalar[] | number[];");
    });

    test("grouped by item types that can't be told apart", async () => {
        expect(
            await renderSchema({
                oneOf: [
                    strings,
                    arrayOf({ title: "Scalar", type: ["string", "boolean"] }),
                    integers,
                ],
            }),
        ).toContain("export type TopLevel = Scalar[] | number[];");
    });

    test("that contain themselves", async () => {
        expect(
            await renderSchema({
                $ref: "#/$defs/Tree",
                $defs: {
                    Tree: {
                        oneOf: [arrayOf({ $ref: "#/$defs/Tree" }), strings],
                    },
                },
            }),
        ).toContain("export type TopLevel = TopLevel[] | string[];");
    });

    test("of classes the union keeps apart", async () => {
        expect(
            await renderSchema(
                {
                    oneOf: [
                        arrayOf(closedObject("a", "integer")),
                        arrayOf(closedObject("b", "string")),
                    ],
                },
                new TypeScriptWithUnionArraysAndClasses(),
            ),
        ).toMatch(/^export type TopLevel = (\w+)\[\] \| (\w+)\[\];$/m);
    });

    test("of classes and of strings", async () => {
        expect(
            await renderSchema({
                oneOf: [
                    arrayOf({ title: "A", ...closedObject("a", "integer") }),
                    strings,
                ],
            }),
        ).toContain("export type TopLevel = A[] | string[];");
    });

    // The items are an intersection until it's resolved, which can be after
    // the union of the arrays is flattened.
    test("of intersections", async () => {
        const output = await renderSchema({
            oneOf: [
                strings,
                arrayOf({
                    title: "Item",
                    type: "object",
                    properties: { a: { type: "integer" } },
                    oneOf: [
                        { required: ["a"] },
                        { properties: { b: { type: "string" } } },
                    ],
                }),
            ],
        });
        expect(output).toContain("export type TopLevel = string[] | Item[];");
    });
});

describe("unions unify arrays", () => {
    test("for targets without the support", async () => {
        expect(
            await renderSchema(
                { oneOf: [strings, integers] },
                new TypeScriptWithoutUnionArrays(),
            ),
        ).toContain(merged);
    });

    test("of the same item types", async () => {
        expect(
            await renderSchema({
                oneOf: [
                    strings,
                    arrayOf({ type: "string" }, { uniqueItems: true }),
                ],
            }),
        ).toContain("export type TopLevel = string[];");
    });

    test("of strings and enums", async () => {
        expect(
            await renderSchema({
                oneOf: [strings, arrayOf({ enum: ["x", "y"] })],
            }),
        ).toContain("export type TopLevel = string[];");
    });

    test("of integers and numbers", async () => {
        expect(
            await renderSchema({
                oneOf: [integers, arrayOf({ type: "number" })],
            }),
        ).toContain("export type TopLevel = number[];");
    });

    test("of item types that overlap", async () => {
        expect(
            await renderSchema({
                oneOf: [strings, arrayOf({ type: ["string", "integer"] })],
            }),
        ).toContain(merged);
    });

    test("with any items", async () => {
        expect(
            await renderSchema({ oneOf: [strings, { type: "array" }] }),
        ).toContain("export type TopLevel = unknown[];");
    });

    // The only array of no items is the empty one, which is an array of
    // strings, too.
    test("with no items", async () => {
        expect(
            await renderSchema({ oneOf: [strings, arrayOf(false)] }),
        ).toContain("export type TopLevel = string[];");
    });

    test("of classes", async () => {
        const output = await renderSchema({
            oneOf: [
                arrayOf(closedObject("a", "integer")),
                arrayOf(closedObject("b", "string")),
            ],
        });
        expect(output).toMatch(/^export type TopLevel = (\w+)\[\];$/m);
        expect(output).toContain("    a?: number;\n    b?: string;");
    });

    test("of classes that allow additional properties", async () => {
        const output = await renderSchema(
            {
                oneOf: [
                    arrayOf({
                        type: "object",
                        properties: { a: { type: "integer" } },
                    }),
                    arrayOf({
                        type: "object",
                        properties: { b: { type: "string" } },
                    }),
                ],
            },
            new TypeScriptWithUnionArraysAndClasses(),
        );
        expect(output).toMatch(/^export type TopLevel = (\w+)\[\];$/m);
    });
});

describe("union members", () => {
    // Before, they were the descriptions of the array unifying them.
    test("give their descriptions to the union", async () => {
        const output = await renderSchema({
            oneOf: [
                { ...strings, description: "Some strings." },
                { ...integers, description: "Some integers." },
            ],
        });
        expect(output).toContain(
            [
                "/**",
                " * Some strings.",
                " *",
                " * Some integers.",
                " */",
                "export type TopLevel = string[] | number[];",
            ].join("\n"),
        );
    });

    test("are named after the item types", async () => {
        const output = await render(
            {
                oneOf: [
                    strings,
                    arrayOf({ title: "Scalar", type: ["integer", "boolean"] }),
                    arrayOf(arrayOf({ type: "number" })),
                ],
            },
            new RustWithUnionArrays(),
            { density: "dense" },
        );
        expect(output).toContain(
            [
                "pub enum TopLevel {",
                "    DoubleArrayArray(Vec<Vec<f64>>),",
                "    ScalarArray(Vec<Scalar>),",
                "    StringArray(Vec<String>),",
                "}",
            ].join("\n"),
        );
    });
});
