// Which arrays a target keeps apart in unions can depend on its renderer
// options.

import {
    InputData,
    JSONSchemaInput,
    PythonTargetLanguage,
    type TargetLanguage,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
    lang: string | TargetLanguage = "python",
): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({ inputData, lang, rendererOptions });
    return result.lines.join("\n");
}

function arrayOf(items: object): object {
    return { type: "array", items };
}

function withReply(anyOf: object[]): object {
    return {
        type: "object",
        properties: { reply: { anyOf } },
        required: ["reply"],
        additionalProperties: false,
    };
}

const stringsOrIntegers = withReply([
    arrayOf({ type: "string" }),
    arrayOf({ type: "integer" }),
]);

describe("support for unions with several arrays", () => {
    // A Python that keeps no arrays apart in just-types output.
    class OptionDependentPython extends PythonTargetLanguage {
        public getSupportsUnionsWithMultipleArrays(
            rendererOptions: Record<string, unknown> = {},
        ): boolean {
            return rendererOptions["just-types"] !== true;
        }
    }

    test.each([
        ["keeps arrays apart", {}, "    reply: list[str] | list[int]\n"],
        [
            "unifies them",
            { "just-types": true },
            "    reply: list[int | str]\n",
        ],
    ] as const)("can depend on the renderer options: %s", async (_, options, expected) => {
        const output = await renderSchema(
            stringsOrIntegers,
            options,
            new OptionDependentPython(),
        );
        expect(output).toContain(expected);
    });
});
