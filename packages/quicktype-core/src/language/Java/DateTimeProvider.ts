import type { Sourcelike } from "../../Source.js";

import type { JavaRenderer } from "./JavaRenderer.js";

export abstract class JavaDateTimeProvider {
    public constructor(
        protected readonly _renderer: JavaRenderer,
        protected readonly _className: string,
    ) {}

    public abstract keywords: string[];

    public abstract dateTimeImports: string[];

    public abstract dateImports: string[];

    public abstract timeImports: string[];

    public abstract converterImports: string[];

    public abstract dateTimeType: string;

    public abstract dateType: string;

    public abstract timeType: string;

    public abstract dateTimeJacksonAnnotations: string[];

    public abstract dateJacksonAnnotations: string[];

    public abstract timeJacksonAnnotations: string[];

    public abstract emitDateTimeConverters(): void;

    public shouldEmitDateTimeConverter = true;

    public shouldEmitTimeConverter = true;

    public shouldEmitDateConverter = true;

    public abstract convertStringToDateTime(variable: Sourcelike): Sourcelike;
    public abstract convertStringToTime(variable: Sourcelike): Sourcelike;
    public abstract convertStringToDate(variable: Sourcelike): Sourcelike;

    public abstract convertDateTimeToString(variable: Sourcelike): Sourcelike;
    public abstract convertTimeToString(variable: Sourcelike): Sourcelike;
    public abstract convertDateToString(variable: Sourcelike): Sourcelike;
}

export class Java8DateTimeProvider extends JavaDateTimeProvider {
    public keywords = [
        "LocalDate",
        "OffsetDateTime",
        "OffsetTime",
        "ZoneOffset",
        "ZonedDateTime",
        "DateTimeFormatter",
        "DateTimeFormatterBuilder",
        "ChronoField",
    ];

    public dateTimeImports: string[] = ["java.time.OffsetDateTime"];

    public dateImports: string[] = ["java.time.LocalDate"];

    public timeImports: string[] = ["java.time.OffsetTime"];

    public converterImports: string[] = [
        "java.time.LocalDate",
        "java.time.OffsetDateTime",
        "java.time.OffsetTime",
        "java.time.ZoneOffset",
        "java.time.ZonedDateTime",
        "java.time.format.DateTimeFormatter",
        "java.time.format.DateTimeFormatterBuilder",
        "java.time.temporal.ChronoField",
    ];

    public dateTimeType = "OffsetDateTime";

    public dateType = "LocalDate";

    public timeType = "OffsetTime";

    public dateTimeJacksonAnnotations: string[] = [];

    public dateJacksonAnnotations: string[] = [];

    public timeJacksonAnnotations: string[] = [];

    public emitDateTimeConverters(): void {
        this._renderer.ensureBlankLine();
        this._renderer.emitLine(
            "private static final DateTimeFormatter DATE_TIME_FORMATTER = new DateTimeFormatterBuilder()",
        );
        this._renderer.indent(() =>
            this._renderer.indent(() => {
                this._renderer.emitLine(
                    ".appendOptional(DateTimeFormatter.ISO_DATE_TIME)",
                );
                this._renderer.emitLine(
                    ".appendOptional(DateTimeFormatter.ISO_OFFSET_DATE_TIME)",
                );
                this._renderer.emitLine(
                    ".appendOptional(DateTimeFormatter.ISO_INSTANT)",
                );
                this._renderer.emitLine(
                    '.appendOptional(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SX"))',
                );
                this._renderer.emitLine(
                    '.appendOptional(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ssX"))',
                );
                this._renderer.emitLine(
                    '.appendOptional(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"))',
                );
                this._renderer.emitLine(".toFormatter()");
                this._renderer.emitLine(".withZone(ZoneOffset.UTC);");
            }),
        );
        this._renderer.ensureBlankLine();
        this._renderer.emitBlock(
            "public static OffsetDateTime parseDateTimeString(String str)",
            () => {
                this._renderer.emitLine(
                    "return ZonedDateTime.from(Converter.DATE_TIME_FORMATTER.parse(str)).toOffsetDateTime();",
                );
            },
        );

        this._renderer.ensureBlankLine();
        this._renderer.emitLine(
            "private static final DateTimeFormatter TIME_FORMATTER = new DateTimeFormatterBuilder()",
        );
        this._renderer.indent(() =>
            this._renderer.indent(() => {
                this._renderer.emitLine(
                    ".appendOptional(DateTimeFormatter.ISO_TIME)",
                );
                this._renderer.emitLine(
                    ".appendOptional(DateTimeFormatter.ISO_OFFSET_TIME)",
                );
                this._renderer.emitLine(
                    ".parseDefaulting(ChronoField.YEAR, 2020)",
                );
                this._renderer.emitLine(
                    ".parseDefaulting(ChronoField.MONTH_OF_YEAR, 1)",
                );
                this._renderer.emitLine(
                    ".parseDefaulting(ChronoField.DAY_OF_MONTH, 1)",
                );
                this._renderer.emitLine(".toFormatter()");
                this._renderer.emitLine(".withZone(ZoneOffset.UTC);");
            }),
        );
        this._renderer.ensureBlankLine();
        this._renderer.emitBlock(
            "public static OffsetTime parseTimeString(String str)",
            () => {
                this._renderer.emitLine(
                    "return ZonedDateTime.from(Converter.TIME_FORMATTER.parse(str)).toOffsetDateTime().toOffsetTime();",
                );
            },
        );
    }

    public convertStringToDateTime(variable: Sourcelike): Sourcelike {
        return [this._className, ".parseDateTimeString(", variable, ")"];
    }

    public convertStringToTime(variable: Sourcelike): Sourcelike {
        return [this._className, ".parseTimeString(", variable, ")"];
    }

    public convertStringToDate(variable: Sourcelike): Sourcelike {
        return ["LocalDate.parse(", variable, ")"];
    }

    public convertDateTimeToString(variable: Sourcelike): Sourcelike {
        return [
            variable,
            ".format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)",
        ];
    }

    public convertTimeToString(variable: Sourcelike): Sourcelike {
        return [
            variable,
            ".format(java.time.format.DateTimeFormatter.ISO_OFFSET_TIME)",
        ];
    }

    public convertDateToString(variable: Sourcelike): Sourcelike {
        return [
            variable,
            ".format(java.time.format.DateTimeFormatter.ISO_DATE)",
        ];
    }
}
// How the legacy provider writes dates and times, in UTC: Jackson with
// these patterns for properties, `Converter.serialize...` for union members.
const dateTimePattern = "yyyy-MM-dd'T'HH:mm:ss.SSSX";
const datePattern = "yyyy-MM-dd";
const timePattern = "HH:mm:ss.SSSX";

export class JavaLegacyDateTimeProvider extends JavaDateTimeProvider {
    public keywords = ["SimpleDateFormat", "Date"];

    public dateTimeImports: string[] = ["java.util.Date"];

    public dateImports: string[] = ["java.util.Date"];

    public timeImports: string[] = ["java.util.Date"];

    public converterImports: string[] = [
        "java.util.Date",
        "java.text.SimpleDateFormat",
    ];

    public dateTimeType = "Date";

    public dateType = "Date";

    public timeType = "Date";

    public dateTimeJacksonAnnotations: string[] = [
        `@JsonFormat(pattern = "${dateTimePattern}", timezone = "UTC")`,
    ];

    public dateJacksonAnnotations: string[] = [
        `@JsonFormat(pattern = "${datePattern}")`,
    ];

    public timeJacksonAnnotations: string[] = [
        `@JsonFormat(pattern = "${timePattern}", timezone = "UTC")`,
    ];

    public shouldEmitTimeConverter = false;

    public shouldEmitDateConverter = false;

    public emitDateTimeConverters(): void {
        this._renderer.ensureBlankLine();
        this._renderer.emitLine(
            "private static final String[] DATE_TIME_FORMATS = {",
        );
        this._renderer.indent(() =>
            this._renderer.indent(() => {
                this._renderer.emitLine("\"yyyy-MM-dd'T'HH:mm:ss.SX\",");
                this._renderer.emitLine("\"yyyy-MM-dd'T'HH:mm:ss.S\",");
                this._renderer.emitLine("\"yyyy-MM-dd'T'HH:mm:ssX\",");
                this._renderer.emitLine("\"yyyy-MM-dd'T'HH:mm:ss\",");
                this._renderer.emitLine('"yyyy-MM-dd HH:mm:ss.SX",');
                this._renderer.emitLine('"yyyy-MM-dd HH:mm:ss.S",');
                this._renderer.emitLine('"yyyy-MM-dd HH:mm:ssX",');
                this._renderer.emitLine('"yyyy-MM-dd HH:mm:ss",');
                this._renderer.emitLine('"HH:mm:ss.SZ",');
                this._renderer.emitLine('"HH:mm:ss.S",');
                this._renderer.emitLine('"HH:mm:ssZ",');
                this._renderer.emitLine('"HH:mm:ss",');
                this._renderer.emitLine('"yyyy-MM-dd",');
            }),
        );
        this._renderer.emitLine("};");
        this._renderer.ensureBlankLine();
        this._renderer.emitBlock(
            "public static Date parseAllDateTimeString(String str)",
            () => {
                // SimpleDateFormat reads the fraction of a second as a
                // number of milliseconds, so it must have three digits:
                // ".5" would be 5 ms.
                this._renderer.emitLine(
                    'java.util.regex.Matcher fraction = java.util.regex.Pattern.compile("\\\\.(\\\\d+)").matcher(str);',
                );
                this._renderer.emitBlock("if (fraction.find())", () => {
                    this._renderer.emitLine(
                        'String millis = (fraction.group(1) + "00").substring(0, 3);',
                    );
                    this._renderer.emitLine(
                        "str = str.substring(0, fraction.start(1)) + millis + str.substring(fraction.end(1));",
                    );
                });
                this._renderer.emitBlock(
                    "for (String format : DATE_TIME_FORMATS)",
                    () => {
                        this._renderer.emitIgnoredTryCatchBlock(() => {
                            this._renderer.emitLine(
                                "return utcDateFormat(format).parse(str);",
                            );
                        });
                    },
                );
                this._renderer.emitLine("return null;");
            },
        );

        // Jackson writes the properties in UTC (see the annotations), so
        // the union members are written, and values without a time zone
        // read, in UTC too, whatever the JVM's default time zone.
        this._renderer.ensureBlankLine();
        this._renderer.emitBlock(
            "private static SimpleDateFormat utcDateFormat(String format)",
            () => {
                this._renderer.emitLine(
                    "SimpleDateFormat dateFormat = new SimpleDateFormat(format);",
                );
                this._renderer.emitLine(
                    'dateFormat.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));',
                );
                this._renderer.emitLine("return dateFormat;");
            },
        );

        this._renderer.ensureBlankLine();
        this._renderer.emitBlock(
            "public static String serializeDateTime(Date datetime)",
            () => {
                this._renderer.emitLine(
                    `return utcDateFormat("${dateTimePattern}").format(datetime);`,
                );
            },
        );

        this._renderer.ensureBlankLine();
        this._renderer.emitBlock(
            "public static String serializeDate(Date datetime)",
            () => {
                this._renderer.emitLine(
                    `return utcDateFormat("${datePattern}").format(datetime);`,
                );
            },
        );

        this._renderer.ensureBlankLine();
        this._renderer.emitBlock(
            "public static String serializeTime(Date datetime)",
            () => {
                this._renderer.emitLine(
                    `return utcDateFormat("${timePattern}").format(datetime);`,
                );
            },
        );
    }

    public convertStringToDateTime(variable: Sourcelike): Sourcelike {
        return [this._className, ".parseAllDateTimeString(", variable, ")"];
    }

    public convertStringToTime(variable: Sourcelike): Sourcelike {
        return [this._className, ".parseAllDateTimeString(", variable, ")"];
    }

    public convertStringToDate(variable: Sourcelike): Sourcelike {
        return [this._className, ".parseAllDateTimeString(", variable, ")"];
    }

    public convertDateTimeToString(variable: Sourcelike): Sourcelike {
        return [this._className, ".serializeDateTime(", variable, ")"];
    }

    public convertTimeToString(variable: Sourcelike): Sourcelike {
        return [this._className, ".serializeTime(", variable, ")"];
    }

    public convertDateToString(variable: Sourcelike): Sourcelike {
        return [this._className, ".serializeDate(", variable, ")"];
    }
}
