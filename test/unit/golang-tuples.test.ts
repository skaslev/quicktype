// Go has no tuple types, so a tuple is a struct with a field per item,
// `ItemN`, pointers for the optional items and a slice `Rest` for the rest.
// Outside the just-types modes its MarshalJSON and UnmarshalJSON methods
// write and read a JSON array, and the unions that contain tuples try them
// on JSON arrays.

import {
    InputData,
    JSONSchemaInput,
    quicktype,
    quicktypeMultiFile,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

async function schemaInput(schema: object): Promise<InputData> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    return inputData;
}

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const result = await quicktype({
        inputData: await schemaInput(schema),
        lang: "go",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const justTypes = { "just-types-and-package": true, package: "replies" };

// ZRANGE WITHSCORES: `[member, score]` pairs.
const memberScores = {
    type: "array",
    items: {
        title: "MemberScore",
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: [{ type: "string" }, { type: "number" }],
    },
};

// CLUSTER SLOTS: `[start, end, master, ...replicas]`.
const slotRanges = {
    type: "array",
    items: {
        title: "SlotRange",
        type: "array",
        minItems: 3,
        maxItems: 4294967295,
        items: [
            { type: "integer" },
            { type: "integer" },
            { $ref: "#/$defs/node" },
        ],
        additionalItems: { $ref: "#/$defs/node" },
    },
    $defs: {
        node: {
            title: "SlotNode",
            type: "array",
            items: [{ type: ["string", "null"] }, { type: "integer" }],
        },
    },
};

// A string, then an optional flag and an optional nullable string, or a
// rest of integers after the flag.
const optionals = {
    type: "object",
    properties: {
        opt: {
            title: "Opt",
            type: "array",
            minItems: 1,
            items: [
                { type: "string" },
                { type: "boolean" },
                { type: ["string", "null"] },
            ],
        },
        optRest: {
            title: "Counts",
            type: "array",
            minItems: 1,
            items: [{ type: "string" }, { type: "boolean" }],
            additionalItems: { type: "integer" },
        },
    },
    required: ["opt", "optRest"],
    additionalProperties: false,
};

// ZRANK: null, a rank, or a rank and a score.
const rank = {
    oneOf: [
        { type: "null" },
        { type: "integer" },
        {
            title: "RankScore",
            type: "array",
            items: [{ type: "integer" }, { type: "number" }],
        },
    ],
};

// XPENDING: a summary tuple, or an array of entry tuples.
const pending = {
    oneOf: [
        {
            type: "array",
            items: {
                title: "PendingEntry",
                type: "array",
                items: [{ type: "string" }, { type: "integer" }],
            },
        },
        {
            title: "PendingSummary",
            type: "array",
            items: [
                { type: "integer" },
                { type: ["string", "null"] },
                { type: ["string", "null"] },
            ],
        },
    ],
};

// ROLE: one tuple per role.  Tuples of the same length would be merged.
const roles = {
    oneOf: [
        {
            title: "MasterRole",
            type: "array",
            items: [
                { const: "master" },
                { type: "integer" },
                { type: "array", items: { type: "string" } },
            ],
        },
        {
            title: "SentinelRole",
            type: "array",
            items: [
                { const: "sentinel" },
                { type: "array", items: { type: "string" } },
            ],
        },
    ],
};

describe("declarations", () => {
    test("a fixed-length tuple is a struct with a field per item", async () => {
        const output = await renderSchema(memberScores, justTypes);
        expect(output).toContain("type TopLevel []MemberScore");
        expect(output).toContain(
            "type MemberScore struct {\n\tItem0 string\n\tItem1 float64\n}",
        );
        // Not a union of the item types.
        expect(output).not.toContain("Double *float64");
    });

    test("optional items are pointers, the rest a slice", async () => {
        const output = await renderSchema(optionals, justTypes);
        // A present null is a nil *string, a missing item a nil **string.
        expect(output).toContain(
            "type Opt struct {\n\tItem0 string\n\tItem1 *bool\n\tItem2 **string\n}",
        );
        expect(output).toContain(
            "type Counts struct {\n\tItem0 string\n\tItem1 *bool\n\tRest  []int64\n}",
        );
    });

    test("a tuple that contains itself is a recursive struct", async () => {
        // Like COMMAND INFO: a command's last item is its subcommands.
        const output = await renderSchema(
            {
                type: "object",
                properties: { root: { $ref: "#/$defs/node" } },
                required: ["root"],
                additionalProperties: false,
                $defs: {
                    node: {
                        type: "array",
                        minItems: 1,
                        items: [
                            { type: "string" },
                            {
                                type: "array",
                                items: { $ref: "#/$defs/node" },
                            },
                        ],
                    },
                },
            },
            justTypes,
        );
        expect(output).toContain(
            "type Node struct {\n\tItem0 string\n\tItem1 *[]Node\n}",
        );
        // An optional item of the tuple itself is a pointer.
        const chain = await renderSchema(
            {
                $ref: "#/$defs/node",
                $defs: {
                    node: {
                        type: "array",
                        minItems: 1,
                        items: [{ type: "string" }, { $ref: "#/$defs/node" }],
                    },
                },
            },
            justTypes,
        );
        expect(chain).toContain(
            "type TopLevel struct {\n\tItem0 string\n\tItem1 *TopLevel\n}",
        );
    });

    test("tuples are values in maps, arrays, classes and tuples", async () => {
        const pair = {
            title: "Pair",
            type: "array",
            items: [{ type: "string" }, { type: "integer" }],
        };
        const output = await renderSchema(
            {
                type: "object",
                properties: {
                    byName: { type: "object", additionalProperties: pair },
                    list: { type: "array", items: pair },
                    one: pair,
                    maybe: pair,
                    outer: {
                        title: "Outer",
                        type: "array",
                        items: [pair, { type: "boolean" }],
                    },
                },
                required: ["byName", "list", "one", "outer"],
                additionalProperties: false,
            },
            justTypes,
        );
        expect(output).toMatch(/ByName\s+map\[string\]Pair\s/);
        expect(output).toMatch(/List\s+\[\]Pair\s/);
        expect(output).toMatch(/One\s+Pair\s/);
        expect(output).toMatch(/Maybe\s+\*Pair\s+`json:"maybe,omitempty"`/);
        expect(output).toContain(
            "type Outer struct {\n\tItem0 Pair\n\tItem1 bool\n}",
        );
    });

    test("just-types output has no methods and no helpers", async () => {
        for (const schema of [slotRanges, optionals, rank, pending]) {
            const output = await renderSchema(schema, justTypes);
            expect(output).not.toContain("func ");
            expect(output).not.toContain("import");
        }
    });
});

describe("methods", () => {
    test("UnmarshalJSON checks the length, then decodes each item", async () => {
        const output = await renderSchema(slotRanges);
        expect(output).toContain(
            [
                "func (x *SlotRange) UnmarshalJSON(data []byte) error {",
                "\titems, err := unmarshalTuple(data, 3, -1)",
                "\tif err != nil {",
                "\t\treturn err",
                "\t}",
                "\t*x = SlotRange{}",
                "\tif err = unmarshalTupleItem(items[0], &x.Item0, false); err != nil {",
                "\t\treturn err",
                "\t}",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "\tfor i := 3; i < len(items); i++ {",
                "\t\tvar v SlotNode",
                "\t\tif err = unmarshalTupleItem(items[i], &v, false); err != nil {",
                "\t\t\treturn err",
                "\t\t}",
                "\t\tx.Rest = append(x.Rest, v)",
                "\t}",
                "\treturn nil",
            ].join("\n"),
        );
        // Null is only taken for nullable items.
        expect(output).toContain(
            "if err = unmarshalTupleItem(items[0], &x.Item0, true); err != nil {",
        );
        expect(output).toContain("unmarshalTuple(data, 2, 2)");
        expect(output).toContain(
            "func unmarshalTuple(data []byte, minItems int, maxItems int) ([]json.RawMessage, error) {",
        );
        expect(output).toContain(
            "func unmarshalTupleItem(data json.RawMessage, v interface{}, nullable bool) error {",
        );
    });

    test("optional items are decoded if they are there", async () => {
        const output = await renderSchema(optionals);
        expect(output).toContain("unmarshalTuple(data, 1, 3)");
        expect(output).toContain(
            [
                "\tif len(items) > 2 {",
                "\t\tx.Item2 = new(*string)",
                "\t\tif err = unmarshalTupleItem(items[2], x.Item2, true); err != nil {",
            ].join("\n"),
        );
    });

    test("MarshalJSON writes the items that are there, without gaps", async () => {
        const output = await renderSchema(optionals);
        expect(output).toContain(
            [
                "func (x Opt) MarshalJSON() ([]byte, error) {",
                "\tif x.Item1 == nil && x.Item2 != nil {",
                '\t\treturn nil, errors.New("Opt: an item follows a missing optional item")',
                "\t}",
                "\titems := []interface{}{&x.Item0}",
                "\tif x.Item1 != nil {",
                "\t\titems = append(items, x.Item1)",
                "\t}",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "func (x Counts) MarshalJSON() ([]byte, error) {",
                "\tif x.Item1 == nil && len(x.Rest) > 0 {",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "\tfor i := range x.Rest {",
                "\t\titems = append(items, &x.Rest[i])",
                "\t}",
                "\treturn json.Marshal(items)",
            ].join("\n"),
        );
        // Without unions, the helpers need errors and fmt.
        expect(output).toContain('import "errors"\nimport "fmt"');
        expect(output).not.toContain("unmarshalUnion");
    });
});

describe("unions", () => {
    test("a union decodes an array as its tuple before its array", async () => {
        const output = await renderSchema(pending);
        expect(output).toContain(
            [
                "type TopLevel struct {",
                "\tPendingEntryArray []PendingEntry",
                "\tPendingSummary    *PendingSummary",
                "}",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "\tx.PendingEntryArray = nil",
                "\tx.PendingSummary = nil",
                "\tvar array json.RawMessage",
                "\tobject, err := unmarshalUnion(data, nil, nil, nil, nil, true, &array, false, nil, false, nil, false, nil, false)",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "\tif array != nil {",
                "\t\tif t := new(PendingSummary); json.Unmarshal(array, t) == nil {",
                "\t\t\tx.PendingSummary = t",
                "\t\t\treturn nil",
                "\t\t}",
                "\t\treturn json.Unmarshal(array, &x.PendingEntryArray)",
                "\t}",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "func (x TopLevel) MarshalJSON() ([]byte, error) {",
                "\tif x.PendingSummary != nil {",
                "\t\treturn json.Marshal(x.PendingSummary)",
                "\t}",
                "\treturn marshalUnion(nil, nil, nil, nil, x.PendingEntryArray != nil, x.PendingEntryArray, false, nil, false, nil, false, nil, false)",
            ].join("\n"),
        );
    });

    test("a union with a tuple, an integer and null", async () => {
        const output = await renderSchema(rank);
        expect(output).toContain(
            "object, err := unmarshalUnion(data, &x.Integer, nil, nil, nil, true, &array, false, nil, false, nil, false, nil, true)",
        );
        // The only candidate reports its own error.
        expect(output).toContain(
            [
                "\tif array != nil {",
                "\t\tx.RankScore = new(RankScore)",
                "\t\treturn json.Unmarshal(array, x.RankScore)",
                "\t}",
            ].join("\n"),
        );
    });

    test("a union with several tuples tries each", async () => {
        const output = await renderSchema(roles);
        expect(output).toContain(
            [
                "\tif array != nil {",
                "\t\tif t := new(MasterRole); json.Unmarshal(array, t) == nil {",
                "\t\t\tx.MasterRole = t",
                "\t\t\treturn nil",
                "\t\t}",
                "\t\tif t := new(SentinelRole); json.Unmarshal(array, t) == nil {",
                "\t\t\tx.SentinelRole = t",
                "\t\t\treturn nil",
                "\t\t}",
                '\t\treturn errors.New("Array does not match any tuple of the union")',
                "\t}",
            ].join("\n"),
        );
    });

    test("unions without tuples are unchanged", async () => {
        const output = await renderSchema({
            oneOf: [
                { type: "integer" },
                { type: "string" },
                { type: "array", items: { type: "string" } },
            ],
        });
        expect(output).toContain(
            [
                "func (x *TopLevel) UnmarshalJSON(data []byte) error {",
                "\tx.StringArray = nil",
                "\tobject, err := unmarshalUnion(data, &x.Integer, nil, nil, &x.String, true, &x.StringArray, false, nil, false, nil, false, nil, false)",
                "\tif err != nil {",
                "\t\treturn err",
                "\t}",
                "\tif object {",
                "\t}",
                "\treturn nil",
                "}",
            ].join("\n"),
        );
        expect(output).not.toContain("unmarshalTuple");
        expect(output).not.toContain('import "fmt"');
    });
});

test("multi-file output has the tuple helpers in a file of their own", async () => {
    const files = await quicktypeMultiFile({
        inputData: await schemaInput(optionals),
        lang: "go",
        rendererOptions: { "multi-file-output": true },
    });
    const file = (name: string): string =>
        files.get(name)?.lines.join("\n") ?? "";
    expect(file("JSONSchemaTupleSupport.go")).toContain(
        'import "encoding/json"\nimport "errors"\nimport "fmt"',
    );
    expect(file("JSONSchemaTupleSupport.go")).toContain("func unmarshalTuple(");
    expect(file("Opt.go")).toContain('import "encoding/json"\nimport "errors"');
    expect(file("Opt.go")).toContain("type Opt struct {");
});
