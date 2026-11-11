// Elm full-mode output: top-level enums and unions expose their
// constructors, and records that contain themselves are custom types.

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

// A record that contains itself.
function recursive(properties: object, required: string[] = []): object {
    return {
        $ref: "#/definitions/TopLevel",
        definitions: {
            TopLevel: {
                type: "object",
                properties,
                required,
                additionalProperties: false,
            },
        },
    };
}

const node = recursive(
    {
        name: { type: "string" },
        children: {
            type: "array",
            items: { $ref: "#/definitions/TopLevel" },
        },
    },
    ["name"],
);

describe("Elm records that contain themselves", () => {
    test("are custom types wrapping the record", async () => {
        const output = await render(node);
        expect(output).toContain(
            [
                "type TopLevel =",
                "    TopLevel",
                "        { children : Maybe (List TopLevel)",
                "        , name : String",
                "        }",
            ].join("\n"),
        );
        expect(output).not.toContain("type alias TopLevel");
        expect(exposed(output)).toEqual([
            "TopLevel(..)",
            "topLevelToString",
            "topLevel",
        ]);
    });

    test("decode lazily into the custom type", async () => {
        const output = await render(node);
        expect(output).toContain(
            [
                "topLevel =",
                "    Jdec.succeed (\\x0 x1 -> TopLevel { children = x0, name = x1 })",
                '        |> Jpipe.custom (optionalField "children" (Jdec.lazy (\\_ -> Jdec.map Just (Jdec.list topLevel ))) Nothing)',
                '        |> Jpipe.required "name" Jdec.string',
            ].join("\n"),
        );
        expect(output).toContain("encodeTopLevel (TopLevel x) =");
    });

    test("in mutual recursion, both are custom types", async () => {
        const output = await render({
            $ref: "#/definitions/A",
            definitions: {
                A: {
                    type: "object",
                    properties: { b: { $ref: "#/definitions/B" } },
                },
                B: {
                    type: "object",
                    properties: {
                        a: {
                            type: "array",
                            items: { $ref: "#/definitions/A" },
                        },
                    },
                },
            },
        });
        expect(output).toMatch(/^type TopLevel =\n {4}TopLevel\n/m);
        expect(output).toMatch(/^type B =\n {4}B\n/m);
        expect(exposed(output)).toEqual([
            "TopLevel(..)",
            "topLevelToString",
            "topLevel",
            "B(..)",
        ]);
    });

    test("through a union, stay type aliases but decode lazily", async () => {
        // The union is a custom type, which breaks the cycle of types, but
        // the decoders still refer to each other.
        const output = await render(
            recursive({
                next: {
                    oneOf: [
                        { $ref: "#/definitions/TopLevel" },
                        { type: "string" },
                    ],
                },
            }),
        );
        expect(output).toContain("type alias TopLevel =");
        expect(output).toContain("type Next\n    = StringInNext String");
        expect(output).toContain(
            '|> Jpipe.custom (optionalField "next" (Jdec.lazy (\\_ -> Jdec.map Just next)) Nothing)',
        );
    });

    test("don't take the decoder parameters' names", async () => {
        const output = await render(
            recursive({
                x0: {
                    type: "object",
                    properties: { a: { type: "integer" } },
                },
                children: {
                    type: "array",
                    items: { $ref: "#/definitions/TopLevel" },
                },
            }),
        );
        expect(output).toContain("(\\x0 x1 -> TopLevel {");
        expect(output).not.toMatch(/^x0 /m);
        expect(output).not.toMatch(/^x1 /m);
    });
});
