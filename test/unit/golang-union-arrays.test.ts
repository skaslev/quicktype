// Go keeps the arrays of JSON Schema array schemas apart in unions, if their
// item types can be told apart, as a field for each.  `UnmarshalJSON` tries
// them in turn on an array, and an array only takes a JSON array whose
// elements are all of its items, in the ways encoding/json doesn't check:
// no null for items that aren't nullable, and the exact keys for classes
// that need to be told apart.

import {
    InputData,
    JSONSchemaInput,
    quicktype,
    quicktypeMultiFile,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

async function inputDataFor(schema: object): Promise<InputData> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);
    return inputData;
}

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const result = await quicktype({
        inputData: await inputDataFor(schema),
        lang: "go",
        rendererOptions,
    });
    return result.lines.join("\n");
}

function arrayOf(items: object): object {
    return { type: "array", items };
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

const memberScore = {
    title: "MemberScore",
    ...closedObject({ member: { type: "string" }, score: { type: "number" } }, [
        "member",
        "score",
    ]),
};

const memberScoreTuple = {
    title: "MemberScore",
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
};

// Like Redis' ZRANGE reply.
const membersOrScores = {
    anyOf: [arrayOf({ type: "string" }), arrayOf(memberScore)],
};

describe("types", () => {
    test("a union has a field for each array", async () => {
        for (const option of ["just-types", "just-types-and-package"]) {
            const output = await renderSchema(membersOrScores, {
                [option]: true,
            });
            expect(output).toContain(
                [
                    "type TopLevel struct {",
                    "\tMemberScoreArray []MemberScore",
                    "\tStringArray      []string",
                    "}",
                ].join("\n"),
            );
            expect(output).not.toContain("UnmarshalJSON");
        }
    });

    test("arrays of unions are named after them", async () => {
        const output = await renderSchema(
            {
                anyOf: [
                    arrayOf({
                        title: "UnsignedInteger",
                        oneOf: [
                            { type: "integer" },
                            { type: "string", pattern: "^[0-9]+$" },
                        ],
                    }),
                    arrayOf(arrayOf({ type: "boolean" })),
                ],
            },
            { "just-types": true },
        );
        expect(output).toContain(
            [
                "type TopLevel struct {",
                "\tBoolArrayArray       [][]bool",
                "\tUnsignedIntegerArray []UnsignedInteger",
                "}",
            ].join("\n"),
        );
    });
});

describe("full mode", () => {
    test("tries the arrays in the order of the union", async () => {
        const output = await renderSchema(membersOrScores);
        expect(output).toContain(
            [
                "func (x *TopLevel) UnmarshalJSON(data []byte) error {",
                "\tx.StringArray = nil",
                "\tx.MemberScoreArray = nil",
                "\tvar array json.RawMessage",
                "\tobject, err := unmarshalUnion(data, nil, nil, nil, nil, true, &array, false, nil, false, nil, false, nil, false)",
                "\tif err != nil {",
                "\t\treturn err",
                "\t}",
                "\tif object {",
                "\t}",
                "\tif array != nil {",
                "\t\tif a := new([]string); unmarshalArray(array, a, notNull) {",
                "\t\t\tx.StringArray = *a",
                "\t\t\treturn nil",
                "\t\t}",
                "\t\tif a := new([]MemberScore); unmarshalArray(array, a, notNull) {",
                "\t\t\tx.MemberScoreArray = *a",
                "\t\t\treturn nil",
                "\t\t}",
                '\t\treturn errors.New("Array does not match any array of the union")',
                "\t}",
                "\treturn nil",
                "}",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "func (x TopLevel) MarshalJSON() ([]byte, error) {",
                "\tif x.StringArray != nil {",
                "\t\treturn json.Marshal(x.StringArray)",
                "\t}",
                "\tif x.MemberScoreArray != nil {",
                "\t\treturn json.Marshal(x.MemberScoreArray)",
                "\t}",
                "\treturn marshalUnion(nil, nil, nil, nil, false, nil, false, nil, false, nil, false, nil, false)",
                "}",
            ].join("\n"),
        );
        for (const helper of ["unmarshalArray", "isArray", "notNull"]) {
            expect(
                output.match(new RegExp(`^func ${helper}\\(`, "gm")),
            ).toHaveLength(1);
        }

        // MemberScore needn't be told apart from another class.
        expect(output).not.toContain("unmarshalClass");
    });

    test("checks nulls in elements, also in nested arrays", async () => {
        const output = await renderSchema({
            anyOf: [
                arrayOf(arrayOf({ type: "integer" })),
                arrayOf(arrayOf({ type: ["boolean", "null"] })),
                arrayOf({ type: ["string", "null"] }),
            ],
        });
        expect(output).toContain(
            "if a := new([][]int64); unmarshalArray(array, a, func(e []byte) bool { return isArray(e, notNull) }) {",
        );
        expect(output).toContain(
            "if a := new([][]*bool); unmarshalArray(array, a, func(e []byte) bool { return isArray(e, nil) }) {",
        );
        expect(output).toContain(
            "if a := new([]*string); unmarshalArray(array, a, nil) {",
        );

        // An array of nulls only takes nulls.
        const nulls = await renderSchema({
            anyOf: [arrayOf({ type: "null" }), arrayOf({ type: "string" })],
        });
        expect(nulls).toContain(
            'if a := new([]interface{}); unmarshalArray(array, a, func(e []byte) bool { return string(e) == "null" }) {',
        );
    });

    test("checks the elements of the one array of a union", async () => {
        const output = await renderSchema({
            anyOf: [
                arrayOf({
                    title: "Item",
                    oneOf: [{ type: "string" }, arrayOf({ type: "integer" })],
                }),
                arrayOf(arrayOf({ type: "boolean" })),
            ],
        });
        expect(output).toContain(
            "if a := new([]Item); unmarshalArray(array, a, func(e []byte) bool { return !isArray(e, nil) || isArray(e, notNull) }) {",
        );
    });

    test("checks the classes of several arrays of classes", async () => {
        const output = await renderSchema({
            oneOf: [
                arrayOf({
                    title: "Short",
                    ...closedObject({ a: { type: "integer" } }, ["a"]),
                }),
                arrayOf({
                    type: ["null", "object"],
                    title: "Long",
                    properties: {
                        a: { type: "integer" },
                        b: { type: ["string", "null"] },
                    },
                    required: ["a", "b"],
                    additionalProperties: false,
                }),
            ],
        });
        expect(output).toContain(
            [
                "\tif array != nil {",
                '\t\tif a := new([]Short); unmarshalArray(array, a, func(e []byte) bool { return unmarshalClass(e, new(Short), []string{"a"}, nil, nil) }) {',
                "\t\t\tx.ShortArray = *a",
                "\t\t\treturn nil",
                "\t\t}",
                '\t\tif a := new([]*Long); unmarshalArray(array, a, func(e []byte) bool { return string(e) == "null" || unmarshalClass(e, new(Long), []string{"a", "b"}, nil, []string{"b"}) }) {',
            ].join("\n"),
        );
        expect(output.match(/^func unmarshalClass\(/gm)).toHaveLength(1);
    });

    test("unions decode the classes of several arrays of classes like them", async () => {
        const output = await renderSchema({
            oneOf: [
                arrayOf({
                    title: "AOrString",
                    oneOf: [
                        {
                            title: "A",
                            ...closedObject({ a: { type: "string" } }, ["a"]),
                        },
                        { type: "string" },
                    ],
                }),
                arrayOf({
                    title: "B",
                    ...closedObject({ b: { type: "string" } }, ["b"]),
                }),
            ],
        });
        expect(output).toContain(
            [
                "func (x *AOrString) UnmarshalJSON(data []byte) error {",
                "\tx.A = nil",
                "\tobject, err := unmarshalUnion(data, nil, nil, nil, &x.String, false, nil, true, new(json.RawMessage), false, nil, false, nil, false)",
                "\tif err != nil {",
                "\t\treturn err",
                "\t}",
                "\tif object {",
                '\t\tif c := new(A); unmarshalClass(data, c, []string{"a"}, nil, nil) {',
            ].join("\n"),
        );
        expect(output).toContain(
            "if a := new([]AOrString); unmarshalArray(array, a, nil) {",
        );
        expect(output).toContain(
            'if a := new([]B); unmarshalArray(array, a, func(e []byte) bool { return unmarshalClass(e, new(B), []string{"b"}, nil, nil) }) {',
        );
    });

    test("with several classes, too", async () => {
        const output = await renderSchema({
            oneOf: [
                {
                    title: "P",
                    ...closedObject({ p: { type: "string" } }, ["p"]),
                },
                {
                    title: "Q",
                    ...closedObject({ q: { type: "string" } }, ["q"]),
                },
                arrayOf({ type: "boolean" }),
                arrayOf({ type: "string" }),
                { type: "null" },
            ],
        });
        expect(output).toContain(
            [
                "\tx.BoolArray = nil",
                "\tx.StringArray = nil",
                "\tx.P = nil",
                "\tx.Q = nil",
                "\tvar array json.RawMessage",
                "\tobject, err := unmarshalUnion(data, nil, nil, nil, nil, true, &array, true, new(json.RawMessage), false, nil, false, nil, true)",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                '\t\treturn errors.New("Object does not match any class of the union")',
                "\t}",
                "\tif array != nil {",
                "\t\tif a := new([]bool); unmarshalArray(array, a, notNull) {",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "\tif x.BoolArray != nil {",
                "\t\treturn json.Marshal(x.BoolArray)",
                "\t}",
                "\tif x.StringArray != nil {",
                "\t\treturn json.Marshal(x.StringArray)",
                "\t}",
                "\tif x.P != nil {",
            ].join("\n"),
        );
    });

    test("tries tuples first, then the arrays", async () => {
        const output = await renderSchema({
            oneOf: [
                {
                    title: "P",
                    ...closedObject({ p: { type: "string" } }, ["p"]),
                },
                {
                    title: "Q",
                    ...closedObject({ q: { type: "string" } }, ["q"]),
                },
                {
                    title: "Pair",
                    type: "array",
                    items: [{ type: "string" }, { type: "integer" }],
                    minItems: 2,
                    maxItems: 2,
                },
                arrayOf({ type: "number" }),
                arrayOf(memberScoreTuple),
            ],
        });
        expect(output).toContain(
            [
                "\tif array != nil {",
                "\t\tif t := new(Pair); json.Unmarshal(array, t) == nil {",
                "\t\t\tx.Pair = t",
                "\t\t\treturn nil",
                "\t\t}",
                "\t\tif a := new([]float64); unmarshalArray(array, a, notNull) {",
                "\t\t\tx.DoubleArray = *a",
                "\t\t\treturn nil",
                "\t\t}",
                "\t\tif a := new([]MemberScore); unmarshalArray(array, a, nil) {",
                "\t\t\tx.MemberScoreArray = *a",
                "\t\t\treturn nil",
                "\t\t}",
                '\t\treturn errors.New("Array does not match any tuple or array of the union")',
                "\t}",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "\tif x.Pair != nil {",
                "\t\treturn json.Marshal(x.Pair)",
                "\t}",
                "\tif x.DoubleArray != nil {",
                "\t\treturn json.Marshal(x.DoubleArray)",
                "\t}",
                "\tif x.MemberScoreArray != nil {",
                "\t\treturn json.Marshal(x.MemberScoreArray)",
                "\t}",
                "\tif x.P != nil {",
            ].join("\n"),
        );
    });

    test("unions with a single array are as before", async () => {
        const output = await renderSchema({
            oneOf: [arrayOf({ type: "string" }), { type: "integer" }],
        });
        expect(output).toContain(
            "object, err := unmarshalUnion(data, &x.Integer, nil, nil, nil, true, &x.StringArray, false, nil, false, nil, false, nil, false)",
        );
        expect(output).not.toContain("unmarshalArray");
    });

    test("multi-file output imports what the union needs", async () => {
        const result = await quicktypeMultiFile({
            inputData: await inputDataFor(
                closedObject({ reply: membersOrScores }, ["reply"]),
            ),
            lang: "go",
            rendererOptions: { "multi-file-output": true },
        });
        const reply = result.get("Reply.go")?.lines.join("\n");
        expect(reply).toContain('import "encoding/json"\nimport "errors"');
        expect(reply).toContain("unmarshalArray(array, a, notNull)");
        const support = result.get("JSONSchemaSupport.go")?.lines.join("\n");
        expect(support).toContain("func unmarshalArray(");
        expect(support).toContain("func isArray(");
    });
});

test("arrays of the same items are unified", async () => {
    const output = await renderSchema(
        { anyOf: [arrayOf({ type: "string" }), arrayOf({ enum: ["a", "b"] })] },
        { "just-types": true },
    );
    expect(output).toContain("type TopLevel []string");
});
