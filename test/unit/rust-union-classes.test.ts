// Rust keeps the classes of JSON Schema object schemas that forbid
// additional properties apart in unions, as the variants of an untagged
// enum.  serde tries those in turn, so their structs reject unknown fields:
// otherwise a struct would take the values of a struct with more fields.

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
        lang: "rust",
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
    Short: closedObject({ a: { type: "integer" }, c: { type: "string" } }, [
        "a",
    ]),
    Long: closedObject({ a: { type: "integer" }, b: { type: "string" } }, [
        "a",
        "b",
    ]),
};

const derive = "#[derive(Debug, Clone, Serialize, Deserialize)]";

describe("a union of classes", () => {
    test("is an untagged enum of structs that reject unknown fields", async () => {
        const output = await renderSchema({
            oneOf: [{ $ref: "#/$defs/Short" }, { $ref: "#/$defs/Long" }],
            $defs: defs,
        });
        expect(output).toContain(
            [
                derive,
                "#[serde(untagged)]",
                "pub enum TopLevel {",
                "    Long(Long),",
                "",
                "    Short(Short),",
                "}",
            ].join("\n"),
        );
        for (const name of ["Short", "Long"]) {
            expect(output).toContain(
                [
                    derive,
                    "#[serde(deny_unknown_fields)]",
                    `pub struct ${name} {`,
                ].join("\n"),
            );
        }
    });

    test("with other types", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                reply: {
                    anyOf: [
                        { $ref: "#/$defs/Short" },
                        { $ref: "#/$defs/Long" },
                        { type: "string" },
                        { type: "null" },
                    ],
                },
            },
            required: ["reply"],
            additionalProperties: false,
            $defs: defs,
        });
        expect(output).toContain("    pub reply: Option<Reply>,");
        const reply = output.slice(output.indexOf("pub enum Reply {"));
        const variants = reply
            .slice(0, reply.indexOf("}"))
            .match(/^ {4}\w+\(\w+\),$/gm);
        expect(variants).toHaveLength(3);
        expect(variants).toContain("    Long(Long),");
        expect(variants).toContain("    Short(Short),");
        // Only the classes of the union reject unknown fields.
        expect(output).toContain([derive, "pub struct TopLevel {"].join("\n"));
        expect(output.match(/deny_unknown_fields/g)).toHaveLength(2);
    });
});

test("a union with a single class takes unknown fields", async () => {
    const output = await renderSchema({
        type: "object",
        properties: {
            reply: { oneOf: [{ $ref: "#/$defs/Short" }, { type: "null" }] },
        },
        required: ["reply"],
        additionalProperties: false,
        $defs: defs,
    });
    expect(output).toContain("    pub reply: Option<Short>,");
    expect(output).not.toContain("deny_unknown_fields");
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
            derive,
            "pub struct TopLevel {",
            "    pub a: Option<i64>,",
            "",
            "    pub b: Option<String>,",
            "}",
        ].join("\n"),
    );
    expect(output).not.toContain("deny_unknown_fields");
});

describe("the classes that the classes of a union contain", () => {
    // Whether the struct `name` in `output` rejects unknown fields.
    function rejectsUnknownFields(output: string, name: string): boolean {
        const declaration = output.slice(
            0,
            output.indexOf(`pub struct ${name} {`),
        );
        return declaration
            .slice(declaration.lastIndexOf(derive))
            .includes("#[serde(deny_unknown_fields)]");
    }

    function titled(title: string, schema: object): object {
        return { title, ...schema };
    }

    test("reject unknown fields if their schemas don't allow them", async () => {
        // `{"x": {"a": 1}}` is a `P`, but `F` would take it if `B` took
        // unknown fields.
        const output = await renderSchema({
            oneOf: [
                titled("P", closedObject({ x: { $ref: "#/$defs/A" } }, ["x"])),
                titled("F", closedObject({ x: { $ref: "#/$defs/B" } }, ["x"])),
            ],
            $defs: {
                A: closedObject({ a: { type: "integer" } }, ["a"]),
                B: closedObject({ b: { type: "string" } }, []),
            },
        });
        for (const name of ["P", "F", "A", "B"]) {
            expect(rejectsUnknownFields(output, name)).toBe(true);
        }
    });

    test("reject unknown fields at any depth, through other types", async () => {
        const output = await renderSchema({
            oneOf: [
                titled(
                    "P",
                    closedObject(
                        {
                            items: {
                                type: "array",
                                items: { $ref: "#/$defs/A" },
                            },
                            values: {
                                type: "object",
                                additionalProperties: { $ref: "#/$defs/B" },
                            },
                            maybe: {
                                oneOf: [
                                    { $ref: "#/$defs/C" },
                                    { type: "null" },
                                ],
                            },
                        },
                        [],
                    ),
                ),
                titled("F", closedObject({ f: { type: "string" } }, ["f"])),
            ],
            $defs: {
                A: closedObject({ a: { type: "integer" } }, ["a"]),
                B: closedObject({ b: { type: "string" } }, []),
                C: closedObject({ d: { $ref: "#/$defs/D" } }, ["d"]),
                D: closedObject({ e: { type: "boolean" } }, []),
            },
        });
        for (const name of ["P", "F", "A", "B", "C", "D"]) {
            expect(rejectsUnknownFields(output, name)).toBe(true);
        }
    });

    test("take unknown fields if their schemas allow them", async () => {
        const output = await renderSchema({
            oneOf: [
                titled(
                    "P",
                    closedObject({ x: { $ref: "#/$defs/Open" } }, ["x"]),
                ),
                titled("F", closedObject({ f: { type: "string" } }, ["f"])),
            ],
            $defs: {
                Open: {
                    type: "object",
                    properties: { a: { type: "integer" } },
                },
            },
        });
        expect(rejectsUnknownFields(output, "P")).toBe(true);
        expect(rejectsUnknownFields(output, "Open")).toBe(false);
    });

    test("other classes take unknown fields", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                reply: {
                    oneOf: [
                        { $ref: "#/$defs/Short" },
                        { $ref: "#/$defs/Long" },
                    ],
                },
                other: { $ref: "#/$defs/Other" },
            },
            required: ["reply", "other"],
            additionalProperties: false,
            $defs: {
                ...defs,
                Other: closedObject({ o: { type: "string" } }, ["o"]),
            },
        });
        expect(rejectsUnknownFields(output, "Short")).toBe(true);
        expect(rejectsUnknownFields(output, "Long")).toBe(true);
        expect(rejectsUnknownFields(output, "TopLevel")).toBe(false);
        expect(rejectsUnknownFields(output, "Other")).toBe(false);
    });
});
