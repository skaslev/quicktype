// circe and upickle (de)serialize Scala tuples as JSON arrays of exactly
// their length, so Scala 3 keeps fixed-length tuples.  Other tuple shapes
// are case classes with codecs of their own, see scala3-tuple-rest.test.ts.

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
        lang: "scala3",
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

const recursive = {
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
};

test.each([
    [
        "fixed length",
        { type: "array", items: pair },
        "type TopLevel = List[(String, Double)]",
    ],
    [
        "one element",
        {
            type: "array",
            items: { type: "array", items: [{ type: "string" }] },
        },
        "type TopLevel = List[Tuple1[String]]",
    ],
    ["a top-level tuple", pair, "type TopLevel = (String, Double)"],
    [
        "rest elements become a case class",
        {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "integer" },
        },
        "case class TopLevel(item0: String, rest: Seq[Long])",
    ],
] as const)("%s", async (_, schema, expected) => {
    expect(await renderSchema(schema)).toContain(expected);
});

test("a titled tuple becomes a type alias", async () => {
    const output = await renderSchema({
        type: "array",
        items: { ...pair, title: "MemberScore" },
    });
    expect(output).toContain("type TopLevel = List[MemberScore]");
    expect(output).toContain("type MemberScore = (String, Double)");
});

// A type alias can't refer to itself.
test("a recursive tuple becomes a case class with circe codecs", async () => {
    const output = await renderSchema(recursive);
    expect(output).toContain(
        "case class TopLevel(_1: String, _2: Seq[TopLevel])",
    );
    expect(output).toContain(
        "given Encoder[TopLevel] = Encoder.instance(t => (t._1, t._2).asJson)",
    );
    expect(output).toContain(
        "given Decoder[TopLevel] = Decoder.instance(_.as[(String, Seq[TopLevel])].map(t => TopLevel(t._1, t._2)))",
    );
});

test("a recursive tuple becomes a case class with a upickle ReadWriter", async () => {
    const output = await renderSchema(recursive, { framework: "upickle" });
    expect(output).toContain(
        "case class TopLevel(_1: String, _2: Seq[TopLevel])",
    );
    expect(output).toContain(
        "given OptionPickler.ReadWriter[TopLevel] = OptionPickler.readwriter[ujson.Value].bimap[TopLevel](",
    );
    expect(output).toContain("t => OptionPickler.writeJs((t._1, t._2)),");
    expect(output).toContain(
        "json => { val t = OptionPickler.read[(String, Seq[TopLevel])](json); TopLevel(t._1, t._2) }",
    );
});

test("a recursive tuple in just-types mode has no codecs", async () => {
    const output = await renderSchema(recursive, { "just-types": true });
    expect(output).toContain(
        "case class TopLevel(_1: String, _2: Seq[TopLevel])",
    );
    expect(output).not.toContain("object TopLevel");
});

const unionWithTuple = {
    type: "object",
    properties: {
        value: {
            oneOf: [
                { type: "string" },
                { type: "array", items: { type: "integer" } },
                {
                    type: "array",
                    items: [{ type: "integer" }, { type: "integer" }],
                },
            ],
        },
    },
    required: ["value"],
};

test("circe tries a tuple in a union before an array", async () => {
    const output = await renderSchema(unionWithTuple);
    expect(output).toMatch(
        /Decoder\[\(Long, Long\)\]\.widen,\s+Decoder\[Seq\[Long\]\]\.widen,/,
    );
    expect(output).toContain(
        "case enc1 : (Long, Long) => Encoder[(Long, Long)].apply(enc1)",
    );
});

test("upickle tries a tuple in a union before an array", async () => {
    const output = await renderSchema(unionWithTuple, {
        framework: "upickle",
    });
    expect(output).toMatch(
        /summon\[OptionPickler\.Reader\[\(Long, Long\)\]\],\s+summon\[OptionPickler\.Reader\[Seq\[Long\]\]\],/,
    );
});
