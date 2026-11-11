// A struct can't contain itself, so every cycle of Swift types needs a
// class, or an `indirect` enum for a union.  A nullable union is an
// optional, so it can't break a cycle; its class has to.

import {
    InputData,
    JSONSchemaInput,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";
import { describe, expect, test } from "vitest";

async function renderSwift(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });

    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({ inputData, lang: "swift" });
    return result.lines.join("\n");
}

const nullableNode = {
    oneOf: [{ $ref: "#/definitions/Node" }, { type: "null" }],
};
const definitions = {
    Node: {
        type: "object",
        properties: { value: { type: "integer" }, next: nullableNode },
        required: ["value", "next"],
    },
};

describe("Swift cycles through nullable unions", () => {
    test("make the class a class when it's reached through the union", async () => {
        const output = await renderSwift({
            type: "object",
            properties: { root: nullableNode },
            required: ["root"],
            definitions,
        });

        expect(output).toContain("struct TopLevel: Codable {");
        expect(output).toContain("class Node: Codable {");
        expect(output).not.toContain("struct Node");
    });

    test("make the class a class when the union is the top-level", async () => {
        const output = await renderSwift({ ...nullableNode, definitions });

        expect(output).toContain("class Node: Codable {");
        expect(output).not.toContain("struct Node");
    });

    test("make a tuple a class when it's reached through the union", async () => {
        const nullableTuple = {
            oneOf: [{ $ref: "#/definitions/Pair" }, { type: "null" }],
        };
        const output = await renderSwift({
            type: "object",
            properties: { root: nullableTuple },
            required: ["root"],
            definitions: {
                Pair: {
                    type: "array",
                    items: [{ type: "integer" }, nullableTuple],
                    minItems: 2,
                    maxItems: 2,
                },
            },
        });

        expect(output).toContain("class Pair: Codable {");
        expect(output).not.toContain("struct Pair");
    });

    test("still break a cycle with an indirect enum for a union that isn't nullable", async () => {
        const output = await renderSwift({
            $ref: "#/definitions/Value",
            definitions: {
                Value: {
                    oneOf: [{ type: "string" }, { $ref: "#/definitions/Box" }],
                },
                Box: {
                    type: "object",
                    properties: { value: { $ref: "#/definitions/Value" } },
                    required: ["value"],
                },
            },
        });

        expect(output).toContain("indirect enum TopLevel: Codable {");
        expect(output).toContain("struct Box: Codable {");
    });
});
