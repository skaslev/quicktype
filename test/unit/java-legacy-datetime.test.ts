// With `--datetime-provider legacy`, Jackson writes date-time properties
// with the `@JsonFormat` pattern `yyyy-MM-dd'T'HH:mm:ss.SSSX` in UTC, but
// union members went through `Converter.serializeDateTime`, whose pattern
// `yyyy-MM-dd'T'hh:mm:ssZ` has a 12-hour clock (13:45 became 01:45), no
// milliseconds, and the JVM's default time zone.  Reading, the fraction of
// a second was taken for a number of milliseconds (".5" became 5 ms), and
// values without a time zone, dates among them, were read in the JVM's
// default time zone, though written back in UTC.

import { InputData, JSONSchemaInput, quicktypeMultiFile } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderJava(schema: object): Promise<Map<string, string>> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const files = await quicktypeMultiFile({
        inputData,
        lang: "java",
        rendererOptions: { "datetime-provider": "legacy" },
    });
    return new Map(
        Array.from(files, ([name, result]) => [name, result.lines.join("\n")]),
    );
}

function file(files: Map<string, string>, name: string): string {
    const contents = files.get(name);
    if (contents === undefined) {
        throw new Error(
            `${name} wasn't generated: ${Array.from(files.keys())}`,
        );
    }

    return contents;
}

function withUnion(format: string) {
    return {
        type: "object",
        properties: {
            p: { type: "string", format },
            u: { anyOf: [{ type: "string", format }, { type: "integer" }] },
        },
        required: ["p", "u"],
        additionalProperties: false,
    };
}

describe.each([
    ["date-time", "serializeDateTime", "yyyy-MM-dd'T'HH:mm:ss.SSSX"],
    ["date", "serializeDate", "yyyy-MM-dd"],
    ["time", "serializeTime", "HH:mm:ss.SSSX"],
])("%s", (format, serializer, pattern) => {
    test("union members are written like properties", async () => {
        const files = await renderJava(withUnion(format));
        expect(file(files, "U.java")).toContain(
            `jsonGenerator.writeObject(Converter.${serializer}(obj.`,
        );
        expect(file(files, "TopLevel.java")).toContain(
            `@JsonFormat(pattern = "${pattern}"`,
        );
        const converter = file(files, "Converter.java");
        expect(converter).toContain(
            [
                `public static String ${serializer}(Date datetime) {`,
                `        return utcDateFormat("${pattern}").format(datetime);`,
            ].join("\n"),
        );
    });
});

test("dates and times are read and written in UTC", async () => {
    const converter = file(
        await renderJava(withUnion("date-time")),
        "Converter.java",
    );
    expect(converter).toContain(
        [
            "    private static SimpleDateFormat utcDateFormat(String format) {",
            "        SimpleDateFormat dateFormat = new SimpleDateFormat(format);",
            '        dateFormat.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));',
            "        return dateFormat;",
            "    }",
        ].join("\n"),
    );
    expect(converter).toContain("return utcDateFormat(format).parse(str);");
    expect(converter).not.toContain("new SimpleDateFormat(format).parse");
    // No 12-hour clock anywhere.
    expect(converter).not.toMatch(/"[^"]*hh[^"]*"/);
});

test("the fraction of a second is read as milliseconds", async () => {
    const converter = file(
        await renderJava(withUnion("date-time")),
        "Converter.java",
    );
    expect(converter).toContain(
        [
            '        java.util.regex.Matcher fraction = java.util.regex.Pattern.compile("\\\\.(\\\\d+)").matcher(str);',
            "        if (fraction.find()) {",
            '            String millis = (fraction.group(1) + "00").substring(0, 3);',
            "            str = str.substring(0, fraction.start(1)) + millis + str.substring(fraction.end(1));",
            "        }",
        ].join("\n"),
    );
});
