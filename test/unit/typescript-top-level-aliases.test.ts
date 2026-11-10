// Top-levels that aren't classes, enums or (with --declare-unions) unions get
// an exported alias of their own in TypeScript and Flow.

import {
    InputData,
    JSONSchemaInput,
    type LanguageName,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    lang: LanguageName,
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
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

const justTypes = { "just-types": true };

const nullableString = { oneOf: [{ type: "string" }, { type: "null" }] };

const nullableObject = {
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
};

describe("TypeScript top-level aliases", () => {
    test("nullable classes", async () => {
        const output = await renderSchema(
            "typescript",
            nullableObject,
            justTypes,
        );
        expect(output).toContain("export type TopLevel = User | null;");
        expect(output).toContain("export interface User {");
    });

    test("nullable primitives", async () => {
        expect(
            await renderSchema("typescript", nullableString, justTypes),
        ).toContain("export type TopLevel = null | string;");
    });

    test("primitives are exported", async () => {
        expect(
            await renderSchema("typescript", { type: "integer" }, justTypes),
        ).toContain("export type TopLevel = number;");
    });

    test("maps of classes don't lend the top-level name to the class", async () => {
        const output = await renderSchema(
            "typescript",
            {
                type: "object",
                additionalProperties: nullableObject.oneOf[0],
            },
            justTypes,
        );
        expect(output).toContain(
            "export type TopLevel = { [key: string]: User };",
        );
        expect(output).toContain("export interface User {");
    });
});
