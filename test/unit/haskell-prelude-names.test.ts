// The Haskell output imports Prelude implicitly, and Data.ByteString.Lazy
// (ByteString) and Data.Vector (Vector) unqualified, so a type named after
// one of their types, classes or constructors made every use of the name
// ambiguous ("Ambiguous occurrence 'Show'"), e.g. `data Show = Show` for a
// property `show`, which also broke `deriving (Show)`, or `data Just`,
// which broke the encoders' `Just $ ...`.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function render(
    schema: object,
    rendererOptions: Record<string, string> = {},
): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({
        inputData,
        lang: "haskell",
        rendererOptions,
    });
    return result.lines.join("\n");
}

// Names that clashed, each checked with GHC 9.6.
const names = [
    "Applicative",
    "Bounded",
    "ByteString",
    "Either",
    "Eq",
    "FilePath",
    "Floating",
    "Foldable",
    "Fractional",
    "Functor",
    "IOError",
    "Integer",
    "Integral",
    "Just",
    "Monad",
    "MonadFail",
    "Monoid",
    "Nothing",
    "Num",
    "Ord",
    "Ordering",
    "Rational",
    "Read",
    "ReadS",
    "Real",
    "RealFloat",
    "RealFrac",
    "Semigroup",
    "Show",
    "ShowS",
    "Traversable",
    "Vector",
    "Word",
];

describe("Haskell types", () => {
    test("aren't named after what Prelude and the imports export", async () => {
        const properties = Object.fromEntries(
            names.map((name) => [
                name.toLowerCase(),
                {
                    title: name,
                    type: "object",
                    properties: { a: { type: "integer" } },
                },
            ]),
        );
        const output = await render(
            { type: "object", properties },
            { "array-type": "array" },
        );
        const declared = Array.from(
            output.matchAll(/^data (\w+)/gm),
            (m) => m[1],
        );
        expect(declared).toHaveLength(names.length + 1);
        for (const name of names) {
            expect(declared).not.toContain(name);
        }
    });

    test("for properties named just and nothing", async () => {
        const output = await render({
            type: "object",
            properties: {
                just: {
                    type: "object",
                    properties: { a: { type: "integer" } },
                },
                nothing: { type: "string" },
            },
            required: ["just"],
        });
        expect(output).toContain("data JustClass = JustClass");
        expect(output).toContain('Just $ "just" .= justTopLevel');
    });
});
