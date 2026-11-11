// Kotlin renders a JSON Schema tuple as a data class with a property per
// item, `item0`, `item1`, ... after the item's position, and a final `rest`
// list.  Each framework reads and writes it as a JSON array: Jackson and
// Klaxon with converters like the unions', kotlinx with a KSerializer.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

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
        lang: "kotlin",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const justTypes = { "just-types": true };
const jackson = { framework: "jackson" };
const klaxon = { framework: "klaxon" };
const kotlinx = { framework: "kotlinx" };

function inObject(property: { $defs?: object }): object {
    const { $defs, ...reply } = property;
    return {
        type: "object",
        properties: { reply },
        required: ["reply"],
        $defs,
    };
}

// ZRANGE WITHSCORES: `[member, score]` pairs.
const memberScores = inObject({
    type: "array",
    items: {
        title: "MemberScore",
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: [{ type: "string" }, { type: "number" }],
    },
});

// CLUSTER SLOTS: `[start, end, master, ...replicas]`.
const slotRanges = inObject({
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
    $defs: {
        node: {
            title: "SlotNode",
            type: "array",
            items: [{ type: "string" }, { type: "integer" }],
        },
    },
});

const optionalItems = inObject({
    title: "Pending",
    type: "array",
    minItems: 1,
    items: [
        { type: "string" },
        { type: "integer" },
        { type: ["string", "null"] },
    ],
});

// A top-level class checks the lengths of its arrays.
const pair = inObject({
    title: "Reply",
    type: "array",
    minItems: 2,
    maxItems: 2,
    items: [{ type: "string" }, { type: "number" }],
});

// ZRANK WITHSCORE, next to arrays: a JSON array is one of several types.
const arrayLikes = inObject({
    title: "Reply",
    oneOf: [
        { type: "integer" },
        {
            title: "RankScore",
            type: "array",
            items: [{ type: "integer" }, { type: "number" }],
        },
        {
            title: "Named",
            type: "array",
            minItems: 1,
            items: [{ type: "string" }, { type: "integer" }],
        },
        { type: "array", items: { type: "string" } },
    ],
});

describe("just types", () => {
    test("a tuple is a data class with a property per item", async () => {
        const output = await renderSchema(memberScores, justTypes);
        expect(output).toContain(
            [
                "data class TopLevel (",
                "    val reply: List<MemberScore>",
                ")",
                "",
                "data class MemberScore (",
                "    val item0: String,",
                "    val item1: Double",
                ")",
            ].join("\n"),
        );
        // Not a union of its items.
        expect(output).not.toContain("sealed class");
    });

    test("optional items are null, the rest a final list", async () => {
        expect(await renderSchema(slotRanges, justTypes)).toContain(
            [
                "data class SlotRange (",
                "    val item0: Long,",
                "    val item1: Long,",
                "    val item2: SlotNode,",
                "    val rest: List<SlotNode>",
                ")",
            ].join("\n"),
        );
        // A nullable item that may be missing is held by a class, so that
        // a missing item (null) and a null one (`Item2(null)`) differ.
        expect(await renderSchema(optionalItems, justTypes)).toContain(
            [
                "data class Pending (",
                "    val item0: String,",
                "    val item1: Long? = null,",
                "    val item2: Pending.Item2? = null",
                ") {",
                "    data class Item2(val value: String?)",
                "}",
            ].join("\n"),
        );
    });

    test("tuples are members of unions", async () => {
        const output = await renderSchema(arrayLikes, justTypes);
        expect(output).toMatch(
            /class RankScoreValue\(val value: RankScore\) +: Reply\(\)/,
        );
        expect(output).toMatch(/class NamedValue\(val value: Named\) +:/);
        expect(output).toMatch(
            /class StringArrayValue\(val value: List<String>\) :/,
        );
    });
});

describe("Jackson", () => {
    test("a tuple converts from and to a JSON array", async () => {
        const output = await renderSchema(memberScores, jackson);
        expect(output).toContain(
            "convert(MemberScore::class, { MemberScore.fromJson(it) }, { it.toJson() })",
        );
        expect(output).toContain(
            [
                ") {",
                "    fun toJson(): String = mapper.writeValueAsString(listOf<Any?>(item0, item1))",
                "",
                "    companion object {",
                "        fun fromJson(jn: JsonNode): MemberScore {",
                '            require(jn.isArray && jn.size() == 2) { "Cannot deserialize MemberScore: expected an array of 2 elements" }',
                '            require(jn[0].isTextual) { "Cannot deserialize MemberScore: unexpected ${jn[0].nodeType} for item0" }',
                '            require(jn[1].isNumber) { "Cannot deserialize MemberScore: unexpected ${jn[1].nodeType} for item1" }',
                "            return MemberScore(",
                "                mapper.convertValue(jn[0]),",
                "                mapper.convertValue(jn[1])",
                "            )",
                "        }",
                "    }",
                "}",
            ].join("\n"),
        );
    });

    test("optional items and a rest", async () => {
        const slots = await renderSchema(slotRanges, jackson);
        expect(slots).toContain(
            "fun toJson(): String = mapper.writeValueAsString(listOf<Any?>(item0, item1, item2) + rest)",
        );
        expect(slots).toContain(
            [
                "                jn.drop(3).map {",
                '                    require(it.isArray) { "Cannot deserialize SlotRange: unexpected ${it.nodeType} for an item of the rest" }',
                "                    mapper.convertValue<SlotNode>(it)",
                "                }",
            ].join("\n"),
        );

        const pending = await renderSchema(optionalItems, jackson);
        expect(pending).toContain(
            [
                "        val items = mutableListOf<Any?>(item0)",
                "        if (item1 != null) items.add(item1)",
                "        if (item2 != null) {",
                '            require(item1 != null) { "Cannot serialize Pending: an item follows a missing optional item" }',
                "            items.add(item2.value)",
                "        }",
                "        return mapper.writeValueAsString(items)",
            ].join("\n"),
        );
        expect(pending).toContain(
            '            require(jn.size() <= 2 || jn[2].isNull || jn[2].isTextual) { "Cannot deserialize Pending: unexpected ${jn[2].nodeType} for item2" }',
        );
        expect(pending).toContain(
            [
                "                if (jn.size() > 1) mapper.convertValue(jn[1]) else null,",
                "                if (jn.size() > 2) Pending.Item2(mapper.convertValue<String?>(jn[2])) else null",
            ].join("\n"),
        );
    });

    // Converting the JSON array to the array type would succeed for some
    // tuples too.
    test("a union tries its tuples before the array", async () => {
        const output = await renderSchema(arrayLikes, jackson);
        expect(output).toContain(
            "-> try { RankScoreValue(mapper.convertValue(jn)) } catch (e: Exception) { try { NamedValue(mapper.convertValue(jn)) } catch (e: Exception) { StringArrayValue(mapper.convertValue(jn)) } }",
        );
    });

    // A tuple has no `size`; its `fromJson` checks the length.
    test.each([
        ["jackson", jackson],
        ["klaxon", klaxon],
    ] as const)("%s doesn't check a tuple property's length", async (_, options) => {
        const output = await renderSchema(pair, options);
        expect(output).toContain("val reply: Reply");
        expect(output).not.toContain("reply.size");
    });
});

describe("Klaxon", () => {
    test("a tuple converts from the values Klaxon parsed", async () => {
        const output = await renderSchema(slotRanges, klaxon);
        expect(output).toContain(
            ".convert(SlotRange::class, { SlotRange.fromJson(it) }, { it.toJson() })",
        );
        expect(output).toContain(
            'public fun toJson(): String = (listOf<Any?>(item0, item1, item2) + rest).joinToString(",", "[", "]") { if (it == null) "null" else klaxon.toJsonString(it) }',
        );
        expect(output).toContain(
            [
                "            val a = jv.array",
                '            require(a != null && a.size >= 3) { "Cannot deserialize SlotRange: expected an array of at least 3 elements" }',
                "            return SlotRange(",
                '                ((a[0] as? Int)?.toLong() ?: (a[0] as? Long) ?: throw IllegalArgumentException("Cannot deserialize SlotRange: unexpected ${a[0]} for item0")),',
            ].join("\n"),
        );
        expect(output).toContain(
            '                ((a[2] as? JsonArray<*>)?.let { SlotNode.fromJson(JsonValue(it, null, null, klaxon)) } ?: throw IllegalArgumentException("Cannot deserialize SlotRange: unexpected ${a[2]} for item2")),',
        );
        expect(output).toContain(
            '                (3 until a.size).map { i -> ((a[i] as? JsonArray<*>)?.let { SlotNode.fromJson(JsonValue(it, null, null, klaxon)) } ?: throw IllegalArgumentException("Cannot deserialize SlotRange: unexpected ${a[i]} for an item of the rest")) }',
        );
    });

    // Klaxon's `parseFromJsonObject` can't make maps.
    test("arrays and maps convert element by element", async () => {
        const output = await renderSchema(
            inObject({
                title: "Pair",
                type: "array",
                items: [
                    { type: "array", items: { type: "string" } },
                    {
                        type: "object",
                        additionalProperties: { type: "boolean" },
                    },
                ],
            }),
            klaxon,
        );
        expect(output).toContain(
            '                ((a[0] as? JsonArray<*>)?.map { x0 -> (x0 as? String ?: throw IllegalArgumentException("Cannot deserialize Pair: unexpected ${x0} for item0")) } ?: throw IllegalArgumentException("Cannot deserialize Pair: unexpected ${a[0]} for item0")),',
        );
        expect(output).toContain(
            '                ((a[1] as? JsonObject)?.mapValues { (_, x0) -> (x0 as? Boolean ?: throw IllegalArgumentException("Cannot deserialize Pair: unexpected ${x0} for item1")) } ?: throw IllegalArgumentException("Cannot deserialize Pair: unexpected ${a[1]} for item1"))',
        );
    });

    test("a top-level tuple parses a string", async () => {
        const output = await renderSchema(
            { type: "array", items: [{ type: "string" }, { type: "integer" }] },
            klaxon,
        );
        expect(output).toContain(
            "public fun fromJson(json: String): TopLevel = fromJson(JsonValue(Parser().parse(StringBuilder(json)), null, null, klaxon))",
        );
    });

    test("a union tries its tuples before the array", async () => {
        const output = await renderSchema(arrayLikes, klaxon);
        expect(output).toContain(
            "is JsonArray<*> -> try { RankScoreValue(jv.array?.let { RankScore.fromJson(jv) }!!) } catch (e: Exception) { try { NamedValue(jv.array?.let { Named.fromJson(jv) }!!) } catch (e: Exception) { StringArrayValue(jv.array?.let { klaxon.parseFromJsonArray<String>(it) }!!) } }",
        );
    });
});

describe("kotlinx", () => {
    test("a tuple has a list serializer", async () => {
        const output = await renderSchema(slotRanges, kotlinx);
        expect(output).toContain("import kotlinx.serialization.builtins.*");
        expect(output).toContain(
            [
                "@Serializable(with = SlotRange.Serializer::class)",
                "data class SlotRange (",
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "    object Serializer : KSerializer<SlotRange> {",
                "        @OptIn(ExperimentalSerializationApi::class)",
                "        override val descriptor: SerialDescriptor = listSerialDescriptor(JsonElement.serializer().descriptor)",
                "",
                "        override fun deserialize(decoder: Decoder): SlotRange = decoder.decodeStructure(descriptor) {",
                "            var item0: Long? = null",
                "            var item1: Long? = null",
                "            var item2: SlotNode? = null",
                "            val rest = mutableListOf<SlotNode>()",
                "            var size = 0",
                "            while (true) {",
                "                when (val index = decodeElementIndex(descriptor)) {",
                "                    CompositeDecoder.DECODE_DONE -> break",
                "                    0 -> item0 = decodeSerializableElement(descriptor, 0, Long.serializer())",
                "                    1 -> item1 = decodeSerializableElement(descriptor, 1, Long.serializer())",
                "                    2 -> item2 = decodeSerializableElement(descriptor, 2, SlotNode.Serializer)",
                "                    else -> rest.add(decodeSerializableElement(descriptor, index, SlotNode.Serializer))",
                "                }",
                "                size++",
                "            }",
                '            if (size < 3) throw SerializationException("Cannot deserialize SlotRange: expected an array of at least 3 elements")',
            ].join("\n"),
        );
        expect(output).toContain(
            [
                "            encoder.encodeCollection(descriptor, 3 + value.rest.size) {",
                "                encodeSerializableElement(descriptor, 0, Long.serializer(), value.item0)",
                "                encodeSerializableElement(descriptor, 1, Long.serializer(), value.item1)",
                "                encodeSerializableElement(descriptor, 2, SlotNode.Serializer, value.item2)",
                "                value.rest.forEachIndexed { i, item -> encodeSerializableElement(descriptor, 3 + i, SlotNode.Serializer, item) }",
                "            }",
            ].join("\n"),
        );
    });

    test("extra items of a tuple without a rest are an error", async () => {
        const output = await renderSchema(optionalItems, kotlinx);
        expect(output).toContain(
            [
                "                    2 -> item2 = Pending.Item2(decodeSerializableElement(descriptor, 2, String.serializer().nullable))",
                '                    else -> throw SerializationException("Cannot deserialize Pending: expected an array of 1 to 3 elements")',
            ].join("\n"),
        );
        expect(output).toContain(
            '            if (value.item2 != null && value.item1 == null) throw SerializationException("Cannot serialize Pending: an item follows a missing optional item")',
        );
    });
});

// A top-level array of nullable tuples, like COMMAND INFO's
// `List<CommandInfo?>`: Klaxon reads its elements one by one, and a tuple
// element through the tuple's own `fromJson`.
test("Klaxon reads a top-level array of nullable tuples element by element", async () => {
    const output = await renderSchema(
        {
            type: "array",
            items: {
                oneOf: [
                    { type: "null" },
                    {
                        type: "array",
                        items: [{ type: "string" }, { type: "integer" }],
                        minItems: 2,
                        maxItems: 2,
                    },
                ],
            },
        },
        klaxon,
    );
    expect(output).toContain(
        "public fun fromJson(json: String) = TopLevel(klaxon.parseJsonArray(java.io.StringReader(json)).map { x0 -> (if (x0 == null) null else TopLevelTuple.fromJson(JsonValue(x0, null, null, klaxon))) })",
    );
});
