// Tuples with optional trailing items or a rest become Rust tuple structs
// with `Option` fields for the optional items and a final `Vec` for the
// rest.  serde would (de)serialize a tuple struct as an array of exactly its
// length, so they get hand-written Serialize and Deserialize impls.

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
        lang: "rust",
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

test("a rest becomes a final Vec", async () => {
    const output = await renderSchema(slotRanges);
    expect(output).toContain("pub type TopLevel = Vec<SlotRange>;");
    expect(output).toContain(
        "#[derive(Debug, Clone)]\npub struct SlotRange(pub i64, pub i64, pub SlotNode, pub Vec<SlotNode>);",
    );
    // The title is the tuple's, not the name of a union of its items.
    expect(output).not.toContain("enum SlotRange");
    // Fixed-length tuples still derive their impls.
    expect(output).toContain(
        "#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct SlotNode(pub String, pub i64);",
    );
});

test("the rest is serialized after the items", async () => {
    const output = await renderSchema(slotRanges);
    expect(output).toContain(
        [
            "impl Serialize for SlotRange {",
            "    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {",
            "        use serde::ser::SerializeSeq;",
            "",
            "        let mut seq = serializer.serialize_seq(None)?;",
            "        seq.serialize_element(&self.0)?;",
            "        seq.serialize_element(&self.1)?;",
            "        seq.serialize_element(&self.2)?;",
            "        for item in &self.3 {",
            "            seq.serialize_element(item)?;",
            "        }",
            "        seq.end()",
            "    }",
            "}",
        ].join("\n"),
    );
});

test("required items are checked, the rest collected", async () => {
    const output = await renderSchema(slotRanges);
    expect(output).toContain("impl<'de> Deserialize<'de> for SlotRange {");
    expect(output).toContain(
        'formatter.write_str("an array of at least 3 elements")',
    );
    expect(output).toContain(
        [
            "                let Some(item2) = seq.next_element()? else {",
            "                    return Err(serde::de::Error::invalid_length(2, &self));",
            "                };",
            "                let mut rest = Vec::new();",
            "                while let Some(item) = seq.next_element()? {",
            "                    rest.push(item);",
            "                }",
            "                Ok(SlotRange(item0, item1, item2, rest))",
        ].join("\n"),
    );
    expect(output).toContain("deserializer.deserialize_seq(SlotRangeVisitor)");
});

test("optional items become Option fields", async () => {
    const output = await renderSchema(geoResults);
    // Untitled tuples get inferred names.
    expect(output).toContain("pub type TopLevel = Vec<TopLevelTuple>;");
    expect(output).toContain(
        "pub struct TopLevelTuple(pub String, pub Option<TopLevelUnion>, pub Option<TopLevelUnion>, pub Option<TopLevelUnion>);",
    );
    expect(output).toContain(
        'formatter.write_str("an array of 1 to 4 elements")',
    );
    expect(output).toContain(
        [
            "                let item1 = seq.next_element()?;",
            "                let item2 = seq.next_element()?;",
            "                let item3 = seq.next_element()?;",
            "                Ok(TopLevelTuple(item0, item1, item2, item3))",
        ].join("\n"),
    );
});

test("an item after a missing one isn't serialized", async () => {
    const output = await renderSchema(geoResults);
    expect(output).toContain(
        [
            "        let present = [self.1.is_some(), self.2.is_some(), self.3.is_some()];",
            "        if present.windows(2).any(|pair| pair == [false, true]) {",
            '            return Err(serde::ser::Error::custom("TopLevelTuple: an item follows a missing optional item"));',
            "        }",
            "",
            "        let mut seq = serializer.serialize_seq(None)?;",
            "        seq.serialize_element(&self.0)?;",
            "        if let Some(item) = &self.1 {",
            "            seq.serialize_element(item)?;",
            "        }",
        ].join("\n"),
    );
});

test("optional items and a rest", async () => {
    const output = await renderSchema({
        type: "object",
        properties: {
            row: {
                type: "array",
                minItems: 1,
                prefixItems: [{ type: "string" }, { type: "integer" }],
                items: { type: "boolean" },
            },
        },
        required: ["row"],
    });
    expect(output).toContain(
        "pub struct Row(pub String, pub Option<i64>, pub Vec<bool>);",
    );
    expect(output).toContain(
        "let present = [self.1.is_some(), !self.2.is_empty()];",
    );
    expect(output).toContain(
        'formatter.write_str("an array of at least 1 element")',
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
        "pub struct TopLevel(pub i64, pub Option<Option<String>>);",
    );
});

test("a recursive rest needs no Box", async () => {
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
    expect(output).toContain(
        "pub struct TopLevel(pub String, pub Vec<TopLevel>);",
    );
});

test("unions name their variant after the tuple struct", async () => {
    const output = await renderSchema({
        oneOf: [
            { type: "string" },
            {
                title: "Tagged",
                type: "array",
                prefixItems: [{ type: "string" }],
                items: { type: "integer" },
            },
        ],
    });
    expect(output).toContain("    Tagged(Tagged),");
    expect(output).toContain("pub struct Tagged(pub String, pub Vec<i64>);");
});

test("renderer options apply to the tuple structs", async () => {
    const quiet = await renderSchema(slotRanges, {
        visibility: "private",
        "derive-debug": false,
        "derive-clone": false,
    });
    expect(quiet).toContain(
        "pub type TopLevel = Vec<SlotRange>;\n\npub struct SlotRange(i64, i64, SlotNode, Vec<SlotNode>);",
    );

    const crate = await renderSchema(slotRanges, {
        visibility: "crate",
        "derive-partial-eq": true,
    });
    expect(crate).toContain(
        "#[derive(Debug, Clone, PartialEq)]\npub struct SlotRange(pub(crate) i64, pub(crate) i64, pub(crate) SlotNode, pub(crate) Vec<SlotNode>);",
    );
});
