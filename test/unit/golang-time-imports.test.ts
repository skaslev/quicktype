// Go output imports time for every type that uses time.Time, also in
// slices, maps and pointers, and the just-types modes import it at the top
// of the file, even when only a later type needs it: Go doesn't allow an
// import after a declaration.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean>,
): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({ inputData, lang: "go", rendererOptions });
    return result.lines.join("\n");
}

// The top-level class comes first and has no date-times; the class after it
// has one.
const laterDateTime = {
    type: "object",
    properties: {
        name: { type: "string" },
        event: { $ref: "#/definitions/Event" },
    },
    required: ["name", "event"],
    definitions: {
        Event: {
            type: "object",
            properties: { at: { type: "string", format: "date-time" } },
            required: ["at"],
        },
    },
};

// A union after the classes, whose member is a date-time.
const laterUnionDateTime = {
    type: "object",
    properties: {
        when: {
            oneOf: [
                { type: "string", format: "date-time" },
                { type: "integer" },
            ],
        },
    },
    required: ["when"],
};

// How often the output imports time, and whether the first import comes
// before the first type.
function timeImports(output: string): {
    count: number;
    beforeTypes: boolean;
} {
    const count = (output.match(/^import "time"$/gm) ?? []).length;
    const beforeTypes =
        output.indexOf('import "time"') < output.search(/^type /m);
    return { count, beforeTypes };
}

const dateTime = { type: "string", format: "date-time" };

// Date-times in maps, nested arrays and arrays of nullables, and in a
// union's array.
const nestedDateTimes = {
    type: "object",
    properties: {
        byName: { type: "object", additionalProperties: dateTime },
        rows: { type: "array", items: { type: "array", items: dateTime } },
        maybe: {
            type: "array",
            items: { oneOf: [dateTime, { type: "null" }] },
        },
    },
    required: ["byName", "rows", "maybe"],
};

const unionOfDateTimes = {
    type: "object",
    properties: {
        when: {
            oneOf: [{ type: "integer" }, { type: "array", items: dateTime }],
        },
    },
    required: ["when"],
};

describe("Go time imports", () => {
    test("for date-times in maps and nested arrays", async () => {
        for (const options of [
            {},
            { "just-types-and-package": true, package: "replies" },
        ]) {
            const output = await renderSchema(nestedDateTimes, options);
            expect(output).toContain("map[string]time.Time");
            expect(output).toContain("[][]time.Time");
            expect(output).toContain("[]*time.Time");
            expect(timeImports(output)).toEqual({
                count: 1,
                beforeTypes: true,
            });
        }
    });

    test("for a union's array of date-times", async () => {
        for (const options of [
            {},
            { "just-types-and-package": true, package: "replies" },
        ]) {
            const output = await renderSchema(unionOfDateTimes, options);
            expect(output).toContain("DateTimeArray []time.Time");
            expect(timeImports(output)).toEqual({
                count: 1,
                beforeTypes: true,
            });
        }
    });
});

describe("Go just-types imports", () => {
    test("just-types-and-package imports time before the first type", async () => {
        const output = await renderSchema(laterDateTime, {
            "just-types-and-package": true,
            package: "replies",
        });
        expect(output.startsWith('package replies\n\nimport "time"\n')).toBe(
            true,
        );
        expect(timeImports(output)).toEqual({ count: 1, beforeTypes: true });
    });

    test("just-types imports time before the first type", async () => {
        const output = await renderSchema(laterDateTime, {
            "just-types": true,
        });
        expect(output.startsWith('import "time"\n')).toBe(true);
        expect(timeImports(output)).toEqual({ count: 1, beforeTypes: true });
    });

    test("a union's imports, too", async () => {
        const output = await renderSchema(laterUnionDateTime, {
            "just-types-and-package": true,
            package: "replies",
        });
        expect(output).toContain("DateTime *time.Time");
        expect(timeImports(output)).toEqual({ count: 1, beforeTypes: true });
    });

    test("without imports, just-types output starts with the package", async () => {
        const output = await renderSchema(
            {
                type: "object",
                properties: { name: { type: "string" } },
            },
            { "just-types-and-package": true, package: "replies" },
        );
        expect(
            output.startsWith("package replies\n\ntype TopLevel struct {"),
        ).toBe(true);
    });
});
