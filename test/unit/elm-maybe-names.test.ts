// Elm output uses `Just`, `Nothing` and `Bool` from Elm's default imports,
// so no type or enum case may take those names: a module's own definitions
// take the place of the imported ones.  Redis SENTINEL CONFIG's log level
// `nothing` was an enum case `Nothing`, and every `Nothing` meant for a
// `Maybe` became a log level.

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
    const result = await quicktype({ inputData, lang: "elm" });
    return result.lines.join("\n");
}

// The names the module defines: types and constructors.
function definedNames(output: string): string[] {
    return Array.from(
        output.matchAll(/^(?:type(?: alias)? (\w+)| {4}[=|] (\w+))/gm),
        (m) => m[1] ?? m[2],
    );
}

describe("Elm names from the default imports", () => {
    test("aren't enum cases", async () => {
        const output = await render({
            type: "object",
            properties: {
                loglevel: { enum: ["debug", "nothing", "just", "bool"] },
                user: { type: "string" },
            },
            required: ["loglevel"],
        });
        const names = definedNames(output);
        expect(names).not.toContain("Nothing");
        expect(names).not.toContain("Just");
        expect(names).not.toContain("Bool");
        expect(names).toContain("LoglevelNothing");
        expect(output).toContain(
            '|> Jpipe.custom (optionalField "user" (Jdec.map Just Jdec.string) Nothing)',
        );
    });

    test("aren't types", async () => {
        const output = await render({
            type: "object",
            properties: {
                bool: {
                    type: "object",
                    properties: { a: { type: "boolean" } },
                },
                just: {
                    type: "object",
                    properties: { a: { type: "integer" } },
                },
                nothing: {
                    type: "object",
                    properties: { a: { type: "string" } },
                },
            },
        });
        const names = definedNames(output);
        expect(names).not.toContain("Nothing");
        expect(names).not.toContain("Just");
        expect(names).not.toContain("Bool");
        expect(output).toContain("{ a : Maybe Bool\n");
    });
});
