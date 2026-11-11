// Crystal declares a union as an alias without Nil; its references add the
// Nil back with `?`.  A top-level union with null therefore can't be that
// alias: `TopLevel.from_json("null")` would fail.  The top-level is an
// alias that adds the `?` instead, of the union or of the single type
// (whose union has no alias at all, so the top-level name used to be
// left undeclared).

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
    const result = await quicktype({ inputData, lang: "crystal" });
    return result.lines.join("\n");
}

describe("Crystal nullable top-levels", () => {
    // Redis ZRANK: nil, a rank, or a rank and a score.
    test("a union of null and several types", async () => {
        const output = await renderSchema({
            oneOf: [
                { type: "null" },
                { type: "integer" },
                { type: "array", items: { type: "string" } },
            ],
        });
        expect(output).toContain("alias TopLevel = TopLevelUnion?\n");
        expect(output).toContain(
            "alias TopLevelUnion = Int64 | Array(String)\n",
        );
    });

    test("a union of null and a primitive", async () => {
        const output = await renderSchema({
            oneOf: [{ type: "string" }, { type: "null" }],
        });
        expect(output).toContain("alias TopLevel = String?\n");
    });

    test("a union of null and a class", async () => {
        const output = await renderSchema({
            oneOf: [
                {
                    title: "User",
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    additionalProperties: false,
                },
                { type: "null" },
            ],
        });
        expect(output).toContain("alias TopLevel = User?\n");
        expect(output).toContain("class User\n");
    });

    test("a union without null keeps the top-level name", async () => {
        const output = await renderSchema({
            oneOf: [{ type: "integer" }, { type: "string" }],
        });
        expect(output).toContain("alias TopLevel = Int64 | String\n");
    });
});
