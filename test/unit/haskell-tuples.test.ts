// aeson (de)serializes Haskell tuples as JSON arrays of exactly their
// length, so Haskell keeps fixed-length tuples.  Other tuple shapes stay
// arrays of a union.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { expect, test } from "vitest";

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
        lang: "haskell",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    minItems: 2,
    maxItems: 2,
};

test.each([
    [
        "fixed length",
        { type: "array", items: pair },
        "type TopLevel = [(Text, Double)]",
    ],
    ["a top-level tuple", pair, "type TopLevel = (Text, Double)"],
    [
        "rest elements become an array",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
        },
        "type TopLevel = [TopLevelElement]",
    ],
] as const)("%s", async (_, schema, expected) => {
    expect(await renderSchema(schema)).toContain(expected);
});

test("a titled tuple becomes a type synonym", async () => {
    const output = await renderSchema({
        type: "array",
        items: { ...pair, title: "MemberScore" },
    });
    expect(output).toContain("type TopLevel = [MemberScore]");
    expect(output).toContain("type MemberScore = (Text, Double)");
    expect(output).toContain(", MemberScore (..)");
});

// Haskell has no one-element tuple, and aeson encodes `Solo a` as just `a`.
test("a one-element tuple becomes a newtype", async () => {
    const output = await renderSchema({
        type: "array",
        items: { type: "array", items: [{ type: "string" }] },
    });
    expect(output).toContain("type TopLevel = [TopLevelElement]");
    expect(output).toContain("newtype TopLevelElement = TopLevelElement Text");
    expect(output).toContain(
        "toJSON (TopLevelElement x0) = toJSON [toJSON x0]",
    );
    expect(output).toContain("[x0] -> TopLevelElement <$> parseJSON x0");
});

// A type synonym can't refer to itself.
test("a recursive tuple becomes a data type", async () => {
    const output = await renderSchema({
        $ref: "#/$defs/node",
        $defs: {
            node: {
                type: "array",
                items: [
                    { type: "string" },
                    { type: "array", items: { $ref: "#/$defs/node" } },
                ],
            },
        },
    });
    expect(output).toContain("data TopLevel = TopLevel Text ([TopLevel])");
    expect(output).toContain(
        "toJSON (TopLevel x0 x1) = toJSON [toJSON x0, toJSON x1]",
    );
    expect(output).toContain(
        "[x0, x1] -> TopLevel <$> parseJSON x0 <*> parseJSON x1",
    );
});

// aeson and Show have instances for tuples of up to 15 elements.
test("a tuple of more than 15 elements becomes a data type", async () => {
    const output = await renderSchema({
        type: "array",
        items: Array.from({ length: 16 }, () => ({ type: "integer" })),
    });
    expect(output).toContain(`data TopLevel = TopLevel${" Int".repeat(16)}`);
});

test("a union tries its tuples, then its array", async () => {
    const output = await renderSchema({
        oneOf: [
            { type: "string" },
            { type: "array", items: { type: "integer" } },
            {
                type: "array",
                items: [{ type: "integer" }, { type: "integer" }],
            },
        ],
    });
    expect(output).toContain("import Control.Applicative ((<|>))");
    expect(output).toContain(
        "parseJSON xs@(Array _) = (fmap TupleInTopLevel . parseJSON) xs <|> (fmap IntegerArrayInTopLevel . parseJSON) xs",
    );
});
