// The C# converters for constrained values (string lengths, number
// ranges) are for the non-null type.  An array item that is nullable is
// decoded by calling the item's converter directly, which must be passed
// the converter's type: `typeof(string?)` doesn't compile (CS8639).

import { describe, expect, test } from "vitest";

import {
    InputData,
    JSONSchemaInput,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";

async function renderCSharp(
    schema: object,
    framework: "NewtonSoft" | "SystemTextJson",
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
        lang: "csharp",
        rendererOptions: { framework },
    });
    return result.lines.join("\n");
}

function arrayOf(items: object): object {
    return {
        type: "object",
        properties: { items: { type: "array", items } },
        required: ["items"],
    };
}

const readCall = {
    NewtonSoft:
        /converter\.ReadJson\(reader, typeof\(([^)]*)\), null, serializer\)/g,
    SystemTextJson:
        /converter\.Read\(ref reader, typeof\(([^)]*)\), options\)/g,
};

describe("C# converters of nullable array items", () => {
    for (const framework of ["NewtonSoft", "SystemTextJson"] as const) {
        for (const [what, items, csType] of [
            ["maxLength", { type: ["string", "null"], maxLength: 5 }, "string"],
            ["minLength", { type: ["string", "null"], minLength: 2 }, "string"],
            [
                "minimum/maximum integers",
                { type: ["integer", "null"], minimum: 0, maximum: 10 },
                "long",
            ],
            [
                "minimum/maximum numbers",
                { type: ["number", "null"], minimum: 0, maximum: 10 },
                "double",
            ],
        ] as const) {
            test(`${framework}, ${what}: typeof gets the non-null type`, async () => {
                const output = await renderCSharp(arrayOf(items), framework);
                const types = [...output.matchAll(readCall[framework])].map(
                    (m) => m[1],
                );
                expect(types).toEqual([csType]);
                expect(output).toContain(`(${csType}?)converter.Read`);
            });
        }
    }
});

// Json.NET calls a property's converter for null too, and the converter
// of an array of converted items calls the items' converter for every
// item, null or not.  The converters of reference types (strings with
// length bounds, arrays of converted items) have to read and write null
// like those of value types do.
describe("C# Json.NET converters of reference types", () => {
    test("read and write null", async () => {
        const output = await renderCSharp(
            {
                type: "object",
                properties: {
                    name: { type: ["string", "null"], maxLength: 5 },
                    names: {
                        type: ["array", "null"],
                        items: { type: ["string", "null"], minLength: 1 },
                    },
                    count: { type: ["integer", "null"], maximum: 10 },
                },
                required: ["name", "names", "count"],
            },
            "NewtonSoft",
        );
        const converters = output
            .split(/\n(?= {4}internal class )/)
            .filter((c) => /^ {4}internal class \w+Converter\b/.test(c));
        expect(converters.map((c) => c.split("\n")[0].trim())).toEqual([
            "internal class MinMaxValueCheckConverter : JsonConverter",
            "internal class PurpleMinMaxLengthCheckConverter : JsonConverter",
            "internal class DecodeArrayConverter : JsonConverter",
            "internal class FluffyMinMaxLengthCheckConverter : JsonConverter",
        ]);
        for (const converter of converters) {
            expect(converter).toContain(
                "if (reader.TokenType == JsonToken.Null) return null;",
            );
            expect(converter).toMatch(
                /if \(untypedValue == null\)\s*\{\s*serializer\.Serialize\(writer, null\);\s*return;/,
            );
        }
    });
});
