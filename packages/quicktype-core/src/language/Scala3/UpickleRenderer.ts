import { arrayIntercalate } from "collection-utils";

import type { Name } from "../../Naming.js";
import type { Sourcelike } from "../../Source.js";
import {
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";
import {
    type ClassType,
    type EnumType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import { stringEscape, utf16StringEscape } from "../../support/Strings.js";

import { Scala3Renderer, type TupleField } from "./Scala3Renderer.js";
import {
    propertyNameNeedsMapping,
    unionMemberSortOrder,
    wrapOption,
} from "./utils.js";

// The emitted JsonExt's readers of primitive types that read only their
// own JSON type.
const strictReaders: Partial<Record<string, string>> = {
    Boolean: "JsonExt.strictBoolean",
    Double: "JsonExt.strictDouble",
    Long: "JsonExt.strictLong",
    String: "JsonExt.strictString",
};

export class UpickleRenderer extends Scala3Renderer {
    private readonly seenUnionTypes: string[] = [];

    protected emitClassDefinitionMethods(
        _c: ClassType,
        _className: Name,
    ): void {
        this.emitLine(") derives OptionPickler.ReadWriter");
    }

    protected emitPropertyAnnotation(_name: Name, jsonName: string): void {
        if (propertyNameNeedsMapping(jsonName)) {
            this.emitLine(
                `@upickle.implicits.key("${utf16StringEscape(jsonName)}")`,
            );
        }
    }

    protected anySourceType(optional: boolean): Sourcelike {
        return [wrapOption("ujson.Value", optional)];
    }

    protected emitHeader(): void {
        super.emitHeader();
        this.emitMultiline(`// Custom pickler so that missing keys and JSON nulls both read as None,
// and None is left out when writing (upickle's default for Option is a
// JSON array).
object OptionPickler extends upickle.AttributeTagged:
    import upickle.default.Writer
    import upickle.default.Reader
    override implicit def OptionWriter[T: Writer]: Writer[Option[T]] =
        implicitly[Writer[T]].comap[Option[T]] {
            case None => null.asInstanceOf[T]
            case Some(x) => x
        }

    override implicit def OptionReader[T: Reader]: Reader[Option[T]] = {
        new Reader.Delegate[Any, Option[T]](implicitly[Reader[T]].map(Some(_))){
        override def visitNull(index: Int) = None
        }
    }
end OptionPickler

// If a union has a null in, then we'll need this too...
type NullValue = None.type
given OptionPickler.ReadWriter[NullValue] = OptionPickler.readwriter[ujson.Value].bimap[NullValue](
    _ => ujson.Null,
    json => if json.isNull then None else throw new upickle.core.Abort("not null")
)
given OptionPickler.ReadWriter[java.time.Instant] = OptionPickler.readwriter[ujson.Value].bimap(
    value => ujson.Str(value.toString),
    json => json match
        case ujson.Str(value) => java.time.Instant.parse(value)
        case other => throw new upickle.core.Abort("expected date-time, got " + other)
)
given OptionPickler.ReadWriter[java.util.UUID] = OptionPickler.readwriter[String].bimap(
    _.toString,
    value =>
        val uuid = java.util.UUID.fromString(value)
        if uuid.toString.equalsIgnoreCase(value) then uuid else throw new upickle.core.Abort("invalid UUID")
)

object JsonExt:
    val valueReader = OptionPickler.readwriter[ujson.Value]

    // upickle's built-in primitive readers are lenient -- the numeric and
    // boolean readers accept strings, and the string reader accepts
    // numbers and booleans -- so untagged unions need strict readers to
    // pick the right member.
    val strictString: OptionPickler.Reader[String] = valueReader.map {
        case ujson.Str(s) => s
        case json => throw new upickle.core.Abort("expected string, got " + json)
    }
    val strictLong: OptionPickler.Reader[Long] = valueReader.map {
        case ujson.Num(n) if n.isWhole => n.toLong
        case json => throw new upickle.core.Abort("expected integer, got " + json)
    }
    val strictDouble: OptionPickler.Reader[Double] = valueReader.map {
        case ujson.Num(n) => n
        case json => throw new upickle.core.Abort("expected number, got " + json)
    }
    val strictBoolean: OptionPickler.Reader[Boolean] = valueReader.map {
        case ujson.Bool(b) => b
        case json => throw new upickle.core.Abort("expected boolean, got " + json)
    }

    def badMerge[T](r1: => OptionPickler.Reader[?], rest: OptionPickler.Reader[?]*): OptionPickler.Reader[T] = valueReader.map { json =>
        var t: T | Null = null
        val stack       = Vector.newBuilder[Throwable]
        (r1 +: rest).foreach { reader =>
            if t == null then
            try
                t = OptionPickler.read[T](json, trace = true)(using reader.asInstanceOf[OptionPickler.Reader[T]])
            catch
                case exc => stack += exc
        }
        if t != null then t.nn else throw new Exception(json.toString(), stack.result().headOption.getOrElse(null))
    }
end JsonExt
given OptionPickler.Reader[Long] = JsonExt.strictLong
`);
        this.ensureBlankLine();
    }

    protected override emitEmptyClassDefinition(
        c: ClassType,
        className: Name,
    ): void {
        super.emitEmptyClassDefinition(c, className);
        this.emitItem(" derives OptionPickler.ReadWriter");
        this.ensureBlankLine();
    }

    // In JSON the case class is the tuple of its fields.  The tuple's
    // ReadWriter is summoned when it's used: when the given is created, it'd
    // need this given, which isn't there yet.
    protected override emitTupleCaseClassCodecs(
        t: TupleType,
        tupleName: Name,
    ): void {
        this.ensureBlankLine();
        this.emitLine(["object ", tupleName, ":"]);
        this.indent(() => {
            this.emitLine([
                "given OptionPickler.ReadWriter[",
                tupleName,
                "] = OptionPickler.readwriter[ujson.Value].bimap[",
                tupleName,
                "](",
            ]);
            this.indent(() => {
                this.emitLine([
                    "t => OptionPickler.writeJs(",
                    this.tupleOfCaseClass(t, "t"),
                    "),",
                ]);
                this.emitLine([
                    "json => { val t = OptionPickler.read[",
                    this.tupleSource(t),
                    "](json); ",
                    this.caseClassOfTuple(t, tupleName, "t"),
                    " }",
                ]);
            });
            this.emitLine(")");
        });
        this.ensureBlankLine();
    }

    // upickle's readers are lenient: those of primitive types read other
    // primitives (a number where the item is a string, say), the others
    // read null.  So a primitive item is read with a strict reader, like a
    // union member, and a null is rejected where the item isn't nullable:
    // otherwise a union trying a tuple would take an array that isn't one.
    private readTupleItem(t: Type, value: string, tupleName: Name): Sourcelike {
        const scalaType = this.scalaType(t);
        const read: Sourcelike[] = [
            "OptionPickler.read[",
            scalaType,
            "](",
            value,
            ")",
        ];
        const primitive = t instanceof UnionType ? nullableFromUnion(t) : t;
        const strict = primitive?.isPrimitive()
            ? strictReaders[this.sourcelikeToString(this.scalaType(primitive))]
            : undefined;
        if (strict !== undefined) {
            return [
                ...read,
                primitive === t
                    ? `(using ${strict})`
                    : `(using OptionPickler.OptionReader(using ${strict}))`,
            ];
        }

        const readsNull =
            ["class", "map", "array"].includes(t.kind) ||
            (t instanceof TupleType && t.isFixedLength);
        if (!readsNull) return read;
        return [
            "OptionPickler.read[Option[",
            scalaType,
            "]](",
            value,
            ').getOrElse(throw new upickle.core.Abort("',
            tupleName,
            ': unexpected null"))',
        ];
    }

    // The case class is a JSON array: the required items, the optional
    // ones that are present, then the rest.  An item after a missing
    // optional one is an error, as JSON can't leave a gap.  The reader
    // checks the array's length and reads each element with its item's
    // reader, so that a null is only accepted where the item is nullable.
    protected override emitVariableLengthTupleCodecs(
        t: TupleType,
        tupleName: Name,
    ): void {
        const fields = this.variableLengthTupleFields(t);
        const write = (f: TupleField): Sourcelike => [
            "OptionPickler.writeJs[",
            this.scalaType(f.type),
            "]",
        ];
        const required = fields.filter((f) => f.kind === "required");
        const written: Sourcelike[] = [
            required.length === 0
                ? "List.empty[ujson.Value]"
                : [
                      "List(",
                      ...arrayIntercalate(
                          ", ",
                          required.map(
                              (f): Sourcelike => [write(f), `(t.${f.name})`],
                          ),
                      ),
                      ")",
                  ],
            ...fields
                .filter((f) => f.kind !== "required")
                .map(
                    (f): Sourcelike => [
                        ` ++ t.${f.name}.map(`,
                        write(f),
                        "(_))",
                    ],
                ),
        ];
        const gap = this.variableLengthTupleGap(t, "t");

        const lengthChecks: string[] = [];
        if (t.minItems > 0) lengthChecks.push(`xs.length >= ${t.minItems}`);
        if (t.rest === undefined) {
            lengthChecks.push(`xs.length <= ${t.items.length}`);
        }

        const read = (f: TupleField): Sourcelike => {
            switch (f.kind) {
                case "required":
                    return this.readTupleItem(
                        f.type,
                        `xs(${f.index})`,
                        tupleName,
                    );
                case "optional":
                    return [
                        `if xs.length > ${f.index} then scala.Some(`,
                        this.readTupleItem(f.type, `xs(${f.index})`, tupleName),
                        ") else scala.None",
                    ];
                case "rest":
                    return [
                        `xs.drop(${f.index}).map(x => `,
                        this.readTupleItem(f.type, "x", tupleName),
                        ").toSeq",
                    ];
            }
        };

        this.ensureBlankLine();
        this.emitLine(["object ", tupleName, ":"]);
        this.indent(() => {
            this.emitLine([
                "given OptionPickler.ReadWriter[",
                tupleName,
                "] = OptionPickler.readwriter[ujson.Value].bimap[",
                tupleName,
                "](",
            ]);
            this.indent(() => {
                if (gap === undefined) {
                    this.emitLine(["t => ujson.Arr.from(", ...written, "),"]);
                } else {
                    this.emitLine("t => {");
                    this.indent(() => {
                        this.emitLine(["if ", gap, " then"]);
                        this.indent(() =>
                            this.emitLine([
                                'throw new java.lang.IllegalArgumentException("',
                                tupleName,
                                ': an item follows a missing optional item")',
                            ]),
                        );
                        this.emitLine(["ujson.Arr.from(", ...written, ")"]);
                    });
                    this.emitLine("},");
                }
                this.emitLine("json => json match");
                this.indent(() => {
                    this.emitLine([
                        "case ujson.Arr(xs)",
                        lengthChecks.length === 0
                            ? ""
                            : ` if ${lengthChecks.join(" && ")}`,
                        " =>",
                    ]);
                    this.indent(() => {
                        this.emitLine([tupleName, "("]);
                        this.indent(() => {
                            fields.forEach((f, i) => {
                                this.emitLine([
                                    read(f),
                                    i === fields.length - 1 ? "" : ",",
                                ]);
                            });
                        });
                        this.emitLine(")");
                    });
                    this.emitLine([
                        'case _ => throw new upickle.core.Abort("',
                        tupleName,
                        `: expected ${this.expectedTupleLength(t)}")`,
                    ]);
                });
            });
            this.emitLine(")");
        });
        this.ensureBlankLine();
    }

    protected override emitUnionDefinition(
        u: UnionType,
        unionName: Name,
    ): void {
        this.emitDescription(this.descriptionForType(u));

        const [maybeNull, nonNulls] = removeNullFromUnion(u, false);
        const theTypes: Sourcelike[] = [];
        this.forEachUnionMember(u, nonNulls, "none", null, (_, t) => {
            theTypes.push(this.scalaType(t));
        });
        if (maybeNull !== null) {
            theTypes.push(this.nameForUnionMember(u, maybeNull));
        }

        this.emitItem(["type ", unionName, " = "]);
        theTypes.forEach((t, i) => {
            this.emitItem(i === 0 ? t : [" | ", t]);
        });
        const thisUnionType = theTypes
            .map((x) => this.sourcelikeToString(x))
            .join(" | ");

        this.ensureBlankLine();
        if (!this.seenUnionTypes.some((y) => y === thisUnionType)) {
            this.seenUnionTypes.push(thisUnionType);
            const sourceLikeTypes: Array<[Sourcelike, Type]> = [];
            this.forEachUnionMember(
                u,
                nonNulls,
                "none",
                unionMemberSortOrder,
                (_, t) => {
                    sourceLikeTypes.push([this.scalaType(t), t]);
                },
            );
            if (maybeNull !== null) {
                sourceLikeTypes.push([
                    this.nameForUnionMember(u, maybeNull),
                    maybeNull,
                ]);
            }

            this.ensureBlankLine();
            this.emitLine([
                "given unionReader",
                unionName,
                ": OptionPickler.Reader[",
                unionName,
                "] = JsonExt.badMerge[",
                unionName,
                "](",
            ]);
            this.indent(() => {
                sourceLikeTypes.forEach(([srcType, t]) => {
                    // Use the strict readers for primitive members --
                    // upickle's built-in ones accept too much (see the
                    // comment in the emitted JsonExt).
                    const strict = t.isPrimitive()
                        ? strictReaders[this.sourcelikeToString(srcType)]
                        : undefined;
                    if (strict === undefined) {
                        this.emitLine([
                            "summon[OptionPickler.Reader[",
                            srcType,
                            "]],",
                        ]);
                    } else {
                        this.emitLine([strict, ","]);
                    }
                });
                this.emitLine(")");
            });
            this.ensureBlankLine();
            this.emitLine([
                "given unionWriter",
                unionName,
                ": OptionPickler.Writer[",
                unionName,
                "] = OptionPickler.writer[ujson.Value].comap[",
                unionName,
                "]{ _v =>",
            ]);
            this.indent(() => {
                this.emitLine("(_v: @unchecked) match ");
                this.indent(() => {
                    sourceLikeTypes.forEach((t) => {
                        this.emitLine([
                            "case v: ",
                            t[0],
                            " => OptionPickler.writeJs[",
                            t[0],
                            "](v)",
                        ]);
                    });
                });
            });
            this.emitLine("}");
        }
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        this.ensureBlankLine();

        // Enum cases are styled Scala identifiers; the ReadWriter below
        // maps them back to the original JSON strings, which can be
        // anything (keywords, `"_"`, `""`, …).
        this.emitLine(["enum ", enumName, " : "]);
        this.indent(() => {
            this.forEachEnumCase(e, "none", (name) => {
                this.emitLine("case ", name);
            });
        });
        this.ensureBlankLine();

        this.emitLine([
            "given OptionPickler.ReadWriter[",
            enumName,
            "] = OptionPickler.readwriter[String].bimap[",
            enumName,
            "](",
        ]);
        this.indent(() => {
            this.emitLine("{");
            this.indent(() => {
                this.forEachEnumCase(e, "none", (name, jsonName) => {
                    this.emitLine([
                        "case ",
                        enumName,
                        ".",
                        name,
                        ` => "${stringEscape(jsonName)}"`,
                    ]);
                });
            });
            this.emitLine("},");
            this.emitLine("{");
            this.indent(() => {
                this.forEachEnumCase(e, "none", (name, jsonName) => {
                    this.emitLine([
                        `case "${stringEscape(jsonName)}" => `,
                        enumName,
                        ".",
                        name,
                    ]);
                });
                this.emitLine([
                    'case other => throw new upickle.core.Abort("invalid ',
                    enumName,
                    ': " + other)',
                ]);
            });
            this.emitLine("}");
        });
        this.emitLine(")");
        this.ensureBlankLine();
    }
}
