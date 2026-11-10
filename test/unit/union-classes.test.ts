// For targets that support unions with several classes, a union keeps the
// object types of different JSON Schema object schemas apart if they forbid
// additional properties.  Every other object type in a union, and every
// union of a target without the support, is unified into a single class, as
// before.

import {
    InputData,
    JSONSchemaInput,
    TypeScriptTargetLanguage,
    jsonInputForTargetLanguage,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

class TypeScriptWithUnionClasses extends TypeScriptTargetLanguage {
    public get supportsUnionsWithMultipleClasses(): boolean {
        return true;
    }
}

class TypeScriptWithoutUnionClasses extends TypeScriptTargetLanguage {
    public get supportsUnionsWithMultipleClasses(): boolean {
        return false;
    }
}

const rendererOptions = { "just-types": true, "explicit-unions": true };

async function renderSchema(
    schema: object,
    supportsUnionClasses = true,
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
        lang: supportsUnionClasses
            ? new TypeScriptWithUnionClasses()
            : new TypeScriptWithoutUnionClasses(),
        rendererOptions,
    });
    return result.lines.join("\n");
}

function closedObject(
    properties: Record<string, object>,
    required: string[],
): object {
    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}

const defs = {
    A: closedObject({ a: { type: "integer" }, c: { type: "string" } }, ["a"]),
    B: closedObject({ b: { type: "string" }, c: { type: "string" } }, ["b"]),
};

const aOrB = {
    oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
    $defs: defs,
};

const unified = [
    "export interface TopLevel {",
    "    a?: number;",
    "    c?: string;",
    "    b?: string;",
    "}",
].join("\n");

describe("unions keep classes apart", () => {
    test("of a oneOf", async () => {
        const output = await renderSchema(aOrB);
        expect(output).toContain("export type TopLevel = A | B;");
        expect(output).toContain(
            [
                "export interface A {",
                "    a:  number;",
                "    c?: string;",
                "}",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "export interface B {",
                "    b:  string;",
                "    c?: string;",
                "}",
            ].join("\n"),
        );
    });

    test("next to other types", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                u: {
                    anyOf: [
                        { $ref: "#/$defs/A" },
                        { $ref: "#/$defs/B" },
                        { type: "string" },
                        { type: "null" },
                    ],
                },
            },
            required: ["u"],
            additionalProperties: false,
            $defs: defs,
        });
        expect(output).toContain("export type U = A | B | null | string;");
    });

    test("reached more than once", async () => {
        const output = await renderSchema({
            oneOf: [
                { $ref: "#/$defs/A" },
                { $ref: "#/$defs/A" },
                { $ref: "#/$defs/B" },
            ],
            $defs: defs,
        });
        expect(output).toContain("export type TopLevel = A | B;");
    });

    test("that contain the union", async () => {
        const output = await renderSchema({
            $ref: "#/$defs/Node",
            $defs: {
                Node: {
                    oneOf: [
                        { $ref: "#/$defs/Leaf" },
                        { $ref: "#/$defs/Branch" },
                    ],
                },
                Leaf: closedObject({ value: { type: "integer" } }, ["value"]),
                Branch: closedObject(
                    {
                        children: {
                            type: "array",
                            items: { $ref: "#/$defs/Node" },
                        },
                    },
                    ["children"],
                ),
            },
        });
        expect(output).toContain("export type TopLevel = Leaf | Branch;");
        expect(output).toContain("children: TopLevel[];");
    });

    test("made by an allOf", async () => {
        const output = await renderSchema({
            oneOf: [
                { $ref: "#/$defs/A" },
                {
                    title: "Derived",
                    allOf: [
                        { $ref: "#/$defs/A" },
                        closedObject({ d: { type: "number" } }, ["d"]),
                    ],
                },
            ],
            $defs: defs,
        });
        expect(output).toContain("export type TopLevel = A | Derived;");
        expect(output).toContain("    d:  number;");
    });
});

describe("unions unify classes", () => {
    test("for targets without the support", async () => {
        expect(await renderSchema(aOrB, false)).toContain(unified);
    });

    test("that allow additional properties", async () => {
        const output = await renderSchema({
            oneOf: [
                { $ref: "#/$defs/A" },
                {
                    type: "object",
                    properties: { b: { type: "string" } },
                    required: ["b"],
                },
            ],
            $defs: defs,
        });
        expect(output).toContain("export interface TopLevel {");
        expect(output).not.toContain("export type TopLevel");
    });

    test("unified with one that allows additional properties", async () => {
        const output = await renderSchema({
            oneOf: [{ $ref: "#/$defs/AOrOpen" }, { $ref: "#/$defs/B" }],
            $defs: {
                ...defs,
                AOrOpen: {
                    allOf: [
                        {
                            type: "object",
                            properties: { d: { type: "number" } },
                        },
                        {
                            oneOf: [
                                { $ref: "#/$defs/A" },
                                {
                                    type: "object",
                                    properties: { o: { type: "integer" } },
                                },
                            ],
                        },
                    ],
                },
            },
        });
        expect(output).toContain("export interface TopLevel {");
        expect(output).not.toContain("export type TopLevel");
    });

    test("with pattern properties", async () => {
        const output = await renderSchema({
            oneOf: [
                { $ref: "#/$defs/A" },
                {
                    ...defs.B,
                    patternProperties: { "^x-": { type: "string" } },
                },
            ],
            $defs: defs,
        });
        expect(output).toContain("export interface TopLevel {");
        expect(output).not.toContain("export type TopLevel");
    });

    test("of an allOf", async () => {
        const output = await renderSchema({
            allOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
            $defs: defs,
        });
        expect(output).toContain(
            [
                "export interface TopLevel {",
                "    a:  number;",
                "    c?: string;",
                "    b:  string;",
                "}",
            ].join("\n"),
        );
    });

    // Keeping the classes apart would distribute the intersection over the
    // union, which can make classes that are impossible.
    test("intersected with another object", async () => {
        const output = await renderSchema({
            allOf: [closedObject({ c: { type: "string" } }, ["c"]), aOrB],
            $defs: defs,
        });
        expect(output).toContain(
            [
                "export interface TopLevel {",
                "    c:  string;",
                "    a?: number;",
                "    b?: string;",
                "}",
            ].join("\n"),
        );
    });

    test("from JSON samples", async () => {
        const jsonInput = jsonInputForTargetLanguage(
            new TypeScriptWithUnionClasses(),
        );
        await jsonInput.addSource({
            name: "TopLevel",
            samples: [JSON.stringify([{ a: 1 }, { b: "x" }])],
        });
        const inputData = new InputData();
        inputData.addInput(jsonInput);
        const result = await quicktype({
            inputData,
            lang: new TypeScriptWithUnionClasses(),
            rendererOptions,
        });
        expect(result.lines.join("\n")).toContain(
            [
                "export interface TopLevelElement {",
                "    a?: number;",
                "    b?: string;",
                "}",
            ].join("\n"),
        );
    });
});
