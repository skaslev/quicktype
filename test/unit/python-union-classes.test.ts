// Python keeps the classes of JSON Schema object schemas that forbid
// additional properties apart in unions, as `A | B`.  `from_union` tries the
// classes in turn, so each one's `from_dict` rejects unknown properties, and
// with pydantic each model forbids them.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
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

    const result = await quicktype({
        inputData,
        lang: "python",
        rendererOptions,
    });
    return result.lines.join("\n");
}

function closedObject(
    properties: Record<string, object>,
    required: string[],
): object {
    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}

const summary = {
    title: "Summary",
    ...closedObject(
        { length: { type: "integer" }, groups: { type: "integer" } },
        ["length", "groups"],
    ),
};

const full = {
    title: "Full",
    ...closedObject(
        {
            length: { type: "integer" },
            entries: { type: "array", items: { type: "string" } },
            groups: { type: "array", items: { type: "string" } },
        },
        ["length", "entries", "groups"],
    ),
};

const summaryOrFull = { oneOf: [summary, full] };

const withReply = {
    type: "object",
    properties: { reply: summaryOrFull },
    required: ["reply"],
    additionalProperties: false,
};

describe("types", () => {
    test("a union of classes", async () => {
        const output = await renderSchema(withReply, { "just-types": true });
        expect(output).toContain("    reply: Summary | Full\n");
        expect(output).toContain("@dataclass\nclass Summary:\n");
        expect(output).toContain("@dataclass\nclass Full:\n");
    });

    test("a union of classes before Python 3.10", async () => {
        const output = await renderSchema(withReply, {
            "just-types": true,
            "python-version": "3.6",
        });
        expect(output).toContain("    reply: Union[Summary, Full]\n");
    });

    test("a top-level union of classes", async () => {
        const output = await renderSchema(summaryOrFull);
        expect(output).toContain(
            "def top_level_from_dict(s: Any) -> Summary | Full:\n    return from_union([Summary.from_dict, Full.from_dict], s)",
        );
        expect(output).toContain(
            "def top_level_to_dict(x: Summary | Full) -> Any:\n    return from_union([lambda x: to_class(Summary, x), lambda x: to_class(Full, x)], x)",
        );
    });

    // Open object schemas can't be told apart by their properties.
    test("open objects are unified", async () => {
        const output = await renderSchema(
            {
                oneOf: [
                    { ...summary, additionalProperties: true },
                    { ...full, additionalProperties: true },
                ],
            },
            { "just-types": true },
        );
        expect(output).not.toContain("class Summary");
        expect(output).toContain("    groups: int | list[str]\n");
    });
});

describe("converters", () => {
    test("the classes of a union reject unknown properties", async () => {
        const output = await renderSchema(withReply);
        expect(output).toContain(
            '        assert isinstance(obj, dict)\n        assert set(obj) <= {"groups", "length"}\n        groups = from_int(obj["groups"])',
        );
        expect(output).toContain(
            '        assert set(obj) <= {"entries", "groups", "length"}\n',
        );
        expect(output).toContain(
            'reply = from_union([Summary.from_dict, Full.from_dict], obj["reply"])',
        );
        // Not a class of a union.
        expect(output.match(/assert set\(obj\)/g)).toHaveLength(2);
    });

    test("without type hints", async () => {
        const output = await renderSchema(summaryOrFull, {
            "python-version": "3.5",
        });
        expect(output).toContain(
            '    def from_dict(obj):\n        assert isinstance(obj, dict)\n        assert set(obj) <= {"groups", "length"}\n',
        );
    });

    test("an empty class of a union takes only empty objects", async () => {
        const output = await renderSchema({
            oneOf: [
                {
                    title: "Nothing",
                    type: "object",
                    additionalProperties: false,
                },
                {
                    title: "Stamp",
                    ...closedObject(
                        { at: { type: "string", format: "date-time" } },
                        ["at"],
                    ),
                },
            ],
        });
        expect(output).toContain(
            "        assert isinstance(obj, dict)\n        assert not obj\n        return Nothing()",
        );
        expect(output).toContain('        assert set(obj) <= {"at"}\n');
    });

    test("JSON property names", async () => {
        const output = await renderSchema({
            oneOf: [
                {
                    title: "A",
                    ...closedObject({ "first-entry": { type: "string" } }, [
                        "first-entry",
                    ]),
                },
                {
                    title: "B",
                    ...closedObject({ "last-entry": { type: "string" } }, [
                        "last-entry",
                    ]),
                },
            ],
        });
        expect(output).toContain(
            '        assert set(obj) <= {"first-entry"}\n',
        );
        expect(output).toContain(
            '        first_entry = from_str(obj["first-entry"])',
        );
    });

    // Python transforms unions with integer strings; such a union keeps its
    // classes, and the classes reject unknown properties.
    test("a union of classes with a transformed member", async () => {
        const output = await renderSchema({
            type: "object",
            properties: {
                v: {
                    anyOf: [
                        summary,
                        full,
                        { type: "string", format: "integer" },
                    ],
                },
            },
            required: ["v"],
        });
        expect(output).toContain("    v: Summary | Full | int\n");
        expect(output).toContain(
            'v = from_union([lambda x: int(from_str(x)), lambda x: from_union([Summary.from_dict, Full.from_dict], x)], obj["v"])',
        );
        expect(output).toContain(
            '        assert set(obj) <= {"groups", "length"}\n',
        );
        expect(output).toContain(
            '        assert set(obj) <= {"entries", "groups", "length"}\n',
        );
    });
});

describe("pydantic", () => {
    test("the models of a union forbid unknown fields", async () => {
        const output = await renderSchema(withReply, {
            "just-types": true,
            "pydantic-base-model": true,
        });
        expect(output).toContain('class Summary(BaseModel, extra="forbid"):\n');
        expect(output).toContain('class Full(BaseModel, extra="forbid"):\n');
        expect(output).toContain("class TopLevel(BaseModel):\n");
    });
});
