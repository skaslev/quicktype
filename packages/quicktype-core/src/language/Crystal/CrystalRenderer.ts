import { arrayIntercalate } from "collection-utils";

import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer.js";
import type { Name, Namer } from "../../Naming.js";
import { minMaxItemsForType } from "../../attributes/Constraints.js";
import { type Sourcelike, maybeAnnotated } from "../../Source.js";
import {
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";
import {
    ClassType,
    type EnumType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";

import { keywords } from "./constants.js";
import {
    camelNamingFunction,
    crystalStringEscape,
    snakeNamingFunction,
} from "./utils.js";

export class CrystalRenderer extends ConvenienceRenderer {
    protected makeNamedTypeNamer(): Namer {
        return camelNamingFunction;
    }

    protected namerForObjectProperty(): Namer | null {
        return snakeNamingFunction;
    }

    protected makeUnionMemberNamer(): Namer | null {
        return camelNamingFunction;
    }

    protected makeEnumCaseNamer(): Namer | null {
        return camelNamingFunction;
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        // `Present` holds optional tuple items that can be nil.
        const needsPresent = Array.from(
            this.typeGraph.allTypesUnordered(),
        ).some((t) => t instanceof TupleType && this.tupleNeedsPresent(t));
        return needsPresent ? [...keywords, "Present"] : keywords;
    }

    // Tuples are spelled out, `Tuple(A, B)`, unless the schema names them,
    // which makes them an alias, or they're classes.
    protected tupleNeedsName(t: TupleType): boolean {
        return this.hasGivenName(t) || this.tupleIsClass(t);
    }

    /**
     * Whether a tuple is a class with a field per item instead of a
     * `Tuple`.  `Tuple` reads and writes JSON arrays of exactly its length,
     * so tuples with optional items or a rest are classes.  So are tuples
     * that contain themselves other than through a class: `Tuple` would be
     * a recursive alias, which compiles but has no `new(pull)`.
     */
    private tupleIsClass(t: TupleType): boolean {
        return (
            !t.isFixedLength ||
            this.isInCycleThrough(t, (c) => !(c instanceof ClassType))
        );
    }

    protected forbiddenForObjectProperties(
        _c: ClassType,
        _className: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForUnionMembers(
        _u: UnionType,
        _unionName: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForEnumCases(
        _e: EnumType,
        _enumName: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    // A union's alias leaves out Nil, which references add back with `?`,
    // so a top-level union with null doesn't take the top-level name: the
    // top-level is an alias that adds the Nil, `alias TopLevel =
    // TopLevelUnion?`.  A union of null and a single type has no alias of
    // its own at all.
    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        if (
            type instanceof UnionType &&
            removeNullFromUnion(type)[0] !== null
        ) {
            return undefined;
        }

        return super.namedTypeToNameForTopLevel(type);
    }

    protected get commentLineStart(): string {
        return "# ";
    }

    private nullableCrystalType(t: Type, withIssues: boolean): Sourcelike {
        return [this.crystalType(t, withIssues), "?"];
    }

    protected isImplicitCycleBreaker(t: Type): boolean {
        const kind = t.kind;
        return kind === "array" || kind === "map";
    }

    private crystalType(t: Type, withIssues = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            (_anyType) =>
                maybeAnnotated(
                    withIssues,
                    anyTypeIssueAnnotation,
                    "JSON::Any?",
                ),
            (_nullType) =>
                maybeAnnotated(withIssues, nullTypeIssueAnnotation, "Nil"),
            (_boolType) => "Bool",
            (_integerType) => "Int64",
            (_doubleType) => "Float64",
            (_stringType) => "String",
            (arrayType) => [
                "Array(",
                this.crystalType(arrayType.items, withIssues),
                ")",
            ],
            (classType) => this.nameForNamedType(classType),
            (mapType) => [
                "Hash(String, ",
                this.crystalType(mapType.values, withIssues),
                ")",
            ],
            (enumType) => this.nameForNamedType(enumType),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);

                if (nullable !== null)
                    return this.nullableCrystalType(nullable, withIssues);

                const [hasNull] = removeNullFromUnion(unionType);

                const name = this.nameForNamedType(unionType);

                return hasNull !== null ? ([name, "?"] as Sourcelike) : name;
            },
            undefined,
            (tupleType) =>
                this.tupleNeedsName(tupleType)
                    ? this.nameForNamedType(tupleType)
                    : this.tupleSource(tupleType, withIssues),
        );
    }

    /** `Tuple(A, B)`. */
    private tupleSource(t: TupleType, withIssues = false): Sourcelike {
        return [
            "Tuple(",
            arrayIntercalate(
                ", ",
                t.items.map((item) => this.crystalType(item, withIssues)),
            ),
            ")",
        ];
    }

    /**
     * The type as an expression, for `T.new(pull)`: `T?` is a type only,
     * the expression is `Union(T, Nil)`.
     */
    private crystalTypeExpression(t: Type): Sourcelike {
        if (t.kind === "any") return "Union(JSON::Any, Nil)";
        if (t instanceof UnionType) {
            const nullable = nullableFromUnion(t);
            if (nullable !== null) {
                return ["Union(", this.crystalType(nullable), ", Nil)"];
            }

            const [hasNull] = removeNullFromUnion(t);
            if (hasNull !== null) {
                return ["Union(", this.nameForNamedType(t), ", Nil)"];
            }
        }

        return this.crystalType(t);
    }

    private breakCycle(t: Type, withIssues: boolean): Sourcelike {
        return this.crystalType(t, withIssues);
    }

    private emitRenameAttribute(propName: Name, jsonName: string): void {
        const escapedName = crystalStringEscape(jsonName);
        const namesDiffer = this.sourcelikeToString(propName) !== escapedName;
        if (namesDiffer) {
            this.emitLine('@[JSON::Field(key: "', escapedName, '")]');
        }
    }

    protected emitStructDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));

        const structBody = (): void =>
            this.forEachClassProperty(c, "none", (name, jsonName, prop) => {
                this.ensureBlankLine();
                this.emitDescription(
                    this.descriptionForClassProperty(c, jsonName),
                );
                this.emitRenameAttribute(name, jsonName);
                this.emitLine(
                    "property ",
                    name,
                    " : ",
                    this.crystalType(prop.type, true),
                );
            });

        this.emitBlock(["class ", className], structBody);
    }

    /**
     * Whether an optional item of a tuple can be nil.  Such an item is a
     * `Present`, which keeps a missing item (nil) apart from a null one
     * (`Present(nil)`).
     */
    private tupleItemNeedsPresent(t: TupleType, i: number): boolean {
        return i >= t.minItems && t.items[i].isNullable;
    }

    private tupleNeedsPresent(t: TupleType): boolean {
        return (
            this.tupleIsClass(t) &&
            t.items.some((_, i) => this.tupleItemNeedsPresent(t, i))
        );
    }

    /**
     * A property `itemN` per tuple item, and `rest` for the rest.  An
     * optional item is nil if it's missing.
     */
    private tupleFields(t: TupleType): Array<[string, Sourcelike]> {
        const fields = t.items.map((item, i): [string, Sourcelike] => {
            const type = this.crystalType(item, true);
            if (i < t.minItems) return [`item${i}`, type];
            if (this.tupleItemNeedsPresent(t, i)) {
                return [`item${i}`, ["Present(", type, ")?"]];
            }

            return [`item${i}`, this.nullableCrystalType(item, true)];
        });
        if (t.rest !== undefined) {
            fields.push([
                "rest",
                ["Array(", this.crystalType(t.rest, true), ")"],
            ]);
        }

        return fields;
    }

    protected emitTuple(t: TupleType, tupleName: Name): void {
        this.emitDescription(this.descriptionForType(t));
        if (!this.tupleIsClass(t)) {
            this.emitLine(
                "alias ",
                tupleName,
                " = ",
                this.tupleSource(t, true),
            );
            return;
        }

        const fields = this.tupleFields(t);
        this.emitLine("class ", tupleName);
        this.indent(() => {
            for (const [name, type] of fields) {
                this.emitLine("property ", name, " : ", type);
            }

            this.ensureBlankLine();
            this.emitLine(
                "def initialize(",
                arrayIntercalate(
                    ", ",
                    fields.map(
                        ([name, type]): Sourcelike => ["@", name, " : ", type],
                    ),
                ),
                ")",
            );
            this.emitLine("end");
            this.ensureBlankLine();
            this.emitTupleDecoder(t, tupleName);
            this.ensureBlankLine();
            this.emitTupleEncoder(t, tupleName);
        });
        this.emitLine("end");
    }

    /**
     * Reads the required items, the optional ones that are there, then the
     * rest.  A missing required item, a null element of a type that can't
     * be null, or an element after the last item without a rest, are
     * parse errors.
     */
    private emitTupleDecoder(t: TupleType, tupleName: Name): void {
        const [minConstraint, maxConstraint] = minMaxItemsForType(t) ?? [];
        this.emitLine("def self.new(pull : JSON::PullParser)");
        this.indent(() => {
            this.emitLine("pull.read_begin_array");
            t.items.forEach((item, i) => {
                const value = [this.crystalTypeExpression(item), ".new(pull)"];
                if (i < t.minItems) {
                    this.emitLine(`item${i} = `, value);
                } else if (this.tupleItemNeedsPresent(t, i)) {
                    this.emitLine(
                        `item${i} = pull.kind.end_array? ? nil : Present.new(`,
                        value,
                        ")",
                    );
                } else {
                    this.emitLine(
                        `item${i} = pull.kind.end_array? ? nil : `,
                        value,
                    );
                }
            });

            const rest = t.rest;
            if (rest !== undefined) {
                this.emitLine("rest = [] of ", this.crystalType(rest));
                this.emitLine("until pull.kind.end_array?");
                this.indent(() =>
                    this.emitLine(
                        "rest << ",
                        this.crystalTypeExpression(rest),
                        ".new(pull)",
                    ),
                );
                this.emitLine("end");
                // The rest's bounds, if the schema has them.
                const count = `${t.items.length} + rest.size`;
                const conditions: string[] = [];
                if (
                    minConstraint !== undefined &&
                    minConstraint > t.items.length
                ) {
                    conditions.push(`${count} < ${minConstraint}`);
                }

                if (maxConstraint !== undefined) {
                    conditions.push(`${count} > ${maxConstraint}`);
                }

                if (conditions.length > 0) {
                    const bounds =
                        maxConstraint === undefined
                            ? `at least ${minConstraint}`
                            : `${Math.max(t.minItems, minConstraint ?? 0)} to ${maxConstraint}`;
                    this.emitLine(
                        'pull.raise "Expected ',
                        bounds,
                        " elements for ",
                        tupleName,
                        '" if ',
                        conditions.join(" || "),
                    );
                }
            }

            this.emitLine("pull.read_end_array");
            this.emitLine(
                "new(",
                arrayIntercalate(
                    ", ",
                    this.tupleFields(t).map(([name]) => name),
                ),
                ")",
            );
        });
        this.emitLine("end");
    }

    /**
     * An item may only follow an optional item that is there: a JSON array
     * can't leave a gap.
     */
    private tupleGapCondition(t: TupleType): string | undefined {
        const conditions: string[] = [];
        for (let i = t.minItems + 1; i < t.items.length; i++) {
            conditions.push(`(@item${i - 1}.nil? && !@item${i}.nil?)`);
        }

        if (t.rest !== undefined && t.minItems < t.items.length) {
            conditions.push(
                `(@item${t.items.length - 1}.nil? && !@rest.empty?)`,
            );
        }

        if (conditions.length === 0) return undefined;
        if (conditions.length === 1) return conditions[0].slice(1, -1);
        return conditions.join(" || ");
    }

    /**
     * Writes the required items, the optional ones that are there, then
     * the rest.
     */
    private emitTupleEncoder(t: TupleType, tupleName: Name): void {
        this.emitLine("def to_json(json : JSON::Builder) : Nil");
        this.indent(() => {
            const gap = this.tupleGapCondition(t);
            if (gap !== undefined) {
                this.emitLine(
                    'raise ArgumentError.new("An item of ',
                    tupleName,
                    ' follows a missing optional item") if ',
                    gap,
                );
            }

            this.emitLine("json.array do");
            this.indent(() => {
                t.items.forEach((_, i) => {
                    if (i < t.minItems) {
                        this.emitLine(`@item${i}.to_json(json)`);
                    } else if (this.tupleItemNeedsPresent(t, i)) {
                        this.emitLine(`@item${i}.try &.value.to_json(json)`);
                    } else {
                        this.emitLine(`@item${i}.try &.to_json(json)`);
                    }
                });
                if (t.rest !== undefined) {
                    this.emitLine("@rest.each &.to_json(json)");
                }
            });
            this.emitLine("end");
        });
        this.emitLine("end");
    }

    protected emitPresent(): void {
        this.ensureBlankLine();
        this.emitMultiline(`# An optional tuple item that is there, even if it's nil.  A missing item
# is nil.
struct Present(T)
    getter value : T

    def initialize(@value : T)
    end
end`);
    }

    protected emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line);
        this.indent(() => {
            this.emitLine("include JSON::Serializable");
        });
        this.ensureBlankLine();
        this.indent(f);
        this.emitLine("end");
    }

    protected emitEnum(line: Sourcelike, f: () => void): void {
        this.emitLine(line);
        this.indent(f);
        this.emitLine("end");
    }

    /**
     * An enum with a member per case.  Crystal would read and write an
     * enum as its member names, so the enum reads and writes the JSON
     * values itself.  It says `::JSON` and no `Nil` because a member can
     * have those names.
     */
    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        const cases: Array<[Name, string]> = [];
        this.forEachEnumCase(e, "none", (name, jsonName) => {
            cases.push([name, crystalStringEscape(jsonName)]);
        });
        this.emitEnum(["enum ", enumName], () => {
            for (const [name] of cases) {
                this.emitLine(name);
            }

            this.ensureBlankLine();
            this.emitLine("def self.new(pull : ::JSON::PullParser)");
            this.indent(() => {
                this.emitLine("case value = pull.read_string");
                for (const [name, json] of cases) {
                    this.emitLine('when "', json, '" then ', name);
                }

                this.emitLine(
                    'else pull.raise "Unknown ',
                    enumName,
                    ' value: #{value.inspect}"',
                );
                this.emitLine("end");
            });
            this.emitLine("end");
            this.ensureBlankLine();
            this.emitLine("def to_json(json : ::JSON::Builder)");
            this.indent(() => {
                this.emitLine("json.string(");
                this.indent(() => {
                    this.emitLine("case self");
                    for (const [name, json] of cases) {
                        this.emitLine("in ", name, ' then "', json, '"');
                    }

                    this.emitLine("end");
                });
                this.emitLine(")");
            });
            this.emitLine("end");
        });
    }

    protected emitUnion(u: UnionType, unionName: Name): void {
        const isMaybeWithSingleType = nullableFromUnion(u);

        if (isMaybeWithSingleType !== null) {
            return;
        }

        this.emitDescription(this.descriptionForType(u));

        const [, nonNulls] = removeNullFromUnion(u);

        const types: Sourcelike[][] = [];
        this.forEachUnionMember(u, nonNulls, "none", null, (_name, t) => {
            const crystalType = this.breakCycle(t, true);
            types.push([crystalType]);
        });

        const members = types.map((r) =>
            r.map((sl) => this.sourcelikeToString(sl)).join(""),
        );
        if (this.isRecursiveUnion(u)) {
            this.emitRecursiveUnion(unionName, members);
            return;
        }

        this.emitLine(["alias ", unionName, " = ", members.join(" | ")]);
    }

    /**
     * A union that contains itself other than through a class is a struct
     * holding the value, as `JSON::Any` is.  Crystal compiles a recursive
     * alias but gives it no `new(pull)`, so it can't be read from JSON, and
     * its nilable references (`Array(R?)`) don't compile once they're read.
     */
    private emitRecursiveUnion(unionName: Name, members: string[]): void {
        const type = members.join(" | ");
        this.emitLine("struct ", unionName);
        this.indent(() => {
            this.emitLine("getter value : ", type);
            this.ensureBlankLine();
            this.emitLine("def initialize(@value : ", type, ")");
            this.emitLine("end");
            this.ensureBlankLine();
            this.emitLine("def self.new(pull : JSON::PullParser)");
            this.indent(() =>
                this.emitLine("new(Union(", members.join(", "), ").new(pull))"),
            );
            this.emitLine("end");
            this.ensureBlankLine();
            this.emitLine("def to_json(json : JSON::Builder) : Nil");
            this.indent(() => this.emitLine("@value.to_json(json)"));
            this.emitLine("end");
        });
        this.emitLine("end");
    }

    /**
     * Whether a union contains itself other than through a class, i.e.
     * whether its alias would refer to itself.  Tuples in such a cycle are
     * classes, too.
     */
    private isRecursiveUnion(u: UnionType): boolean {
        return this.isInCycleThrough(
            u,
            (c) =>
                !(c instanceof ClassType) &&
                !(c instanceof TupleType && this.tupleIsClass(c)),
        );
    }

    protected emitTopLevelAlias(t: Type, name: Name): void {
        this.emitLine("alias ", name, " = ", this.crystalType(t));
    }

    protected emitLeadingComments(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        }
    }

    protected emitSourceStructure(): void {
        this.emitLeadingComments();
        this.ensureBlankLine();
        this.emitLine('require "json"');

        this.forEachTopLevel(
            "leading",
            (t, name) => this.emitTopLevelAlias(t, name),
            (t) => this.namedTypeToNameForTopLevel(t) === undefined,
        );

        this.forEachObject(
            "leading-and-interposing",
            (c: ClassType, name: Name) => this.emitStructDefinition(c, name),
        );

        const tuples: Array<[TupleType, TupleType]> = [];
        const ignore = (): void => undefined;
        this.forEachNamedType("none", ignore, ignore, ignore, (t) =>
            tuples.push([t, t]),
        );
        this.forEachSpecificNamedType(
            "leading-and-interposing",
            tuples,
            (t, name) => this.emitTuple(t, name),
        );

        this.forEachEnum("leading-and-interposing", (e, name) =>
            this.emitEnumDefinition(e, name),
        );
        this.forEachUnion("leading-and-interposing", (u, name) =>
            this.emitUnion(u, name),
        );

        if (tuples.some(([t]) => this.tupleNeedsPresent(t))) {
            this.emitPresent();
        }
    }
}
