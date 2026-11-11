// A Haskell tuple has exactly one element per item, so tuples with optional
// items or a rest become data types with a `Maybe` field per optional item
// and a final list for the rest, and JSON instances that read and write an
// array.

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
            items: [{ type: "string" }, { type: "integer" }],
        },
    },
};

// GEOSEARCH WITH*: a name, then up to three of distance, hash, coordinates.
const geoResults = {
    type: "array",
    items: {
        title: "GeoResult",
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: [{ type: "string" }],
        additionalItems: {
            oneOf: [
                { type: "string" },
                { type: "integer" },
                {
                    type: "array",
                    items: [{ type: "number" }, { type: "number" }],
                },
            ],
        },
    },
};

test("a rest becomes a final list", async () => {
    const output = await renderSchema(slotRanges);
    expect(output).toContain("type TopLevel = [SlotRange]");
    expect(output).toContain(
        "data SlotRange = SlotRange Int Int SlotNode ([SlotNode])",
    );
    expect(output).toContain(", SlotRange (..)");
    // Fixed-length tuples are still Haskell tuples.
    expect(output).toContain("type SlotNode = (Text, Int)");
});

test("the rest is written after the items and read from the tail", async () => {
    const output = await renderSchema(slotRanges);
    expect(output).toContain(
        "toJSON (SlotRange x0 x1 x2 rest) = toJSON ([toJSON x0, toJSON x1, toJSON x2] ++ map toJSON rest)",
    );
    expect(output).toContain(
        [
            "instance FromJSON SlotRange where",
            "    parseJSON v = do",
            "        xs <- parseJSON v",
            "        case xs of",
            "            (x0 : x1 : x2 : rest) -> SlotRange <$> parseJSON x0 <*> parseJSON x1 <*> parseJSON x2 <*> mapM parseJSON rest",
            '            _ -> fail "SlotRange: expected an array of at least 3 elements"',
        ].join("\n"),
    );
});

test("optional items become Maybe fields", async () => {
    const output = await renderSchema(geoResults);
    expect(output).toContain(
        "data GeoResult = GeoResult Text (Maybe GeoResultElement) (Maybe GeoResultElement) (Maybe GeoResultElement)",
    );
    expect(output).toContain(
        [
            "            [x0] -> GeoResult <$> parseJSON x0 <*> pure Nothing <*> pure Nothing <*> pure Nothing",
            "            [x0, x1] -> GeoResult <$> parseJSON x0 <*> (Just <$> parseJSON x1) <*> pure Nothing <*> pure Nothing",
            "            [x0, x1, x2] -> GeoResult <$> parseJSON x0 <*> (Just <$> parseJSON x1) <*> (Just <$> parseJSON x2) <*> pure Nothing",
            "            [x0, x1, x2, x3] -> GeoResult <$> parseJSON x0 <*> (Just <$> parseJSON x1) <*> (Just <$> parseJSON x2) <*> (Just <$> parseJSON x3)",
            '            _ -> fail "GeoResult: expected an array of 1 to 4 elements"',
        ].join("\n"),
    );
});

test("an item after a missing one isn't written", async () => {
    const output = await renderSchema(geoResults);
    expect(output).toContain(
        [
            "    toJSON (GeoResult x0 x1 x2 x3) = case (x1, x2, x3) of",
            "        (Nothing, Nothing, Nothing) -> toJSON [toJSON x0]",
            "        (Just y1, Nothing, Nothing) -> toJSON [toJSON x0, toJSON y1]",
            "        (Just y1, Just y2, Nothing) -> toJSON [toJSON x0, toJSON y1, toJSON y2]",
            "        (Just y1, Just y2, Just y3) -> toJSON [toJSON x0, toJSON y1, toJSON y2, toJSON y3]",
            '        _ -> error "GeoResult: an item follows a missing optional item"',
        ].join("\n"),
    );
});

test("optional items and a rest", async () => {
    const output = await renderSchema({
        type: "array",
        minItems: 1,
        prefixItems: [{ type: "string" }, { type: "integer" }],
        items: { type: "boolean" },
    });
    expect(output).toContain(
        "data TopLevel = TopLevel Text (Maybe Int) ([Bool])",
    );
    expect(output).toContain(
        [
            "    toJSON (TopLevel x0 x1 rest) = case x1 of",
            "        Nothing | null rest -> toJSON [toJSON x0]",
            "        Just y1 -> toJSON ([toJSON x0, toJSON y1] ++ map toJSON rest)",
            '        _ -> error "TopLevel: an item follows a missing optional item"',
        ].join("\n"),
    );
    expect(output).toContain(
        [
            "            [x0] -> TopLevel <$> parseJSON x0 <*> pure Nothing <*> pure mempty",
            "            (x0 : x1 : rest) -> TopLevel <$> parseJSON x0 <*> (Just <$> parseJSON x1) <*> mapM parseJSON rest",
            '            _ -> fail "TopLevel: expected an array of at least 1 element"',
        ].join("\n"),
    );
});

test("a single optional item has no gap", async () => {
    const output = await renderSchema({
        type: "array",
        minItems: 1,
        items: [{ type: "string" }, { type: "integer" }],
    });
    expect(output).toContain(
        [
            "    toJSON (TopLevel x0 x1) = case x1 of",
            "        Nothing -> toJSON [toJSON x0]",
            "        Just y1 -> toJSON [toJSON x0, toJSON y1]",
            "",
        ].join("\n"),
    );
});

test("an empty array has a type", async () => {
    const output = await renderSchema({
        type: "array",
        minItems: 0,
        items: [{ type: "string" }],
    });
    expect(output).toContain("newtype TopLevel = TopLevel (Maybe Text)");
    expect(output).toContain("Nothing -> toJSON ([] :: [Value])");
    expect(output).toContain("[] -> TopLevel <$> pure Nothing");
    expect(output).toContain(
        '_ -> fail "TopLevel: expected an array of at most 1 element"',
    );
});

test("an optional nullable item tells null from missing", async () => {
    const output = await renderSchema({
        type: "array",
        minItems: 1,
        items: [
            { type: "integer" },
            { oneOf: [{ type: "string" }, { type: "null" }] },
        ],
    });
    expect(output).toContain(
        "data TopLevel = TopLevel Int (Maybe (Maybe Text))",
    );
});

test("the rest follows --array-type", async () => {
    const output = await renderSchema(slotRanges, { "array-type": "array" });
    expect(output).toContain("import qualified Data.Vector");
    expect(output).toContain(
        "data SlotRange = SlotRange Int Int SlotNode (Vector SlotNode)",
    );
    expect(output).toContain("++ map toJSON (Data.Vector.toList rest))");
    expect(output).toContain(
        "<*> (Data.Vector.fromList <$> mapM parseJSON rest)",
    );
});

test("a recursive rest", async () => {
    const output = await renderSchema({
        $ref: "#/$defs/node",
        $defs: {
            node: {
                type: "array",
                prefixItems: [{ type: "string" }],
                items: { $ref: "#/$defs/node" },
            },
        },
    });
    expect(output).toContain("data TopLevel = TopLevel Text ([TopLevel])");
});

// A type synonym can refer to itself through a data type.
test("a fixed-length tuple containing itself through one stays a synonym", async () => {
    const output = await renderSchema({
        $ref: "#/$defs/pair",
        $defs: {
            pair: {
                type: "array",
                items: [{ type: "string" }, { $ref: "#/$defs/chain" }],
            },
            chain: {
                title: "Chain",
                type: "array",
                prefixItems: [{ type: "integer" }],
                items: { $ref: "#/$defs/pair" },
            },
        },
    });
    expect(output).toContain("type TopLevel = (Text, Chain)");
    expect(output).toContain("data Chain = Chain Int ([TopLevel])");
});

test("a union tries fixed-length tuples, then optional items, then a rest, then arrays", async () => {
    const output = await renderSchema({
        oneOf: [
            { type: "string" },
            { type: "array", items: { type: "integer" } },
            {
                title: "Tagged",
                type: "array",
                prefixItems: [{ type: "string" }],
                items: { type: "integer" },
            },
            {
                title: "Flag",
                type: "array",
                minItems: 1,
                items: [{ type: "boolean" }, { type: "number" }],
            },
            {
                type: "array",
                items: [{ type: "integer" }, { type: "integer" }],
            },
        ],
    });
    expect(output).toContain(
        "parseJSON xs@(Array _) = (fmap TupleInTopLevel . parseJSON) xs <|> (fmap FlagInTopLevel . parseJSON) xs <|> (fmap TaggedInTopLevel . parseJSON) xs <|> (fmap IntegerArrayInTopLevel . parseJSON) xs",
    );
});
