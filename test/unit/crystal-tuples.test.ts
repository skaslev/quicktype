// A fixed-length JSON Schema tuple is a Crystal `Tuple`, which reads and
// writes JSON arrays of exactly its length.  Other tuples, and tuples that
// contain themselves (a recursive alias can't be parsed), are classes with
// a property per item, `itemN`, and an array `rest` for the rest, which
// read and write JSON arrays themselves.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

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

function inObject(properties: Record<string, object>, defs = {}): object {
    return {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
        $defs: defs,
    };
}

describe("fixed-length tuples", () => {
    test("are Tuples", async () => {
        const output = await renderSchema(
            inObject({
                pair: {
                    type: "array",
                    items: [{ type: "integer" }, { type: ["string", "null"] }],
                },
            }),
        );
        expect(output).toContain("property pair : Tuple(Int64, String?)");
    });

    test("that the schema names are aliases", async () => {
        const output = await renderSchema({
            type: "array",
            items: {
                title: "MemberScore",
                type: "array",
                items: [{ type: "string" }, { type: "number" }],
            },
        });
        expect(output).toContain("alias TopLevel = Array(MemberScore)");
        expect(output).toContain("alias MemberScore = Tuple(String, Float64)");
    });

    test("are members of unions", async () => {
        const output = await renderSchema({
            oneOf: [
                { type: "integer" },
                {
                    type: "array",
                    items: [{ type: "integer" }, { type: "number" }],
                },
            ],
        });
        expect(output).toContain(
            "alias TopLevel = Int64 | Tuple(Int64, Float64)",
        );
    });

    // A recursive alias compiles, but has no `new(pull)`.
    test("that contain themselves are classes", async () => {
        const output = await renderSchema(
            inObject(
                { commands: { type: "array", items: { $ref: "#/$defs/c" } } },
                {
                    c: {
                        title: "Command",
                        type: "array",
                        items: [
                            { type: "string" },
                            { type: "array", items: { $ref: "#/$defs/c" } },
                        ],
                    },
                },
            ),
        );
        expect(output).toContain(
            lines(
                "class Command",
                "  property item0 : String",
                "  property item1 : Array(Command)",
                "",
                "  def initialize(@item0 : String, @item1 : Array(Command))",
                "  end",
                "",
                "  def self.new(pull : JSON::PullParser)",
                "    pull.read_begin_array",
                "    item0 = String.new(pull)",
                "    item1 = Array(Command).new(pull)",
                "    pull.read_end_array",
                "    new(item0, item1)",
                "  end",
                "",
                "  def to_json(json : JSON::Builder) : Nil",
                "    json.array do",
                "      @item0.to_json(json)",
                "      @item1.to_json(json)",
                "    end",
                "  end",
                "end",
            ),
        );
        expect(output).not.toContain("alias Command");
    });

    test("that contain themselves through a union are classes", async () => {
        const output = await renderSchema({
            $ref: "#/$defs/node",
            $defs: {
                node: {
                    oneOf: [
                        { type: "integer" },
                        {
                            title: "Pair",
                            type: "array",
                            items: [
                                { type: "string" },
                                { $ref: "#/$defs/node" },
                            ],
                        },
                    ],
                },
            },
        });
        expect(output).toContain("class Pair");
        expect(output).toContain("    item1 = TopLevel.new(pull)");
        expect(output).toContain("alias TopLevel = Int64 | Pair");
    });

    test("that contain themselves through a class are Tuples", async () => {
        const output = await renderSchema({
            $ref: "#/$defs/node",
            $defs: {
                node: {
                    title: "Node",
                    type: "array",
                    items: [
                        { type: "string" },
                        {
                            title: "Children",
                            type: "object",
                            properties: {
                                nodes: {
                                    type: "array",
                                    items: { $ref: "#/$defs/node" },
                                },
                            },
                            required: ["nodes"],
                        },
                    ],
                },
            },
        });
        expect(output).toContain("alias TopLevel = Tuple(String, Children)");
        expect(output).toContain("property nodes : Array(TopLevel)");
    });
});

describe("other tuples", () => {
    test("with a rest are classes", async () => {
        const output = await renderSchema({
            type: "array",
            items: {
                title: "SlotRange",
                type: "array",
                minItems: 3,
                maxItems: 100,
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
        });
        expect(output).toContain("alias TopLevel = Array(SlotRange)");
        expect(output).toContain("alias SlotNode = Tuple(String?, Int64)");
        expect(output).toContain(
            lines(
                "class SlotRange",
                "  property item0 : Int64",
                "  property item1 : Int64",
                "  property item2 : SlotNode",
                "  property rest : Array(SlotNode)",
            ),
        );
        expect(output).toContain(
            lines(
                "    item2 = SlotNode.new(pull)",
                "    rest = [] of SlotNode",
                "    until pull.kind.end_array?",
                "      rest << SlotNode.new(pull)",
                "    end",
                '    pull.raise "Expected 3 to 100 elements for SlotRange" if 3 + rest.size > 100',
                "    pull.read_end_array",
                "    new(item0, item1, item2, rest)",
            ),
        );
        expect(output).toContain("      @rest.each &.to_json(json)");
    });

    test("with optional items are classes", async () => {
        const output = await renderSchema(
            inObject({
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
            }),
        );
        expect(output).toContain(
            lines(
                "class Opt",
                "  property item0 : String",
                "  property item1 : Bool?",
                "  property item2 : Present(String?)?",
            ),
        );
        // A null element of an item that can't be null doesn't parse.
        expect(output).toContain(
            "    item1 = pull.kind.end_array? ? nil : Bool.new(pull)",
        );
        expect(output).toContain(
            "    item2 = pull.kind.end_array? ? nil : Present.new(Union(String, Nil).new(pull))",
        );
        // A JSON array can't leave a gap.
        expect(output).toContain(
            '    raise ArgumentError.new("An item of Opt follows a missing optional item") if @item1.nil? && !@item2.nil?',
        );
        // `try` skips nil, not false.
        expect(output).toContain(
            lines(
                "      @item1.try &.to_json(json)",
                "      @item2.try &.value.to_json(json)",
            ),
        );
        expect(output).toContain("struct Present(T)");
    });

    test("declare Present only if they need it", async () => {
        const output = await renderSchema(
            inObject({
                opt: {
                    type: "array",
                    minItems: 1,
                    items: [{ type: "string" }, { type: "boolean" }],
                },
            }),
        );
        expect(output).toContain("property item1 : Bool?");
        expect(output).not.toContain("Present");
    });

    test("keep Present's name for it", async () => {
        const output = await renderSchema(
            inObject({
                opt: {
                    type: "array",
                    minItems: 1,
                    items: [{ type: "string" }, { type: ["string", "null"] }],
                },
                present: {
                    title: "Present",
                    type: "object",
                    properties: { x: { type: "integer" } },
                },
            }),
        );
        expect(output).toContain("struct Present(T)");
        expect(output).not.toContain("class Present\n");
    });
});
