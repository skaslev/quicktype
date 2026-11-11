// For targets that support unions with several classes or arrays, an
// intersection with a union that keeps several object or array types apart,
// such as an object schema next to a `oneOf` of object schemas, is the union
// of the intersections with each of them, if those can be kept apart, too.
// Otherwise the intersection unifies them, as before.

import {
    InputData,
    JSONSchemaInput,
    type TargetLanguage,
    TypeScriptTargetLanguage,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

class TypeScriptWithUnions extends TypeScriptTargetLanguage {
    public get supportsUnionsWithMultipleClasses(): boolean {
        return true;
    }

    public get supportsUnionsWithMultipleArrays(): boolean {
        return true;
    }
}

class TypeScriptWithoutUnions extends TypeScriptTargetLanguage {
    public get supportsUnionsWithMultipleClasses(): boolean {
        return false;
    }

    public get supportsUnionsWithMultipleArrays(): boolean {
        return false;
    }
}

async function renderSchema(
    schema: object,
    lang: TargetLanguage = new TypeScriptWithUnions(),
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
        lang,
        rendererOptions: { "just-types": true, "explicit-unions": true },
        checkProvenance: true,
    });
    return result.lines.join("\n");
}

function lines(...ls: string[]): string {
    return ls.join("\n");
}

// A discriminated union written with the shared properties at the top.
const discriminated = {
    type: "object",
    properties: {
        kind: { enum: ["A", "B"] },
        a: { type: "integer" },
        b: { type: "string" },
    },
    required: ["kind"],
    additionalProperties: false,
    oneOf: [
        { properties: { kind: { const: "A" } }, required: ["a"] },
        { properties: { kind: { const: "B" } }, required: ["b"] },
    ],
};

// One of two properties, exactly or at least.
function oneOfTwo(kind: "oneOf" | "anyOf"): object {
    return {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "string" } },
        additionalProperties: false,
        [kind]: [{ required: ["a"] }, { required: ["b"] }],
    };
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
    A: closedObject({ a: { type: "integer" } }, ["a"]),
    B: closedObject({ b: { type: "string" } }, ["b"]),
    MemberScore: closedObject(
        { member: { type: "string" }, score: { type: "number" } },
        ["member", "score"],
    ),
};

// Closed object schemas under one that allows additional properties.
const closedCases = {
    type: "object",
    oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
    $defs: defs,
};

// Array schemas of different items under one that doesn't say which.
const arrays = {
    type: "array",
    oneOf: [
        { items: { type: "string" } },
        { items: { $ref: "#/$defs/MemberScore" } },
    ],
    $defs: defs,
};

describe("intersections distribute over unions", () => {
    test("of the cases of a discriminated union", async () => {
        const output = await renderSchema(discriminated);
        expect(output).toContain(
            "export type TopLevel = PurpleTopLevel | FluffyTopLevel;",
        );
        // The other case's property is allowed, but not required.
        expect(output).toMatch(
            /export interface PurpleTopLevel \{\n {4}a: {4}number;\n {4}b\?: {3}string;\n {4}kind: (\w+);\n\}\n\nexport type \1 = "A";/,
        );
        expect(output).toMatch(
            /export interface FluffyTopLevel \{\n {4}a\?: {3}number;\n {4}b: {4}string;\n {4}kind: (\w+);\n\}\n\nexport type \1 = "B";/,
        );
    });

    // A value of one case must not be one of the other, so each case can't
    // have the property that the other requires.
    test("of a oneOf that requires one of two properties", async () => {
        const output = await renderSchema(oneOfTwo("oneOf"));
        expect(output).toContain(
            lines(
                "export type TopLevel = PurpleTopLevel | FluffyTopLevel;",
                "",
                "export interface PurpleTopLevel {",
                "    a: number;",
                "}",
                "",
                "export interface FluffyTopLevel {",
                "    b: string;",
                "}",
            ),
        );
    });

    test("of an anyOf that requires one of two properties", async () => {
        const output = await renderSchema(oneOfTwo("anyOf"));
        expect(output).toContain(
            lines(
                "export type TopLevel = PurpleTopLevel | FluffyTopLevel;",
                "",
                "export interface PurpleTopLevel {",
                "    a:  number;",
                "    b?: string;",
                "}",
                "",
                "export interface FluffyTopLevel {",
                "    a?: number;",
                "    b:  string;",
                "}",
            ),
        );
    });

    test("of closed object schemas", async () => {
        const output = await renderSchema(closedCases);
        expect(output).toContain("export type TopLevel = A | B;");
        expect(output).toContain(
            lines("export interface A {", "    a: number;", "}"),
        );
        expect(output).toContain(
            lines("export interface B {", "    b: string;", "}"),
        );
    });

    test("of closed object schemas declaring the shared properties", async () => {
        const output = await renderSchema({
            properties: { c: { type: "string" } },
            oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
            $defs: {
                A: closedObject(
                    { a: { type: "integer" }, c: { type: "string" } },
                    ["a"],
                ),
                B: closedObject(
                    { b: { type: "string" }, c: { type: "string" } },
                    ["b"],
                ),
            },
        });
        expect(output).toContain("export type TopLevel = A | B;");
        expect(output).toContain(
            lines("export interface A {", "    c?: string;", "    a:  number;"),
        );
    });

    // Each case narrows a property to one of the union outside.
    test("of cases narrowing a property", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                x: { oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }] },
            },
            additionalProperties: false,
            oneOf: [
                { properties: { x: { $ref: "#/$defs/A" } }, required: ["x"] },
                { properties: { x: { $ref: "#/$defs/B" } } },
            ],
            $defs: defs,
        });
        expect(output).toContain(
            lines(
                "export type TopLevel = PurpleTopLevel | FluffyTopLevel;",
                "",
                "export interface PurpleTopLevel {",
                "    x: A;",
                "}",
                "",
                "export interface A {",
                "    a: number;",
                "}",
                "",
                "export interface FluffyTopLevel {",
                "    x?: B;",
                "}",
                "",
                "export interface B {",
                "    b: string;",
                "}",
            ),
        );
    });

    test("of array schemas", async () => {
        const output = await renderSchema(arrays);
        expect(output).toContain(
            "export type TopLevel = string[] | MemberScore[];",
        );
    });

    // A property of types with no values in common must be absent.
    test("leaving out optional properties without values", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" } },
            additionalProperties: false,
            oneOf: [
                { properties: { a: { type: "integer" } }, required: ["b"] },
                { required: ["a", "b"] },
            ],
        });
        expect(output).toContain(
            lines(
                "export type TopLevel = PurpleTopLevel | FluffyTopLevel;",
                "",
                "export interface PurpleTopLevel {",
                "    b: string;",
                "}",
            ),
        );
    });
});

describe("intersections unify unions", () => {
    test("of objects that allow additional properties", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { a: { type: "integer" }, b: { type: "string" } },
            oneOf: [{ required: ["a"] }, { required: ["b"] }],
        });
        expect(output).toContain(
            lines(
                "export interface TopLevel {",
                "    a?: number;",
                "    b?: string;",
                "    [property: string]: unknown;",
                "}",
            ),
        );
    });

    // The other cases' properties aren't allowed by the case of closed
    // object schemas.  quicktype keeps them, though, so the case would
    // have properties it doesn't allow, or be impossible.
    test("with properties a closed object schema doesn't declare", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { c: { type: "string" } },
            oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
            $defs: defs,
        });
        expect(output).toContain(
            lines(
                "export interface TopLevel {",
                "    c?: string;",
                "    a?: number;",
                "    b?: string;",
                "}",
            ),
        );
    });

    test("with a required property that isn't allowed", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { a: { type: "integer" } },
            additionalProperties: false,
            oneOf: [
                { properties: { b: { type: "string" } }, required: ["b"] },
                { required: ["a"] },
            ],
        });
        expect(output).toContain(
            lines(
                "export interface TopLevel {",
                "    a?: number;",
                "    b?: string;",
                "}",
            ),
        );
    });

    test("with a required property without values", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" } },
            additionalProperties: false,
            oneOf: [
                { properties: { a: { type: "integer" } }, required: ["a"] },
                { properties: { a: { type: "string" } }, required: ["a", "b"] },
            ],
        });
        expect(output).toContain(
            lines(
                "export interface TopLevel {",
                "    a:  string;",
                "    b?: string;",
                "}",
            ),
        );
    });

    // Every value of the last case is one of the first.
    test("of a oneOf with an impossible case", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { a: { type: "integer" }, b: { type: "string" } },
            additionalProperties: false,
            oneOf: [
                { required: ["a"] },
                { required: ["b"] },
                { required: ["a", "b"] },
            ],
        });
        expect(output).toContain(
            lines(
                "export interface TopLevel {",
                "    a?: number;",
                "    b?: string;",
                "}",
            ),
        );
    });

    test("of arrays whose items can't be told apart", async () => {
        const output = await renderSchema({
            type: "array",
            oneOf: [
                { items: { type: "integer" } },
                { items: { type: "number" } },
            ],
        });
        expect(output).toContain("export type TopLevel = number[];");
    });

    test("for targets without the support", async () => {
        const without = new TypeScriptWithoutUnions();
        expect(await renderSchema(discriminated, without)).toContain(
            lines(
                "export interface TopLevel {",
                "    a?:   number;",
                "    b?:   string;",
                "    kind: Kind;",
                "}",
            ),
        );
        expect(await renderSchema(oneOfTwo("oneOf"), without)).toContain(
            lines(
                "export interface TopLevel {",
                "    a?: number;",
                "    b?: string;",
                "}",
            ),
        );
        expect(await renderSchema(closedCases, without)).toContain(
            lines(
                "export interface TopLevel {",
                "    a?: number;",
                "    b?: string;",
                "}",
            ),
        );
        expect(await renderSchema(arrays, without)).toContain(
            "export type TopLevel = TopLevelElement[];",
        );
    });
});
