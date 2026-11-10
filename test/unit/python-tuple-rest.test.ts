// Python keeps tuples with optional trailing items and a rest, except for
// pydantic, which has no rest tuples.  Which tuples a target keeps can
// depend on its renderer options.

import {
    InputData,
    JSONSchemaInput,
    PythonTargetLanguage,
    type TargetLanguage,
    type TupleSupport,
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

const pair = {
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
};

describe("tuple support", () => {
    // A Python that keeps no tuples in just-types output.
    class OptionDependentPython extends PythonTargetLanguage {
        public getTupleSupport(
            rendererOptions: Record<string, unknown> = {},
        ): TupleSupport {
            return rendererOptions["just-types"] === true ? "none" : "fixed";
        }
    }

    test.each([
        ["keeps tuples", {}, "    pair: tuple[str, float]"],
        ["has none", { "just-types": true }, "    pair: list[float | str]"],
    ] as const)("can depend on the renderer options: %s", async (_, options, expected) => {
        const output = await renderSchema(
            {
                type: "object",
                properties: { pair },
                required: ["pair"],
            },
            options,
            new OptionDependentPython(),
        );
        expect(output).toContain(expected);
    });
});
