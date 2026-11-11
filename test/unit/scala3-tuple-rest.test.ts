// A Scala tuple has exactly one element per item, so tuples with optional
// items or a rest become case classes with an `Option` field per optional
// item and a final `Seq` for the rest.  circe and upickle would read and
// write a case class as a JSON object, so they get codecs that read and
// write a JSON array.

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

test("a rest becomes a final Seq", async () => {
    const output = await renderSchema(slotRanges, { "just-types": true });
    expect(output).toContain("type TopLevel = List[SlotRange]");
    expect(output).toContain(
        "case class SlotRange(item0: Long, item1: Long, item2: SlotNode, rest: Seq[SlotNode])",
    );
    // The title is the tuple's, not the name of a union of its items.
    expect(output).not.toContain("type SlotRange =");
    // Fixed-length tuples are still Scala tuples.
    expect(output).toContain("type SlotNode = (String, Long)");
    expect(output).not.toContain("object SlotRange");
});

test("optional items become Option fields", async () => {
    const output = await renderSchema(geoResults, { "just-types": true });
    expect(output).toContain(
        "case class GeoResult(item0: String, item1: Option[GeoResultElement], item2: Option[GeoResultElement], item3: Option[GeoResultElement])",
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
        "case class TopLevel(item0: Long, item1: Option[Option[String]])",
    );
    expect(output).toContain(
        "item1 <- if n > 1 then c.downN(1).as[Option[String]].map(scala.Some(_)) else scala.Right(scala.None)",
    );
});

test("circe writes the items and the rest as an array", async () => {
    const output = await renderSchema(slotRanges);
    expect(output).toContain(
        [
            "object SlotRange:",
            "    given Encoder[SlotRange] = Encoder.instance { t =>",
            "        Json.fromValues(List(Encoder[Long].apply(t.item0), Encoder[Long].apply(t.item1), Encoder[SlotNode].apply(t.item2)) ++ t.rest.map(Encoder[SlotNode].apply))",
            "    }",
        ].join("\n"),
    );
});

test("circe checks the length and reads each item", async () => {
    const output = await renderSchema(slotRanges);
    expect(output).toContain(
        [
            "    given Decoder[SlotRange] = Decoder.instance { c =>",
            "        c.values.map(_.size) match",
            "            case scala.Some(n) if n >= 3 =>",
            "                for",
            "                    item0 <- c.downN(0).as[Long]",
            "                    item1 <- c.downN(1).as[Long]",
            "                    item2 <- c.downN(2).as[SlotNode]",
            "                    rest <- c.withFocus(_.mapArray(_.drop(3))).as[Seq[SlotNode]]",
            "                yield SlotRange(item0, item1, item2, rest)",
            '            case _ => scala.Left(io.circe.DecodingFailure("SlotRange: expected an array of at least 3 elements", c.history))',
            "    }",
        ].join("\n"),
    );
});

test("circe rejects an item after a missing one", async () => {
    const output = await renderSchema(geoResults);
    expect(output).toContain(
        [
            "    given Encoder[GeoResult] = Encoder.instance { t =>",
            "        if List(t.item1.nonEmpty, t.item2.nonEmpty, t.item3.nonEmpty).dropWhile(identity).contains(true) then",
            '            throw new java.lang.IllegalArgumentException("GeoResult: an item follows a missing optional item")',
            "        Json.fromValues(List(Encoder[String].apply(t.item0)) ++ t.item1.map(Encoder[GeoResultElement].apply) ++ t.item2.map(Encoder[GeoResultElement].apply) ++ t.item3.map(Encoder[GeoResultElement].apply))",
        ].join("\n"),
    );
    expect(output).toContain("case scala.Some(n) if n >= 1 && n <= 4 =>");
    expect(output).toContain(
        "item3 <- if n > 3 then c.downN(3).as[GeoResultElement].map(scala.Some(_)) else scala.Right(scala.None)",
    );
    expect(output).toContain(
        '"GeoResult: expected an array of 1 to 4 elements"',
    );
});

test("upickle reads and writes an array", async () => {
    const output = await renderSchema(slotRanges, { framework: "upickle" });
    expect(output).toContain(
        [
            "object SlotRange:",
            "    given OptionPickler.ReadWriter[SlotRange] = OptionPickler.readwriter[ujson.Value].bimap[SlotRange](",
            "        t => ujson.Arr.from(List(OptionPickler.writeJs[Long](t.item0), OptionPickler.writeJs[Long](t.item1), OptionPickler.writeJs[SlotNode](t.item2)) ++ t.rest.map(OptionPickler.writeJs[SlotNode](_))),",
            "        json => json match",
            "            case ujson.Arr(xs) if xs.length >= 3 =>",
            "                SlotRange(",
            "                    OptionPickler.read[Long](xs(0))(using JsonExt.strictLong),",
            "                    OptionPickler.read[Long](xs(1))(using JsonExt.strictLong),",
            '                    OptionPickler.read[Option[SlotNode]](xs(2)).getOrElse(throw new upickle.core.Abort("SlotRange: unexpected null")),',
            '                    xs.drop(3).map(x => OptionPickler.read[Option[SlotNode]](x).getOrElse(throw new upickle.core.Abort("SlotRange: unexpected null"))).toSeq',
            "                )",
            '            case _ => throw new upickle.core.Abort("SlotRange: expected an array of at least 3 elements")',
            "    )",
        ].join("\n"),
    );
});

// upickle's readers of primitives read other primitives, and those of
// classes, arrays and tuples read null.
test("upickle reads items strictly", async () => {
    const output = await renderSchema(
        {
            type: "array",
            minItems: 1,
            items: [
                { type: "boolean" },
                { oneOf: [{ type: "string" }, { type: "null" }] },
                { type: "array", items: { type: "number" } },
            ],
        },
        { framework: "upickle" },
    );
    expect(output).toContain(
        "OptionPickler.read[Boolean](xs(0))(using JsonExt.strictBoolean),",
    );
    expect(output).toContain(
        "if xs.length > 1 then scala.Some(OptionPickler.read[Option[String]](xs(1))(using OptionPickler.OptionReader(using JsonExt.strictString))) else scala.None,",
    );
    expect(output).toContain(
        'if xs.length > 2 then scala.Some(OptionPickler.read[Option[Seq[Double]]](xs(2)).getOrElse(throw new upickle.core.Abort("TopLevel: unexpected null"))) else scala.None',
    );
    expect(output).toContain(
        "if List(t.item1.nonEmpty, t.item2.nonEmpty).dropWhile(identity).contains(true) then",
    );
});

test("a bounded rest becomes optional items", async () => {
    const output = await renderSchema({
        type: "array",
        prefixItems: [{ type: "string" }],
        items: { type: "integer" },
        maxItems: 3,
    });
    expect(output).toContain(
        "case class TopLevel(item0: String, item1: Option[Long], item2: Option[Long])",
    );
    expect(output).toContain("case scala.Some(n) if n >= 1 && n <= 3 =>");
});

test("a recursive rest needs no other declaration", async () => {
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
        "case class TopLevel(item0: String, rest: Seq[TopLevel])",
    );
});

// A type alias can refer to itself through a case class.
test("a fixed-length tuple containing itself through one stays an alias", async () => {
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
    expect(output).toContain("type TopLevel = (String, Chain)");
    expect(output).toContain(
        "case class Chain(item0: Long, rest: Seq[TopLevel])",
    );
});

const unionOfTuples = {
    type: "array",
    items: {
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
    },
};

// A tuple's decoder accepts only its lengths, an array's any length.
test("circe tries fixed-length tuples, then optional items, then a rest, then arrays", async () => {
    const output = await renderSchema(unionOfTuples);
    expect(output).toMatch(
        /Decoder\[\(Long, Long\)\]\.widen,\s+Decoder\[Flag\]\.widen,\s+Decoder\[Tagged\]\.widen,\s+Decoder\[Seq\[Long\]\]\.widen,/,
    );
    expect(output).toContain(
        "case enc3 : Tagged => Encoder[Tagged].apply(enc3)",
    );
});

test("upickle tries fixed-length tuples, then optional items, then a rest, then arrays", async () => {
    const output = await renderSchema(unionOfTuples, { framework: "upickle" });
    expect(output).toMatch(
        /summon\[OptionPickler\.Reader\[\(Long, Long\)\]\],\s+summon\[OptionPickler\.Reader\[Flag\]\],\s+summon\[OptionPickler\.Reader\[Tagged\]\],\s+summon\[OptionPickler\.Reader\[Seq\[Long\]\]\],/,
    );
});
