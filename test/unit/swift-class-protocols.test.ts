// Swift synthesizes Equatable and Hashable for structs and enums, but not
// for classes, so with `--protocol` a class compares and hashes its
// properties itself.

import {
    InputData,
    JSONSchemaInput,
    type RendererOptions,
    quicktype,
} from "../../packages/quicktype-core/src/index.js";
import { describe, expect, test } from "vitest";

async function renderSwift(
    schema: object,
    rendererOptions: RendererOptions,
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
        lang: "swift",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const point = {
    type: "object",
    properties: { x: { type: "integer" }, y: { type: "integer" } },
    required: ["x"],
};
const equals = [
    "    static func == (lhs: TopLevel, rhs: TopLevel) -> Bool {",
    "        return lhs.x == rhs.x &&",
    "            lhs.y == rhs.y",
    "    }",
].join("\n");
const hash = [
    "    func hash(into hasher: inout Hasher) {",
    "        hasher.combine(self.x)",
    "        hasher.combine(self.y)",
    "    }",
].join("\n");

describe("Swift classes with --protocol", () => {
    test("compare their properties for Equatable", async () => {
        const output = await renderSwift(point, {
            "struct-or-class": "class",
            protocol: "equatable",
        });

        expect(output).toContain("class TopLevel: Codable, Equatable {");
        expect(output).toContain(equals);
        expect(output).not.toContain("func hash(into");
    });

    test("compare and hash their properties for Hashable", async () => {
        const output = await renderSwift(point, {
            "struct-or-class": "class",
            protocol: "hashable",
        });

        expect(output).toContain("class TopLevel: Codable, Hashable {");
        expect(output).toContain(equals);
        expect(output).toContain(hash);
    });

    test("have public implementations if they're public", async () => {
        const output = await renderSwift(point, {
            "struct-or-class": "class",
            protocol: "hashable",
            "access-level": "public",
        });

        expect(output).toContain(
            "public static func == (lhs: TopLevel, rhs: TopLevel) -> Bool {",
        );
        expect(output).toContain(
            "public func hash(into hasher: inout Hasher) {",
        );
    });

    test("are equal if they have no properties", async () => {
        const output = await renderSwift(
            { type: "object", properties: {}, additionalProperties: false },
            { "struct-or-class": "class", protocol: "hashable" },
        );

        expect(output).toContain(
            "static func == (lhs: TopLevel, rhs: TopLevel) -> Bool {\n        return true\n    }",
        );
    });

    test("include the classes that break cycles", async () => {
        const output = await renderSwift(
            {
                $ref: "#/definitions/Node",
                definitions: {
                    Node: {
                        type: "object",
                        properties: {
                            value: { type: "integer" },
                            next: { $ref: "#/definitions/Node" },
                        },
                        required: ["value"],
                    },
                },
            },
            { protocol: "equatable" },
        );

        expect(output).toContain("class TopLevel: Codable, Equatable {");
        expect(output).toContain(
            "        return lhs.next == rhs.next &&\n            lhs.value == rhs.value",
        );
    });

    test("leave structs to the compiler", async () => {
        const output = await renderSwift(point, { protocol: "hashable" });

        expect(output).toContain("struct TopLevel: Codable, Hashable {");
        expect(output).not.toContain("static func ==");
        expect(output).not.toContain("func hash(into");
    });
});
