// Elixir full mode decodes the elements of a top-level array with the
// functions their type has: a class's from_map and to_map, an enum's decode
// and encode, decode_element and encode_element clauses for the other
// elements, none for free-form values.  Elements that are arrays, maps or
// nullable unions made quicktype fail ("Defined value expected"), as it
// looked for their module, e.g. for Redis COMMAND INFO; enums were decoded
// with a from_map they don't have, and free-form values became errors.

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
    const result = await quicktype({ inputData, lang: "elixir" });
    return result.lines.join("\n");
}

// The top-level module.
function topLevel(output: string): string {
    const start = output.indexOf("defmodule TopLevel do");
    if (start < 0) throw new Error("no TopLevel module");
    return output.slice(start);
}

const decodedWith = (f: string): string =>
    [
        "  def from_json(json) do",
        "    json",
        "    |> Jason.decode!()",
        `    |> Enum.map(&${f})`,
        "  end",
    ].join("\n");

const encodedWith = (f: string): string =>
    [
        "  def to_json(list) do",
        `    Enum.map(list, &${f})`,
        "    |> Jason.encode!()",
        "  end",
    ].join("\n");

describe("Elixir top-level arrays", () => {
    test("of arrays", async () => {
        const output = topLevel(
            await render({
                type: "array",
                items: { type: "array", items: { type: "string" } },
            }),
        );
        expect(output).toContain(
            "  def decode_element(value) when is_list(value), do: value",
        );
        expect(output).toContain(decodedWith("decode_element/1"));
        expect(output).toContain(encodedWith("encode_element/1"));
    });

    test("of maps", async () => {
        const output = topLevel(
            await render({
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: { type: "integer" },
                },
            }),
        );
        expect(output).toContain(
            "  def decode_element(value) when is_map(value), do: value",
        );
        expect(output).toContain(decodedWith("decode_element/1"));
    });

    test("of nullable unions", async () => {
        const output = topLevel(
            await render({
                type: "array",
                items: {
                    oneOf: [
                        { type: "null" },
                        { type: "array", items: { type: "integer" } },
                    ],
                },
            }),
        );
        expect(output).toContain(
            "  def decode_element(value) when is_nil(value), do: value",
        );
        expect(output).toContain(
            "  def decode_element(value) when is_list(value), do: value",
        );
        expect(output).toContain(decodedWith("decode_element/1"));
    });

    test("of enums", async () => {
        const output = topLevel(
            await render({ type: "array", items: { enum: ["a", "b"] } }),
        );
        expect(output).toContain(decodedWith("TopLevelElement.decode/1"));
        expect(output).toContain(encodedWith("TopLevelElement.encode/1"));
    });

    test("of classes", async () => {
        const output = topLevel(
            await render({
                type: "array",
                items: {
                    type: "object",
                    properties: { a: { type: "integer" } },
                },
            }),
        );
        expect(output).toContain(decodedWith("TopLevelElement.from_map/1"));
        expect(output).toContain(encodedWith("TopLevelElement.to_map/1"));
    });

    test("of free-form values", async () => {
        const output = topLevel(await render({ type: "array", items: {} }));
        expect(output).not.toContain("decode_element");
        expect(output).toContain("    Jason.encode!(list)");
    });
});
