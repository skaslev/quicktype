// Go keeps the classes of JSON Schema object schemas that forbid additional
// properties apart in unions, as a field for each.  `UnmarshalJSON` tries
// them in turn on an object, and a class only takes an object with exactly
// its properties: all its required ones and no unknown ones.

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

// Short's required properties are a subset of Long's.
const defs = {
    Short: closedObject(
        { a: { type: "integer" }, c: { type: ["string", "null"] } },
        ["a"],
    ),
    Long: closedObject(
        {
            a: { type: "integer" },
            b: { type: "string" },
            c: { type: "string" },
        },
        ["a", "b"],
    ),
};

const withString = {
    oneOf: [
        { $ref: "#/$defs/Short" },
        { $ref: "#/$defs/Long" },
        { type: "string" },
    ],
    $defs: defs,
};

const unionStruct = [
    "type TopLevel struct {",
    "\tLong   *Long",
    "\tShort  *Short",
    "\tString *string",
    "}",
].join("\n");

describe("types", () => {
    test("a union has a field for each class", async () => {
        for (const option of ["just-types", "just-types-and-package"]) {
            const output = await renderSchema(withString, { [option]: true });
            expect(output).toContain(unionStruct);
            expect(output).toContain("type Short struct {");
            expect(output).toContain("type Long struct {");
            expect(output).not.toContain("UnmarshalJSON");
        }
    });
});

describe("full mode", () => {
    test("tries the classes, those with more required properties first", async () => {
        const output = await renderSchema(withString);
        expect(output).toContain(unionStruct);
        expect(output).toContain(
            [
                "func (x *TopLevel) UnmarshalJSON(data []byte) error {",
                "\tx.Short = nil",
                "\tx.Long = nil",
                "\tobject, err := unmarshalUnion(data, nil, nil, nil, &x.String, false, nil, true, new(json.RawMessage), false, nil, false, nil, false)",
                "\tif err != nil {",
                "\t\treturn err",
                "\t}",
                "\tif object {",
                '\t\tif c := new(Long); unmarshalClass(data, c, []string{"a", "b"}, []string{"c"}, nil) {',
                "\t\t\tx.Long = c",
                "\t\t\treturn nil",
                "\t\t}",
                '\t\tif c := new(Short); unmarshalClass(data, c, []string{"a"}, []string{"c"}, []string{"c"}) {',
                "\t\t\tx.Short = c",
                "\t\t\treturn nil",
                "\t\t}",
                '\t\treturn errors.New("Object does not match any class of the union")',
                "\t}",
                "\treturn nil",
                "}",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "func (x TopLevel) MarshalJSON() ([]byte, error) {",
                "\tif x.Long != nil {",
                "\t\treturn json.Marshal(x.Long)",
                "\t}",
                "\tif x.Short != nil {",
                "\t\treturn json.Marshal(x.Short)",
                "\t}",
                "\treturn marshalUnion(nil, nil, nil, x.String, false, nil, false, nil, false, nil, false, nil, false)",
                "}",
            ].join("\n"),
        );
        expect(output.match(/^func unmarshalClass\(/gm)).toHaveLength(1);
        expect(output.match(/^func containsName\(/gm)).toHaveLength(1);
    });

    test("an empty class only takes empty objects", async () => {
        const output = await renderSchema({
            anyOf: [
                { title: "Empty", type: "object", additionalProperties: false },
                { $ref: "#/$defs/Short" },
                { type: "null" },
            ],
            $defs: defs,
        });
        expect(output).toContain(
            "if c := new(Empty); unmarshalClass(data, c, nil, nil, nil) {",
        );
        expect(output).toContain(
            "object, err := unmarshalUnion(data, nil, nil, nil, nil, false, nil, true, new(json.RawMessage), false, nil, false, nil, true)",
        );
    });

    test("unions with a single class are as before", async () => {
        const output = await renderSchema({
            ...closedObject(
                {
                    reply: {
                        oneOf: [{ $ref: "#/$defs/Short" }, { type: "string" }],
                    },
                },
                ["reply"],
            ),
            $defs: defs,
        });
        expect(output).toContain(
            [
                "\tx.Short = nil",
                "\tvar c Short",
                "\tobject, err := unmarshalUnion(data, nil, nil, nil, &x.String, false, nil, true, &c, false, nil, false, nil, false)",
            ].join("\n"),
        );
        expect(output).not.toContain("unmarshalClass");
    });

    test("multi-file output imports what the union needs", async () => {
        const result = await quicktypeMultiFile({
            inputData: await inputDataFor({
                ...closedObject({ reply: { oneOf: withString.oneOf } }, [
                    "reply",
                ]),
                $defs: defs,
            }),
            lang: "go",
            rendererOptions: { "multi-file-output": true },
        });
        const reply = result.get("Reply.go")?.lines.join("\n");
        expect(reply).toContain('import "encoding/json"\nimport "errors"');
        expect(reply).toContain("unmarshalClass(data, c, ");
        const support = result.get("JSONSchemaSupport.go")?.lines.join("\n");
        expect(support).toContain("func unmarshalClass(");
    });
});

test("classes that allow additional properties are unified", async () => {
    const output = await renderSchema({
        oneOf: [
            { type: "object", properties: { a: { type: "integer" } } },
            { type: "object", properties: { b: { type: "string" } } },
        ],
    });
    expect(output).toContain(
        [
            "type TopLevel struct {",
            '\tA *int64  `json:"a,omitempty"`',
            '\tB *string `json:"b,omitempty"`',
            "}",
        ].join("\n"),
    );
    expect(output).not.toContain("unmarshalClass");
});
