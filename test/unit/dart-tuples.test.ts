// A JSON Schema tuple is a Dart class with a field per item, `itemN`,
// nullable fields for the optional items and a list `rest` for the rest.
// Outside just-types mode its `fromJson` reads a JSON array, checking its
// length, and its `toJson` writes one.  Dart's unions stay `dynamic`.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({
        inputData,
        lang: "dart",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const justTypes = { "just-types": true };

const lines = (...ls: string[]): string => ls.join("\n");

// An object, so that the tuples keep their titles: Dart names a top-level's
// only class after the top-level.
function inObject(properties: Record<string, object>): object {
    return {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
    };
}

// ZRANGE WITHSCORES: `[member, score]` pairs.
const memberScores = inObject({
    pairs: {
        type: "array",
        items: {
            title: "MemberScore",
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
        },
    },
});

// CLUSTER SLOTS: `[start, end, master, ...replicas]`.
const slotRanges = inObject({
    ranges: {
        type: "array",
        items: {
            title: "SlotRange",
            type: "array",
            minItems: 3,
            items: [
                { type: "integer" },
                { type: "integer" },
                { $ref: "#/$defs/node" },
            ],
            additionalItems: { $ref: "#/$defs/node" },
        },
    },
});
Object.assign(slotRanges, {
    $defs: {
        node: {
            title: "SlotNode",
            type: "array",
            items: [{ type: ["string", "null"] }, { type: "integer" }],
        },
    },
});

// A string, then an optional number and an optional nullable string.
const optionals = inObject({
    opt: {
        title: "Opt",
        type: "array",
        minItems: 1,
        items: [
            { type: "string" },
            { type: "number" },
            { type: ["string", "null"] },
        ],
    },
});

// ZRANK: null, a rank, or a rank and a score; and a nullable member and
// score.
const ranks = inObject({
    rank: {
        oneOf: [
            { type: "null" },
            { type: "integer" },
            {
                title: "RankScore",
                type: "array",
                items: [{ type: "integer" }, { type: "number" }],
            },
        ],
    },
    maybe: {
        oneOf: [
            { type: "null" },
            {
                title: "MaybeRankScore",
                type: "array",
                items: [{ type: "string" }, { type: "number" }],
            },
        ],
    },
});

// COMMAND INFO: a command's subcommands are commands.
const commands = inObject({
    commands: {
        type: "array",
        items: { $ref: "#/$defs/command" },
    },
});
Object.assign(commands, {
    $defs: {
        command: {
            title: "Command",
            type: "array",
            items: [
                { type: "string" },
                { type: "integer" },
                { type: "array", items: { $ref: "#/$defs/command" } },
            ],
        },
    },
});

describe("tuples", () => {
    test("are classes with a field per item", async () => {
        const output = await renderSchema(memberScores, justTypes);
        expect(output).not.toContain("fromJson");
        expect(output).toContain("final List<MemberScore> pairs;");
        expect(output).toContain(
            lines(
                "class MemberScore {",
                "    final String item0;",
                "    final double item1;",
                "",
                "    MemberScore({",
                "        required this.item0,",
                "        required this.item1,",
                "    });",
                "}",
            ),
        );
    });

    test("read and write JSON arrays of exactly their length", async () => {
        const output = await renderSchema(memberScores);
        expect(output).toContain(
            lines(
                "    factory MemberScore.fromJson(List<dynamic> json) {",
                "        if (json.length != 2) {",
                '            throw FormatException("Expected 2 elements for MemberScore");',
                "        }",
                "        return MemberScore(",
                "            item0: json[0],",
                "            item1: json[1]?.toDouble(),",
                "        );",
                "    }",
                "",
                "    List<dynamic> toJson() => [",
                "        item0,",
                "        item1,",
                "    ];",
            ),
        );
        expect(output).toContain(
            'pairs: List<MemberScore>.from(json["pairs"].map((x) => MemberScore.fromJson(x))),',
        );
        expect(output).toContain(
            '"pairs": List<dynamic>.from(pairs.map((x) => x.toJson())),',
        );
    });

    test("have a list for the rest", async () => {
        const output = await renderSchema(slotRanges);
        expect(output).toContain(
            lines(
                "class SlotRange {",
                "    final int item0;",
                "    final int item1;",
                "    final SlotNode item2;",
                "    final List<SlotNode> rest;",
            ),
        );
        expect(output).toContain(
            lines(
                "        if (json.length < 3) {",
                '            throw FormatException("Expected at least 3 elements for SlotRange");',
                "        }",
            ),
        );
        expect(output).toContain(
            "rest: List<SlotNode>.from(json.skip(3).map((x) => SlotNode.fromJson(x))),",
        );
        expect(output).toContain("...rest.map((x) => x.toJson()),");
    });

    test("have nullable fields for optional items", async () => {
        const output = await renderSchema(optionals);
        expect(output).toContain(
            lines(
                "class Opt {",
                "    final String item0;",
                "    final double? item1;",
                "    final Present<String?>? item2;",
                "",
                "    Opt({",
                "        required this.item0,",
                "        this.item1,",
                "        this.item2,",
                "    });",
            ),
        );
        expect(output).toContain(
            lines(
                "        if (json.length < 1 || json.length > 3) {",
                '            throw FormatException("Expected 1 to 3 elements for Opt");',
                "        }",
            ),
        );
        // A null element isn't a missing item.
        expect(output).toContain(
            `item1: json.length > 1 ? (json[1] ?? (throw FormatException("Item 1 of Opt can't be null")))?.toDouble() : null,`,
        );
        expect(output).toContain(
            "item2: json.length > 2 ? Present<String?>(json[2]) : null,",
        );
        // JSON arrays can't leave a gap.
        expect(output).toContain(
            lines(
                "    List<dynamic> toJson() {",
                "        if (item1 == null && item2 != null) {",
                '            throw StateError("An item of Opt follows a missing optional item");',
                "        }",
                "        return [",
                "            item0,",
                "            if (item1 != null) item1!,",
                "            if (item2 != null) item2!.value,",
                "        ];",
                "    }",
            ),
        );
        expect(output).toContain("class Present<T> {");
    });

    test("declare Present only if they need it", async () => {
        const output = await renderSchema(memberScores);
        expect(output).not.toContain("Present");
    });

    test("keep Present's name for it", async () => {
        const output = await renderSchema({
            ...optionals,
            properties: {
                ...(optionals as { properties: object }).properties,
                present: {
                    title: "Present",
                    type: "object",
                    properties: { x: { type: "integer" } },
                },
            },
        });
        expect(output).toContain("class Present<T> {");
        expect(output).not.toContain("class Present {");
    });

    test("in unions are dynamic, like the unions", async () => {
        const output = await renderSchema(ranks);
        expect(output).toContain("final dynamic rank;");
        expect(output).toContain("final MaybeRankScore? maybe;");
        expect(output).toContain(
            'maybe: (json.containsKey("maybe") ? json["maybe"] : throw FormatException(\'Missing required property\')) == null ? null : MaybeRankScore.fromJson(',
        );
        expect(output).toContain('"maybe": maybe?.toJson(),');
    });

    test("can contain themselves", async () => {
        const output = await renderSchema(commands);
        expect(output).toContain("final List<Command> item2;");
        expect(output).toContain(
            "item2: List<Command>.from(json[2].map((x) => Command.fromJson(x))),",
        );
    });

    test("take the top-level's name", async () => {
        const output = await renderSchema({
            type: "array",
            items: [
                { type: "string" },
                {
                    title: "A",
                    type: "object",
                    properties: { x: { type: "integer" } },
                },
                {
                    title: "B",
                    type: "object",
                    properties: { y: { type: "integer" } },
                },
            ],
        });
        expect(output).toContain(
            "TopLevel topLevelFromJson(String str) => TopLevel.fromJson(json.decode(str));",
        );
        expect(output).toContain("    final A item1;");
    });
});

describe("tuple options", () => {
    test("--from-map names the coders", async () => {
        const output = await renderSchema(memberScores, { "from-map": true });
        expect(output).toContain(
            "factory MemberScore.fromMap(List<dynamic> json) {",
        );
        expect(output).toContain("List<dynamic> toMap() => [");
    });

    test("--coders-in-class reads and writes strings", async () => {
        const output = await renderSchema(memberScores, {
            "coders-in-class": true,
        });
        expect(output).toContain(
            "factory MemberScore.fromRawJson(String str) => MemberScore.fromJson(json.decode(str));",
        );
    });

    test("--copy-with copies", async () => {
        const output = await renderSchema(optionals, { "copy-with": true });
        expect(output).toContain(
            lines(
                "    Opt copyWith({",
                "        String? item0,",
                "        double? item1,",
                "        Present<String?>? item2,",
                "    }) => ",
                "        Opt(",
                "            item0: item0 ?? this.item0,",
            ),
        );
    });

    test("--no-final-props makes the fields mutable", async () => {
        const output = await renderSchema(memberScores, {
            "final-props": false,
        });
        expect(output).toContain("    String item0;");
    });

    test("--use-hive annotates the fields", async () => {
        const output = await renderSchema(memberScores, { "use-hive": true });
        expect(output).toContain(
            lines(
                "@HiveType(typeId: 2)",
                "class MemberScore {",
                "    @HiveField(1)",
                "    final String item0;",
                "    @HiveField(2)",
                "    final double item1;",
            ),
        );
    });

    // hive_generator would read an item `Present<String?>?` back as a
    // `Present<String>?`, which it never is: such tuples store their JSON.
    test("--use-hive gives tuples with Present items their own adapter", async () => {
        const output = await renderSchema(optionals, { "use-hive": true });
        expect(output).toContain(
            lines(
                "class Opt {",
                "    final String item0;",
                "    final double? item1;",
                "    final Present<String?>? item2;",
            ),
        );
        expect(output).toContain(
            lines(
                "class OptAdapter extends TypeAdapter<Opt> {",
                "    @override",
                "    final int typeId = 2;",
                "",
                "    @override",
                "    Opt read(BinaryReader reader) => Opt.fromJson(json.decode(reader.readString()));",
                "",
                "    @override",
                "    void write(BinaryWriter writer, Opt obj) => writer.writeString(json.encode(obj.toJson()));",
                "}",
            ),
        );
        expect(output).not.toContain("@HiveType(typeId: 2)");
        expect(output).toContain("@HiveType(typeId: 1)\nclass TopLevel {");
    });

    test("--use-hive adapters follow --from-map", async () => {
        const output = await renderSchema(optionals, {
            "use-hive": true,
            "from-map": true,
        });
        expect(output).toContain(
            "    Opt read(BinaryReader reader) => Opt.fromMap(json.decode(reader.readString()));",
        );
        expect(output).toContain(
            "    void write(BinaryWriter writer, Opt obj) => writer.writeString(json.encode(obj.toMap()));",
        );
    });

    // Their generated code reads and writes JSON objects only, and calls the
    // tuple's coders.
    test.each([
        ["use-freezed", "@freezed"],
        ["use-json-annotation", "@JsonSerializable()"],
    ])("--%s keeps tuples plain classes", async (option, annotation) => {
        const output = await renderSchema(memberScores, { [option]: true });
        expect(output).toContain(`${annotation}\n`);
        expect(output).toContain(
            lines(
                "class MemberScore {",
                "    final String item0;",
                "    final double item1;",
            ),
        );
        expect(output).toContain(
            "factory MemberScore.fromJson(List<dynamic> json) {",
        );
    });
});
