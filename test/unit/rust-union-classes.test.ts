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
