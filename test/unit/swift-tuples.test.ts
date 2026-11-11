// Swift's tuples can't conform to Codable, so a JSON Schema tuple is a
// struct with a property per item, `itemN`, optionals for the optional
// items and an array `rest` for the rest.  Outside just-types mode its
// `init(from:)` and `encode(to:)` read and write a JSON array, and the
// union enums that contain tuples try them before their array.

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
        lang: "swift",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const justTypes = { "just-types": true };

const lines = (...ls: string[]): string => ls.join("\n");

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

// ROLE: one tuple per role.
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

// Like COMMAND INFO: a command's last item is its subcommands.
const commands = {
    type: "object",
    properties: { root: { $ref: "#/$defs/node" } },
    required: ["root"],
    additionalProperties: false,
    $defs: {
        node: {
            title: "Node",
            type: "array",
            minItems: 1,
            items: [
                { type: "string" },
                { type: "array", items: { $ref: "#/$defs/node" } },
            ],
        },
    },
};

// A tuple whose optional second item is the tuple itself.
const chain = {
    type: "object",
    properties: { root: { $ref: "#/$defs/node" } },
    required: ["root"],
    additionalProperties: false,
    $defs: {
        node: {
            title: "Chain",
            type: "array",
            minItems: 1,
            items: [{ type: "string" }, { $ref: "#/$defs/node" }],
        },
    },
};

describe("declarations", () => {
    test("a fixed-length tuple is a struct with a property per item", async () => {
        const output = await renderSchema(memberScores, justTypes);
        expect(output).toContain(
            lines(
                "// MARK: - MemberScore",
                "struct MemberScore {",
                "    let item0: String",
                "    let item1: Double",
                "}",
            ),
        );
        // Not an enum of the item types.
        expect(output).not.toContain("case double(Double)");
    });

    test("optional items are optionals, the rest an array", async () => {
        const output = await renderSchema(optionals, justTypes);
        // A missing item is nil, a null one `.some(nil)`.
        expect(output).toContain(
            lines(
                "struct Opt {",
                "    let item0: String",
                "    let item1: Bool?",
                "    let item2: String??",
                "}",
            ),
        );
        expect(output).toContain(
            lines(
                "struct Counts {",
                "    let item0: String",
                "    let item1: Bool?",
                "    let rest: [Int]",
                "}",
            ),
        );
        const slots = await renderSchema(slotRanges, justTypes);
        expect(slots).toContain(
            lines(
                "struct SlotRange {",
                "    let item0: Int",
                "    let item1: Int",
                "    let item2: SlotNode",
                "    let rest: [SlotNode]",
                "}",
            ),
        );
        expect(slots).toContain("    let item0: String?\n    let item1: Int\n");
    });

    test("a tuple that contains itself through an array is a struct", async () => {
        const output = await renderSchema(commands, justTypes);
        expect(output).toContain(
            lines(
                "struct Node {",
                "    let item0: String",
                "    let item1: [Node]?",
                "}",
            ),
        );
    });

    test("a tuple that contains itself directly is a class", async () => {
        const output = await renderSchema(chain, justTypes);
        expect(output).toContain(
            lines(
                "class Chain {",
                "    let item0: String",
                "    let item1: Chain?",
                "",
                "    init(item0: String, item1: Chain?) {",
            ),
        );
    });

    test("tuples are values in dictionaries, arrays, classes and tuples", async () => {
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
                    maybe: pair,
                    outer: {
                        title: "Outer",
                        type: "array",
                        items: [pair, { type: "boolean" }],
                    },
                },
                required: ["byName", "list", "outer"],
                additionalProperties: false,
            },
            justTypes,
        );
        expect(output).toContain(
            lines(
                "struct TopLevel {",
                "    let byName: [String: Pair]",
                "    let list: [Pair]",
                "    let maybe: Pair?",
                "    let outer: Outer",
                "}",
            ),
        );
        expect(output).toContain(
            "struct Outer {\n    let item0: Pair\n    let item1: Bool\n}",
        );
    });

    test("just-types output is not Codable, like classes and unions", async () => {
        for (const schema of [slotRanges, optionals, rank, pending]) {
            const output = await renderSchema(schema, justTypes);
            expect(output).not.toContain("Codable");
            expect(output).not.toContain("init(from decoder: Decoder)");
            expect(output).not.toContain("func encode(to encoder: Encoder)");
        }
    });
});

describe("Codable", () => {
    test("init(from:) reads each item from an unkeyed container", async () => {
        const output = await renderSchema(slotRanges);
        expect(output).toContain("struct SlotRange: Codable {");
        // The memberwise initializer, which init(from:) would hide.
        expect(output).toContain(
            "    init(item0: Int, item1: Int, item2: SlotNode, rest: [SlotNode]) {",
        );
        expect(output).toContain(
            lines(
                "    init(from decoder: Decoder) throws {",
                "        var container = try decoder.unkeyedContainer()",
                "        item0 = try container.decode(Int.self)",
                "        item1 = try container.decode(Int.self)",
                "        item2 = try container.decode(SlotNode.self)",
                "        var rest: [SlotNode] = []",
                "        while !container.isAtEnd {",
                "            rest.append(try container.decode(SlotNode.self))",
                "        }",
                "        self.rest = rest",
                "    }",
            ),
        );
        // Null only for nullable items; no more elements than items.
        expect(output).toContain(
            lines(
                "        item0 = try container.decodeNil() ? nil : container.decode(String.self)",
                "        item1 = try container.decode(Int.self)",
                "        if !container.isAtEnd {",
                '            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected 2 elements for SlotNode")',
                "        }",
            ),
        );
    });

    test("optional items are decoded if they are there", async () => {
        const output = await renderSchema(optionals);
        expect(output).toContain(
            lines(
                "        item1 = try container.isAtEnd ? nil : container.decode(Bool.self)",
                "        item2 = try container.isAtEnd ? nil : .some(container.decodeNil() ? nil : container.decode(String.self))",
                "        if !container.isAtEnd {",
                '            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected 1 to 3 elements for Opt")',
                "        }",
            ),
        );
    });

    test("encode(to:) writes the items that are there, without gaps", async () => {
        const output = await renderSchema(optionals);
        expect(output).toContain(
            lines(
                "    func encode(to encoder: Encoder) throws {",
                "        if item1 == nil && item2 != nil {",
                '            throw EncodingError.invalidValue(self, EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "An item of Opt follows a missing optional item"))',
                "        }",
                "        var container = encoder.unkeyedContainer()",
                "        try container.encode(item0)",
                "        if let x = item1 {",
                "            try container.encode(x)",
                "        }",
                "        if let x = item2 {",
                "            try container.encode(x)",
                "        }",
                "    }",
            ),
        );
        expect(output).toContain(
            lines(
                "        if item1 == nil && !rest.isEmpty {",
                '            throw EncodingError.invalidValue(self, EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "An item of Counts follows a missing optional item"))',
                "        }",
            ),
        );
        expect(output).toContain(
            "        try container.encode(contentsOf: rest)",
        );
    });

    test("tuples get the convenience initializers of classes", async () => {
        const output = await renderSchema(memberScores);
        expect(output).toContain(
            lines(
                "extension MemberScore {",
                "    init(data: Data) throws {",
                "        self = try newJSONDecoder().decode(MemberScore.self, from: data)",
                "    }",
            ),
        );
        expect(output).toContain(
            lines(
                "    func with(",
                "        item0: String? = nil,",
                "        item1: Double? = nil",
                "    ) -> MemberScore {",
            ),
        );
        const plain = await renderSchema(memberScores, {
            initializers: false,
        });
        expect(plain).not.toContain("extension MemberScore");
    });
});

describe("unions", () => {
    test("a union decodes an array as its tuple before its array", async () => {
        const output = await renderSchema(pending);
        expect(output).toContain(
            lines(
                "enum TopLevel: Codable {",
                "    case pendingEntryArray([PendingEntry])",
                "    case pendingSummary(PendingSummary)",
            ),
        );
        expect(output).toContain(
            lines(
                "        let container = try decoder.singleValueContainer()",
                "        if let x = try? container.decode(PendingSummary.self) {",
                "            self = .pendingSummary(x)",
                "            return",
                "        }",
                "        if let x = try? container.decode([PendingEntry].self) {",
                "            self = .pendingEntryArray(x)",
                "            return",
                "        }",
            ),
        );
    });

    test("a union with a tuple, an integer and null", async () => {
        const output = await renderSchema(rank);
        expect(output).toContain(
            lines(
                "enum TopLevel: Codable {",
                "    case integer(Int)",
                "    case rankScore(RankScore)",
                "    case null",
            ),
        );
        expect(output).toContain(
            lines(
                "        if let x = try? container.decode(Int.self) {",
                "            self = .integer(x)",
                "            return",
                "        }",
                "        if let x = try? container.decode(RankScore.self) {",
                "            self = .rankScore(x)",
                "            return",
                "        }",
                "        if container.decodeNil() {",
            ),
        );
    });

    test("a union with several tuples tries each", async () => {
        const output = await renderSchema(roles);
        expect(output).toContain(
            lines(
                "        if let x = try? container.decode(MasterRole.self) {",
                "            self = .masterRole(x)",
                "            return",
                "        }",
                "        if let x = try? container.decode(SentinelRole.self) {",
                "            self = .sentinelRole(x)",
                "            return",
                "        }",
            ),
        );
        expect(output).toContain(
            "struct MasterRole: Codable {\n    let item0: MasterRoleElement\n",
        );
    });
});

describe("options", () => {
    test("classes, with Objective-C support", async () => {
        const output = await renderSchema(optionals, {
            "struct-or-class": "class",
            "objective-c-support": true,
        });
        expect(output).toContain("@objcMembers class Opt: NSObject, Codable {");
        expect(output).toContain(
            "    required init(from decoder: Decoder) throws {",
        );
        expect(output).toContain(
            "        let me = try newJSONDecoder().decode(Opt.self, from: data)",
        );
        expect(output).toContain(
            "        self.init(item0: me.item0, item1: me.item1, item2: me.item2)",
        );
        // A recursive tuple is a class anyway.
        const recursive = await renderSchema(chain);
        expect(recursive).toContain("class Chain: Codable {");
        expect(recursive).toContain(
            "    required init(from decoder: Decoder) throws {",
        );
    });

    test("final classes, Sendable", async () => {
        const output = await renderSchema(memberScores, {
            "struct-or-class": "class",
            sendable: true,
        });
        expect(output).toContain(
            "final class MemberScore: Codable, Sendable {",
        );
    });

    test("public access, mutable properties, protocols", async () => {
        const output = await renderSchema(memberScores, {
            "access-level": "public",
            "mutable-properties": true,
            protocol: "hashable",
        });
        expect(output).toContain(
            lines(
                "public struct MemberScore: Codable, Hashable {",
                "    public var item0: String",
                "    public var item1: Double",
                "",
                "    public init(item0: String, item1: Double) {",
            ),
        );
        expect(output).toContain(
            "    public init(from decoder: Decoder) throws {",
        );
        expect(output).toContain(
            "    public func encode(to encoder: Encoder) throws {",
        );
        // Public structs need an initializer in just-types mode, too.
        const plain = await renderSchema(memberScores, {
            ...justTypes,
            "access-level": "public",
        });
        expect(plain).toContain(
            "    public init(item0: String, item1: Double) {",
        );
    });

    test("dense output puts items of the same type on one line", async () => {
        const output = await renderSchema(slotRanges, { density: "dense" });
        expect(output).toContain(
            lines(
                "struct SlotRange: Codable {",
                "    let item0, item1: Int",
                "    let item2: SlotNode",
                "    let rest: [SlotNode]",
            ),
        );
        // Not an optional item with a required one.
        const opt = await renderSchema(
            {
                title: "Range",
                type: "array",
                minItems: 2,
                items: [
                    { type: "integer" },
                    { type: "integer" },
                    { type: "integer" },
                ],
            },
            { density: "dense" },
        );
        expect(opt).toContain(
            "    let item0, item1: Int\n    let item2: Int?\n",
        );
    });

    test("multi-file output has a file per tuple", async () => {
        const files = await quicktypeMultiFile({
            inputData: await schemaInput(optionals),
            lang: "swift",
            rendererOptions: { "multi-file-output": true },
        });
        const opt = files.get("Opt.swift")?.lines.join("\n") ?? "";
        expect(opt).toContain("//   let opt = try Opt(json)");
        expect(opt).toContain("import Foundation");
        expect(opt).toContain("struct Opt: Codable {");
        expect(files.get("TopLevel.swift")?.lines.join("\n")).not.toContain(
            "struct Opt",
        );
    });
});
