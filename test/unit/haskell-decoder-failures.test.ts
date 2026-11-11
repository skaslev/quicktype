// Haskell decoders fail on JSON they don't take, instead of throwing a
// "Non-exhaustive patterns" exception out of `decode`: unions fall back to
// `typeMismatch` for the kinds of values no member takes, records decode
// with `withObject`, and enums fail on unknown strings.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function render(schema: object): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({ inputData, lang: "haskell" });
    return result.lines.join("\n");
}

// The FromJSON instance of a type.
function fromJSON(output: string, type: string): string {
    const m = new RegExp(
        `^instance FromJSON ${type} where\\n((?: .*\\n?)*)`,
        "m",
    ).exec(output);
    if (m === null) throw new Error(`no FromJSON ${type}`);
    return m[1].trimEnd();
}

describe("Haskell decoders", () => {
    test("of unions fail on the kinds no member takes", async () => {
        const output = await render({
            oneOf: [{ type: "integer" }, { type: "string" }, { type: "null" }],
        });
        expect(fromJSON(output, "TopLevel")).toBe(
            [
                "    parseJSON xs@(Number _) = (fmap IntegerInTopLevel . parseJSON) xs",
                "    parseJSON Null = return NullInTopLevel",
                "    parseJSON xs@(String _) = (fmap StringInTopLevel . parseJSON) xs",
                '    parseJSON invalid = typeMismatch "TopLevel" invalid',
            ].join("\n"),
        );
        expect(output).toContain(
            "import Data.Aeson.Types (emptyObject, typeMismatch)",
        );
    });

    test("of unions that take every kind have no fallback", async () => {
        const output = await render({
            oneOf: [
                { type: "null" },
                { type: "boolean" },
                { type: "integer" },
                { type: "string" },
                { type: "array", items: { type: "integer" } },
                { type: "object", properties: { a: { type: "integer" } } },
            ],
        });
        expect(fromJSON(output, "TopLevel")).not.toContain("invalid");
    });

    test("of records fail on other values than objects", async () => {
        const output = await render({
            type: "object",
            properties: {
                a: { type: "integer" },
                empty: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
            },
            required: ["a", "empty"],
        });
        expect(fromJSON(output, "TopLevel")).toBe(
            [
                '    parseJSON = withObject "TopLevel" $ \\v -> TopLevel',
                '        <$> v .: "a"',
                '        <*> v .: "empty"',
            ].join("\n"),
        );
        expect(fromJSON(output, "Empty")).toBe(
            '    parseJSON = withObject "Empty" $ \\_ -> return Empty',
        );
        expect(output).not.toContain("parseJSON (Object");
    });

    test("of enums fail on unknown strings", async () => {
        const output = await render({ enum: ["a", "b"] });
        expect(fromJSON(output, "TopLevel")).toBe(
            [
                '    parseJSON = withText "TopLevel" parseText',
                "        where",
                '            parseText "a" = return ATopLevel',
                '            parseText "b" = return BTopLevel',
                '            parseText invalid = fail ("expected TopLevel, but encountered " ++ show invalid)',
            ].join("\n"),
        );
    });
});
