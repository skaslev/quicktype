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
