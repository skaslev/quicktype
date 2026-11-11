// Dart checks the length of an array with `minItems`/`maxItems` in a
// closure.  The list it checks is the closure's argument: as a local of the
// closure's body, `final x = List<int>.from(x.map(...))`, it would hide the
// `x` of an outer list's `map` that its initializer reads, which doesn't
// compile (arrays of constrained arrays, such as Redis HOTKEYS GET's slot
// ranges).

import { describe, expect, test } from "vitest";

import {
    InputData,
    JSONSchemaInput,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";

async function renderSchema(schema: object): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({ inputData, lang: "dart" });
    return result.lines.join("\n");
}

const slotRange = {
    type: "array",
    items: { type: "integer" },
    minItems: 1,
    maxItems: 2,
};

describe("Dart array length checks", () => {
    test("an array of constrained arrays checks each item", async () => {
        const output = await renderSchema({
            type: "object",
            properties: { slots: { type: "array", items: slotRange } },
            required: ["slots"],
            additionalProperties: false,
        });
        expect(output).toContain(
            `slots: List<List<int>>.from(json["slots"].map((x) => ((List<int> x) { if (x.length < 1 || x.length > 2) throw FormatException('Invalid array length'); return x; })(List<int>.from(x.map((x) => x))))),`,
        );
        expect(output).not.toContain("final x =");
    });

    test("nested constrained arrays and their nullable items", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                grid: { type: "array", minItems: 1, items: slotRange },
                maybe: {
                    type: "array",
                    items: {
                        type: ["array", "null"],
                        minItems: 2,
                        items: { type: "string" },
                    },
                },
            },
            required: ["grid"],
            additionalProperties: false,
        });
        expect(output).toContain(
            `grid: ((List<List<int>> x) { if (x.length < 1) throw FormatException('Invalid array length'); return x; })(List<List<int>>.from(json["grid"].map((x) => ((List<int> x) { if (x.length < 1 || x.length > 2) throw FormatException('Invalid array length'); return x; })(List<int>.from(x.map((x) => x)))))),`,
        );
        expect(output).toContain(
            `maybe: json["maybe"] == null ? null : List<List<String>?>.from(json["maybe"]!.map((x) => x == null ? null : ((List<String> x) { if (x.length < 2) throw FormatException('Invalid array length'); return x; })(List<String>.from(x!.map((x) => x))))),`,
        );
    });

    test("a top-level array of constrained arrays", async () => {
        const output = await renderSchema({
            type: "array",
            maxItems: 2,
            items: { type: "array", minItems: 1, items: { type: "string" } },
        });
        expect(output).toContain(
            "List<List<String>> topLevelFromJson(String str) => ((List<List<String>> x) { if (x.length > 2) throw FormatException('Invalid array length'); return x; })(List<List<String>>.from(json.decode(str).map((x) => ((List<String> x) { if (x.length < 1) throw FormatException('Invalid array length'); return x; })(List<String>.from(x.map((x) => x))))));",
        );
    });
});
