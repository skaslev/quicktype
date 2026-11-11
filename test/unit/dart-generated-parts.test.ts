// With `--use-hive`, `--use-json-annotation` and `--use-freezed`, Dart's
// output is completed by build_runner: hive_generator writes the adapters of
// the `@HiveType`s, json_serializable the coders of the `@JsonSerializable`
// classes (and of freezed's), freezed the freezed classes.  Enums need Hive
// adapters too, and the output names only the parts build_runner writes:
// it writes none for a file without such types, and a `part` without its
// file doesn't compile.

import { describe, expect, test } from "vitest";

import {
    InputData,
    JSONSchemaInput,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";

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

const lines = (...ls: string[]): string => ls.join("\n");

const enumProperty = {
    type: "object",
    properties: {
        e: { enum: ["x", "y"] },
        n: { type: "integer" },
    },
    required: ["e", "n"],
    additionalProperties: false,
};

describe("Dart Hive adapters", () => {
    test("enums are Hive types", async () => {
        const output = await renderSchema(enumProperty, { "use-hive": true });
        expect(output).toContain(
            lines(
                "@HiveType(typeId: 1)",
                "class TopLevel {",
                "    @HiveField(1)",
                "    final E e;",
                "    @HiveField(2)",
                "    final int n;",
            ),
        );
        expect(output).toContain(
            lines(
                "@HiveType(typeId: 2)",
                "enum E {",
                "    @HiveField(1)",
                "    X,",
                "    @HiveField(2)",
                "    Y",
                "}",
            ),
        );
    });

    test("an enum keeps its JSON values", async () => {
        const output = await renderSchema(
            { enum: ["a", "b-c"] },
            { "use-hive": true, "use-json-annotation": true },
        );
        expect(output).toContain(
            lines(
                "@HiveType(typeId: 1)",
                "enum TopLevel {",
                "    @HiveField(1)",
                '    @JsonValue("a")',
                "    A,",
                "    @HiveField(2)",
                '    @JsonValue("b-c")',
                "    B_C",
                "}",
            ),
        );
    });

    test("enums aren't Hive types without --use-hive", async () => {
        const output = await renderSchema(enumProperty);
        expect(output).not.toContain("@Hive");
    });
});

const parts = (output: string): string[] =>
    output.split("\n").filter((l) => l.startsWith("part "));

const generated = "part 'top_level.g.dart';";
const freezed = "part 'top_level.freezed.dart';";

describe("Dart part directives", () => {
    const anEnum = { enum: ["a", "b-c"] };
    const aString = { type: "string" };
    const integers = { type: "array", items: { type: "integer" } };
    const aMap = { type: "object", additionalProperties: { type: "integer" } };

    test.each([
        ["an enum", "use-json-annotation", anEnum],
        ["an enum", "use-freezed", anEnum],
        ["a string", "use-json-annotation", aString],
        ["a string", "use-freezed", aString],
        ["a string", "use-hive", aString],
        ["an array of integers", "use-freezed", integers],
        ["an array of integers", "use-hive", integers],
        ["a map of integers", "use-json-annotation", aMap],
    ])("none for %s with --%s", async (_what, option, schema) => {
        const output = await renderSchema(schema, { [option]: true });
        expect(parts(output)).toEqual([]);
    });

    test("an enum's Hive adapter", async () => {
        const output = await renderSchema(anEnum, {
            "use-hive": true,
            "use-json-annotation": true,
        });
        expect(parts(output)).toEqual([generated]);
    });

    test.each([
        ["use-json-annotation", [generated]],
        ["use-freezed", [freezed, generated]],
        ["use-hive", [generated]],
    ])("classes with --%s", async (option, expected) => {
        const output = await renderSchema(enumProperty, { [option]: true });
        expect(parts(output)).toEqual(expected);
    });
});

describe("Dart part directives for tuples", () => {
    const memberScores = {
        type: "array",
        items: {
            title: "MemberScore",
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
        },
    };
    // An optional item that can be null: the tuple has its own adapter.
    const presentOnly = {
        type: "array",
        minItems: 1,
        items: [{ type: "string" }, { type: ["string", "null"] }],
    };

    test("a tuple is a Hive type", async () => {
        const output = await renderSchema(memberScores, { "use-hive": true });
        expect(parts(output)).toEqual([generated]);
    });

    test("a tuple with its own Hive adapter needs no part", async () => {
        const output = await renderSchema(presentOnly, { "use-hive": true });
        expect(output).toContain(
            "class TopLevelAdapter extends TypeAdapter<TopLevel> {",
        );
        expect(parts(output)).toEqual([]);
    });

    test.each([
        "use-json-annotation",
        "use-freezed",
    ])("tuples are plain classes with --%s", async (option) => {
        const output = await renderSchema(memberScores, { [option]: true });
        expect(parts(output)).toEqual([]);
    });
});
