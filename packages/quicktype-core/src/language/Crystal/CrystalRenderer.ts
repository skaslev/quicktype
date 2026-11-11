import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer.js";
import type { Name, Namer } from "../../Naming.js";
import { type Sourcelike, maybeAnnotated } from "../../Source.js";
import {
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";
import {
    ClassType,
    type EnumType,
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
        return keywords;
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
            (_enumType) => "String",
            (unionType) => {
                const nullable = nullableFromUnion(unionType);

                if (nullable !== null)
                    return this.nullableCrystalType(nullable, withIssues);

                const [hasNull] = removeNullFromUnion(unionType);

                const name = this.nameForNamedType(unionType);

                return hasNull !== null ? ([name, "?"] as Sourcelike) : name;
            },
        );
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
     * whether its alias would refer to itself.
     */
    private isRecursiveUnion(u: UnionType): boolean {
        const seen = new Set<Type>();
        const work = Array.from(u.getNonAttributeChildren());
        for (let t = work.pop(); t !== undefined; t = work.pop()) {
            if (t === u) return true;
            if (seen.has(t) || t instanceof ClassType) continue;
            seen.add(t);
            work.push(...t.getNonAttributeChildren());
        }

        return false;
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
            (t) =>
                t.kind === "enum" ||
                this.namedTypeToNameForTopLevel(t) === undefined,
        );

        this.forEachObject(
            "leading-and-interposing",
            (c: ClassType, name: Name) => this.emitStructDefinition(c, name),
        );
        this.forEachUnion("leading-and-interposing", (u, name) =>
            this.emitUnion(u, name),
        );
    }
}
