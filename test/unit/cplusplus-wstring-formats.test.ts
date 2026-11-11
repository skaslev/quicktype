// With --wstring use-wstring, strings are std::wstring in C++ and converted
// from and to the UTF-8 std::string of the JSON.  uuid and date-time strings
// weren't: they were read as std::wstring directly, which nlohmann/json
// takes for an array ("type must be array, but is string"), and written
// without conversion.

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

const formats = {
    type: "object",
    properties: {
        id: { type: "string", format: "uuid" },
        at: { type: "string", format: "date-time" },
        ids: { type: "array", items: { type: "string", format: "uuid" } },
        u: { oneOf: [{ type: "string", format: "uuid" }, { type: "integer" }] },
    },
    required: ["id", "at", "ids", "u"],
    additionalProperties: false,
};

const toWide = "Utf16_Utf8<std::string, std::wstring>::convert";
const toNarrow = "Utf16_Utf8<std::wstring, std::string>::convert";

describe("C++ wide strings with string formats", () => {
    test("are wide strings", async () => {
        const output = await render(formats);
        expect(output).toContain("std::wstring id;");
        expect(output).toContain("std::wstring at;");
        expect(output).toContain("std::vector<std::wstring> ids;");
    });

    test("are read from narrow strings", async () => {
        const output = await render(formats);
        expect(output).toContain(
            `x.set_id(${toWide}(j.at(${toNarrow}(L"id")).get<std::string>()));`,
        );
        expect(output).toContain(
            `x.set_at(${toWide}(j.at(${toNarrow}(L"at")).get<std::string>()));`,
        );
        expect(output).toContain(
            "x.set_ids(Utf16_Utf8<std::vector<std::string>, std::vector<std::wstring>>::convert(",
        );
        expect(output).not.toContain(".get<std::wstring>()");
    });

    test("are written as narrow strings", async () => {
        const output = await render(formats);
        expect(output).toContain(
            `j[${toNarrow}(L"id")] = ${toNarrow}(x.get_id());`,
        );
        expect(output).toContain(
            `j[${toNarrow}(L"at")] = ${toNarrow}(x.get_at());`,
        );
    });

    test("are converted in unions", async () => {
        const output = await render(formats);
        expect(output).toContain(
            `x = quicktype::${toWide}(j.get<std::string>());`,
        );
        expect(output).toContain(
            `j = quicktype::${toNarrow}(std::get<std::wstring>(x));`,
        );
    });
});
