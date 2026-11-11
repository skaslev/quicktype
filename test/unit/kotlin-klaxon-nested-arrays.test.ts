// Klaxon's `parseArray<T>` only knows the class of `T`, so a top-level
// array of arrays (COMMAND INFO's `List<List<PurpleCommandInfo>?>`) threw a
// TypeCastException for arrays of classes or unions, or left the elements
// unconverted; it also throws on null elements, and `toJsonString` leaves
// nulls out of lists.  Such top-levels now convert their elements one by
// one, from the `JsonArray` Klaxon parses, and write them one by one.

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

const foo = {
    type: "object",
    properties: { x: { type: "integer" } },
    required: ["x"],
    additionalProperties: false,
};

const parse = (elements: string): string =>
    `public fun fromJson(json: String) = TopLevel(klaxon.parseJsonArray(java.io.StringReader(json)).map { x0 -> ${elements} })`;

test("an array of nullable arrays of unions, like COMMAND INFO's", async () => {
    const output = await renderKlaxon({
        type: "array",
        items: {
            anyOf: [
                { type: "null" },
                {
                    type: "array",
                    items: { anyOf: [{ type: "string" }, { type: "integer" }] },
                },
            ],
        },
    });
    expect(output).toContain(
        "class TopLevel(elements: Collection<List<TopLevelElement>?>) : ArrayList<List<TopLevelElement>?>(elements) {",
    );
    expect(output).toContain(
        parse(
            "(if (x0 == null) null else (x0 as JsonArray<*>).map { x1 -> TopLevelElement.fromJson(JsonValue(x1, null, null, klaxon)) })",
        ),
    );
    expect(output).toContain(
        'public fun toJson() = this.joinToString(",", "[", "]") { x0 -> (if (x0 == null) "null" else x0.joinToString(",", "[", "]") { x1 -> klaxon.toJsonString(x1) }) }',
    );
    expect(output).not.toContain("parseArray");
});

test("arrays of arrays of classes, three deep", async () => {
    const output = await renderKlaxon({
        type: "array",
        items: {
            type: "array",
            items: { type: "array", items: { $ref: "#/definitions/foo" } },
        },
        definitions: { foo },
    });
    expect(output).toContain(
        parse(
            "(x0 as JsonArray<*>).map { x1 -> (x1 as JsonArray<*>).map { x2 -> klaxon.parseFromJsonObject<Foo>(x2 as JsonObject)!! } }",
        ),
    );
});

test.each([
    [
        "nullable classes",
        { anyOf: [{ type: "null" }, { $ref: "#/definitions/foo" }] },
        "(if (x0 == null) null else klaxon.parseFromJsonObject<Foo>(x0 as JsonObject)!!)",
        '(if (x0 == null) "null" else klaxon.toJsonString(x0))',
    ],
    [
        "nullable integers",
        { type: ["integer", "null"] },
        "(if (x0 == null) null else ((x0 as? Int)?.toLong() ?: x0 as Long))",
        '(if (x0 == null) "null" else klaxon.toJsonString(x0))',
    ],
    [
        "maps",
        { type: "object", additionalProperties: { type: "string" } },
        "(x0 as JsonObject).mapValues { (_, x1) -> (x1 as String) }",
        'x0.entries.joinToString(",", "{", "}") { (k, x1) -> klaxon.toJsonString(k) + ":" + klaxon.toJsonString(x1) }',
    ],
    [
        "any values",
        {},
        "x0",
        '(when (x0) { null -> "null"; is JsonBase -> x0.toJsonString(); else -> klaxon.toJsonString(x0) })',
    ],
])("an array of %s", async (_, items, element, json) => {
    const output = await renderKlaxon({
        type: "array",
        items,
        definitions: { foo },
    });
    expect(output).toContain(parse(element));
    expect(output).toContain(
        `public fun toJson() = this.joinToString(",", "[", "]") { x0 -> ${json} }`,
    );
});

test("arrays Klaxon makes itself are parsed as before", async () => {
    const output = await renderKlaxon({
        type: "array",
        items: { $ref: "#/definitions/foo" },
        definitions: { foo },
    });
    expect(output).toContain(
        "public fun fromJson(json: String) = TopLevel(klaxon.parseArray<Foo>(json)!!)",
    );
    expect(output).toContain("public fun toJson() = klaxon.toJsonString(this)");
});
