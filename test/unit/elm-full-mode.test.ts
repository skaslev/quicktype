// Elm full-mode output: top-level enums and unions expose their
// constructors.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function render(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({ inputData, lang: "elm", rendererOptions });
    return result.lines.join("\n");
}

// The module's exposing list, one entry per line.
function exposed(output: string): string[] {
    const m = /^module \S+ exposing\n((?: {4}[(,] .*\n)+) {4}\)/m.exec(output);
    if (m === null) throw new Error("no exposing list");
    return m[1]
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.slice(6));
}

describe("Elm top-levels", () => {
    test("a top-level union exposes its constructors", async () => {
        const output = await render({
            oneOf: [{ type: "integer" }, { type: "string" }],
        });
        expect(output).toContain("type TopLevel\n    = IntegerInTopLevel Int");
        expect(exposed(output)).toEqual([
            "TopLevel(..)",
            "topLevelToString",
            "topLevel",
        ]);
    });

    test("a top-level enum exposes its constructors", async () => {
        const output = await render({ enum: ["a", "b"] });
        expect(exposed(output)).toEqual([
            "TopLevel(..)",
            "topLevelToString",
            "topLevel",
        ]);
    });

    test("a top-level record or alias exposes its name only", async () => {
        const record = await render({
            type: "object",
            properties: { a: { type: "integer" } },
        });
        expect(exposed(record)).toEqual([
            "TopLevel",
            "topLevelToString",
            "topLevel",
        ]);

        const list = await render({
            type: "array",
            items: { enum: ["a", "b"] },
        });
        expect(exposed(list)).toEqual([
            "TopLevel",
            "topLevelToString",
            "topLevel",
            "TopLevelElement(..)",
        ]);
    });
});
