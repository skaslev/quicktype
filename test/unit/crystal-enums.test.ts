// Crystal enums are Crystal enums, not `String`s.  Crystal would read and
// write an enum as its member names, so each enum reads and writes its JSON
// values itself, and rejects any other value.

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

const lines = (...ls: string[]): string => ls.join("\n");

function inObject(properties: Record<string, object>): object {
    return {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
    };
}

describe("Crystal enums", () => {
    test("an enum reads and writes its JSON values", async () => {
        const output = await renderSchema(
            inObject({ mode: { enum: ["read-only", "write", "1"] } }),
        );
        expect(output).toContain("  property mode : Mode\n");
        expect(output).toContain(
            lines(
                "enum Mode",
                "  ReadOnly",
                "  Write",
                "  The1",
                "",
                "  def self.new(pull : ::JSON::PullParser)",
                "    case value = pull.read_string",
                '    when "read-only" then ReadOnly',
                '    when "write" then Write',
                '    when "1" then The1',
                '    else pull.raise "Unknown Mode value: #{value.inspect}"',
                "    end",
                "  end",
                "",
                "  def to_json(json : ::JSON::Builder)",
                "    json.string(",
                "      case self",
                '      in ReadOnly then "read-only"',
                '      in Write then "write"',
                '      in The1 then "1"',
                "      end",
                "    )",
                "  end",
                "end",
            ),
        );
    });

    test("a top-level enum is the enum", async () => {
        const output = await renderSchema({ enum: ["a", "b"] });
        expect(output).toContain("enum TopLevel\n  A\n  B\n");
        expect(output).not.toContain("alias TopLevel");
    });

    test("enums in unions and nullable enums", async () => {
        const output = await renderSchema(
            inObject({
                limit: { oneOf: [{ type: "integer" }, { enum: ["auto"] }] },
                state: { oneOf: [{ type: "null" }, { enum: ["on", "off"] }] },
            }),
        );
        expect(output).toContain("  property limit : LimitUnion\n");
        expect(output).toContain("alias LimitUnion = Int64 | LimitEnum\n");
        expect(output).toContain("  property state : State?\n");
        expect(output).toContain("enum State\n  On\n  Off\n");
    });

    test("JSON values are escaped", async () => {
        const output = await renderSchema(
            inObject({ e: { enum: ['say "#{hi}"', "a\\b"] } }),
        );
        expect(output).toContain(
            '    when "say \\"\\u{0023}{hi}\\"" then SayHi\n',
        );
        expect(output).toContain('    when "a\\\\b" then AB\n');
        expect(output).toContain('      in AB then "a\\\\b"\n');
    });
});
