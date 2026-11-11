// PHP spells out a union's conversions where it's used, which is impossible
// for a union that contains itself through arrays and maps, e.g. `Node =
// string | Node[]` from a recursive `anyOf`: the converters overflowed the
// stack, and a cycle without any named type failed with "Defined value
// expected" or "emitUnionDefinition not implemented".  Such a union now gets
// a class of static `from`/`to`/`validate`/`sample` helpers, which call
// themselves where the union occurs again.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { expect, test } from "vitest";

async function renderPhp(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({ inputData, lang: "php" });
    return result.lines.join("\n");
}

function lines(...ls: string[]): string {
    return ls.join("\n");
}

test("a recursive top-level union", async () => {
    const output = await renderPhp({
        $ref: "#/$defs/node",
        $defs: {
            node: {
                anyOf: [
                    { type: "string" },
                    { type: "array", items: { $ref: "#/$defs/node" } },
                ],
            },
        },
    });
    expect(output).toContain(
        lines(
            "    public static function from(array|string $value): array|string {",
            "        if (is_array($value)) {",
            "            return  array_map(function ($value) {",
            "                return TopLevel::from($value);",
            "            }, $value);",
            "        } elseif (is_string($value)) {",
        ),
    );
    expect(output).toContain(
        "    public static function to(array|string $value): array|string {",
    );
    expect(output).toContain("                return TopLevel::to($value);");
    expect(output).toContain(
        lines(
            "            array_walk($value, function($value_v) {",
            "                TopLevel::validate($value_v);",
            "            });",
        ),
    );
    expect(output).toContain(
        lines(
            "    public static function sample(): array|string {",
            "        return 'TopLevel::::0'; /*0:*/",
            "    }",
        ),
    );
});

test("R = R[] | string[]", async () => {
    // The two arrays are merged into one of `R | string`, whose union
    // takes the top-level's name.
    const output = await renderPhp({
        $ref: "#/$defs/r",
        $defs: {
            r: {
                anyOf: [
                    { type: "array", items: { $ref: "#/$defs/r" } },
                    { type: "array", items: { type: "string" } },
                ],
            },
        },
    });
    expect(output).toContain("class TopLevel {");
    expect(output).toContain("                return TopLevel::from($value);");
});

test("a recursive union property, with a class in the union", async () => {
    const output = await renderPhp({
        type: "object",
        properties: { x: { $ref: "#/$defs/n" } },
        required: ["x"],
        additionalProperties: false,
        $defs: {
            n: {
                anyOf: [
                    { $ref: "#/$defs/f" },
                    { type: "integer" },
                    { type: "array", items: { $ref: "#/$defs/n" } },
                ],
            },
            f: {
                type: "object",
                properties: { n: { $ref: "#/$defs/n" } },
                required: ["n"],
                additionalProperties: false,
            },
        },
    });
    expect(output).toContain("    private F|array|int $x;");
    expect(output).toContain(
        lines(
            "    public static function fromX(stdClass|array|int $value): F|array|int {",
            "        return N::from($value);",
            "    }",
        ),
    );
    expect(output).toContain("            return N::to($this->x);");
    expect(output).toContain("        N::validate($value);");
    expect(output).toContain("        return N::sample();");
    expect(output).toContain("class N {");
    expect(output).toContain(
        lines(
            "    public static function from(stdClass|array|int $value): F|array|int {",
            "        if (is_object($value)) {",
            "            return F::from($value); /*class*/",
            "        } elseif (is_array($value)) {",
            "            return  array_map(function ($value) {",
            "                return N::from($value);",
            "            }, $value);",
        ),
    );
    // The sample is the integer's, which doesn't come back to the union.
    expect(output).toContain(
        lines(
            "    public static function sample(): F|array|int {",
            "        return 0; /*0:*/",
            "    }",
        ),
    );
});

test("a recursive union with a map", async () => {
    const output = await renderPhp({
        $ref: "#/$defs/n",
        $defs: {
            n: {
                anyOf: [
                    { type: "string" },
                    {
                        type: "object",
                        additionalProperties: { $ref: "#/$defs/n" },
                    },
                ],
            },
        },
    });
    expect(output).toContain(
        lines(
            "            foreach ($value as $k => $v) {",
            "                $out->$k = TopLevel::from($v);",
            "            }",
        ),
    );
});

test("a nullable recursive union", async () => {
    const output = await renderPhp({
        type: "object",
        properties: { x: { $ref: "#/$defs/n" } },
        required: ["x"],
        additionalProperties: false,
        $defs: {
            n: {
                anyOf: [
                    { type: "null" },
                    { type: "string" },
                    { type: "array", items: { $ref: "#/$defs/n" } },
                ],
            },
        },
    });
    expect(output).toContain(
        "    public static function from(array|string|null $value): array|string|null {",
    );
    expect(output).toContain(
        lines(
            "        if (is_null($value)) {",
            "            return $value; /*null*/",
        ),
    );
});

test("other unions are still spelled out where they're used", async () => {
    const output = await renderPhp({
        type: "object",
        properties: {
            x: {
                anyOf: [
                    { type: "string" },
                    { type: "array", items: { type: "string" } },
                ],
            },
        },
        required: ["x"],
        additionalProperties: false,
    });
    expect(output).not.toContain("::from($value)");
    expect(output.match(/^class /gm)).toEqual(["class "]);
});
