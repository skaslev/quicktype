// A Crystal union is an alias, but one that contains itself other than
// through a class would be a recursive alias: Crystal compiles it, but
// gives it no `new(pull)`, so nothing can read it from JSON ("undefined
// method 'new'"), and its nilable references don't compile once read.
// Such a union is a struct holding the value instead, as `JSON::Any` is.

import { describe, expect, test } from "vitest";

import {
    InputData,
    JSONSchemaInput,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";

async function renderSchema(schema: object): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({ inputData, lang: "crystal" });
    return result.lines.join("\n");
}

const lines = (...ls: string[]): string => ls.join("\n");

function struct(name: string, members: string[]): string {
    const type = members.join(" | ");
    return lines(
        `struct ${name}`,
        `  getter value : ${type}`,
        "",
        `  def initialize(@value : ${type})`,
        "  end",
        "",
        "  def self.new(pull : JSON::PullParser)",
        `    new(Union(${members.join(", ")}).new(pull))`,
        "  end",
        "",
        "  def to_json(json : JSON::Builder) : Nil",
        "    @value.to_json(json)",
        "  end",
        "end",
    );
}

describe("Crystal recursive unions", () => {
    test("a node that is an array of strings and nodes", async () => {
        const output = await renderSchema({
            $ref: "#/definitions/node",
            definitions: {
                node: {
                    type: "array",
                    items: {
                        oneOf: [
                            { type: "string" },
                            { $ref: "#/definitions/node" },
                        ],
                    },
                },
            },
        });
        expect(output).toContain("alias TopLevel = Array(TopLevelElement)\n");
        expect(output).toContain(
            struct("TopLevelElement", ["String", "Array(TopLevelElement)"]),
        );
        expect(output).not.toContain("alias TopLevelElement");
    });

    test("a top-level union that contains itself", async () => {
        const output = await renderSchema({
            oneOf: [
                { type: "string" },
                { type: "array", items: { $ref: "#" } },
            ],
        });
        expect(output).toContain(
            struct("TopLevel", ["String", "Array(TopLevel)"]),
        );
    });

    test("mutually recursive unions", async () => {
        const output = await renderSchema({
            $ref: "#/definitions/a",
            definitions: {
                a: {
                    oneOf: [
                        { type: "string" },
                        { type: "array", items: { $ref: "#/definitions/b" } },
                    ],
                },
                b: {
                    oneOf: [
                        { type: "integer" },
                        { type: "array", items: { $ref: "#/definitions/a" } },
                    ],
                },
            },
        });
        expect(output).toContain(struct("B", ["Int64", "Array(TopLevel)"]));
        expect(output).toContain(struct("TopLevel", ["String", "Array(B)"]));
    });

    test("a nullable union that contains itself through a map", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { kids: { $ref: "#/definitions/r" } },
            required: ["kids"],
            additionalProperties: false,
            definitions: {
                r: {
                    oneOf: [
                        { type: "string" },
                        { type: "null" },
                        { type: "array", items: { $ref: "#/definitions/r" } },
                        {
                            type: "object",
                            additionalProperties: { $ref: "#/definitions/r" },
                        },
                    ],
                },
            },
        });
        expect(output).toContain("  property kids : R?\n");
        expect(output).toContain(
            struct("R", ["String", "Array(R?)", "Hash(String, R?)"]),
        );
    });

    test("a union that contains itself through a class stays an alias", async () => {
        const output = await renderSchema({
            $ref: "#/definitions/tree",
            definitions: {
                tree: {
                    type: "object",
                    properties: {
                        children: {
                            type: "array",
                            items: {
                                oneOf: [
                                    { type: "string" },
                                    { $ref: "#/definitions/tree" },
                                ],
                            },
                        },
                    },
                    required: ["children"],
                    additionalProperties: false,
                },
            },
        });
        expect(output).toContain("alias Child = String | TopLevel\n");
        expect(output).not.toContain("struct");
    });
});
