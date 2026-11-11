// With --wstring use-wstring, the Utf16_Utf8 helper converts between the
// narrow strings of the JSON and the wide strings of the C++ types, through
// containers.  Its conversion of optionals was only emitted when there were
// optional properties, so a required nullable string
// (std::optional<std::wstring>) didn't compile without one.

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
    const result = await quicktype({
        inputData,
        lang: "cplusplus",
        rendererOptions: { wstring: "use-wstring", ...rendererOptions },
    });
    return result.lines.join("\n");
}

function nullable(items: object): object {
    return {
        type: "object",
        properties: { name: items },
        required: ["name"],
        additionalProperties: false,
    };
}

const optionalConversion = (optional: string): string =>
    `static toType convert(tag<${optional}<TF> >, tag<${optional}<TT> >, fromType opt)`;

describe("C++ wide strings in optionals", () => {
    test.each([
        ["a nullable string", { type: ["string", "null"] }],
        [
            "an array of nullable strings",
            { type: "array", items: { type: ["string", "null"] } },
        ],
    ])("are converted for %s without optional properties", async (_, items) => {
        const output = await render(nullable(items));
        expect(output).toContain("std::optional<std::wstring>");
        expect(output).toContain(optionalConversion("std::optional"));
    });

    test("are converted with Boost", async () => {
        const output = await render(nullable({ type: ["string", "null"] }), {
            boost: true,
        });
        expect(output).toContain("boost::optional<std::wstring> name;");
        expect(output).toContain(optionalConversion("boost::optional"));
    });

    test("aren't converted without optionals", async () => {
        const output = await render(nullable({ type: "string" }));
        expect(output).not.toContain(optionalConversion("std::optional"));
    });
});
