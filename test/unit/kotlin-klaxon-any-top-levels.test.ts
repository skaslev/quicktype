// A top-level `any` (Redis EVAL's reply) is a `data class TopLevel(val
// value: Any?)` with Klaxon, whose `toJson` passed the `Any?` to
// `klaxon.toJsonString(Any)`, which doesn't compile.  Parsing it with
// `parseArray<Any?>` threw on null and made objects bare `Object`s, and
// `toJsonString` can't write Klaxon's own `JsonObject`s and `JsonArray`s.
// The value is now whatever Klaxon parses, and is written back by kind.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { expect, test } from "vitest";

async function renderKlaxon(schema: object): Promise<string> {
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
        rendererOptions: { framework: "klaxon" },
    });
    return result.lines.join("\n");
}

const toJson = [
    "    public fun toJson() = when (value) {",
    '        null -> "null"',
    "        is JsonBase -> value.toJsonString()",
    "        else -> klaxon.toJsonString(value)",
    "    }",
].join("\n");

const parse = 'klaxon.parseJsonArray(java.io.StringReader("[${json}]"))[0]';

test("a top-level any", async () => {
    const output = await renderKlaxon({ description: "any reply" });
    expect(output).toContain("data class TopLevel(val value: Any?) {");
    expect(output).toContain(toJson);
    expect(output).toContain(
        `public fun fromJson(json: String) = TopLevel(${parse})`,
    );
});

test("a top-level null", async () => {
    const output = await renderKlaxon({ type: "null" });
    expect(output).toContain(toJson);
    expect(output).toContain(
        `public fun fromJson(json: String) = TopLevel(${parse}.also { require(it == null) })`,
    );
});

test("other primitive top-levels are unchanged", async () => {
    const output = await renderKlaxon({ type: "string" });
    expect(output).toContain(
        "public fun toJson() = klaxon.toJsonString(value)",
    );
    expect(output).toContain(
        'public fun fromJson(json: String) = TopLevel(klaxon.parseArray<String>("[${json}]")!![0])',
    );
});
