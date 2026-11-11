import { iterableSome } from "collection-utils";

import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import { ConvenienceRenderer } from "../../ConvenienceRenderer.js";
import { DependencyName, Name, type Namer } from "../../Naming.js";
import type { RenderContext } from "../../Renderer.js";
import type { OptionValues } from "../../RendererOptions/index.js";
import { type Sourcelike, maybeAnnotated, modifySource } from "../../Source.js";
import { camelCase, stringEscape } from "../../support/Strings.js";
import { assert, defined } from "../../support/Support.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    type ClassProperty,
    ClassType,
    type EnumType,
    TupleType,
    type Type,
    type TypeKind,
    UnionType,
} from "../../Type/index.js";
import {
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";

import type { goOptions } from "./language.js";
import {
    canOmitEmpty,
    compoundTypeKinds,
    isValueType,
    namingFunction,
    primitiveValueTypeKinds,
} from "./utils.js";

export class GoRenderer extends ConvenienceRenderer {
    private readonly _topLevelUnmarshalNames = new Map<Name, Name>();

    private readonly _topLevelMarshalNames = new Map<Name, Name>();

    private _currentFilename: string | undefined;

    private _namedTopLevelNames: ReadonlySet<Name> | undefined;

    // The top-level whose type the current file is for, in multi-file output,
    // until `emitPackageDefinitons` has emitted its comments and functions.
    private _currentFileTopLevel: Name | undefined;

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof goOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected makeNamedTypeNamer(): Namer {
        return namingFunction;
    }

    protected namerForObjectProperty(): Namer {
        return namingFunction;
    }

    protected makeUnionMemberNamer(): Namer {
        return namingFunction;
    }

    protected forbiddenForUnionMembers() {
        return {
            names:
                this._options.justTypes || this._options.justTypesAndPackage
                    ? []
                    : ["MarshalJSON", "UnmarshalJSON"],
            includeGlobalForbidden: false,
        };
    }

    // Go has no tuple types: every tuple is a struct with a field per item.
    protected tupleNeedsName(_t: TupleType): boolean {
        return true;
    }

    protected makeEnumCaseNamer(): Namer {
        return namingFunction;
    }

    protected get enumCasesInGlobalNamespace(): boolean {
        return true;
    }

    protected makeNameForEnumCase(
        e: EnumType,
        enumName: Name,
        caseName: string,
        assignedName: string | undefined,
    ): Name {
        const name = super.makeNameForEnumCase(
            e,
            enumName,
            caseName,
            assignedName,
        );
        if (!this._options.enumTypeNameSuffix) return name;

        const proposedName = name.namingFunction.nameStyle(
            name.firstProposedName(new Map()),
        );
        return new DependencyName(
            name.namingFunction,
            name.order,
            (lookup) => `${proposedName}_${lookup(enumName)}`,
        );
    }

    protected makeTopLevelDependencyNames(
        _: Type,
        topLevelName: Name,
    ): DependencyName[] {
        const unmarshalName = new DependencyName(
            namingFunction,
            topLevelName.order,
            (lookup) => `unmarshal_${lookup(topLevelName)}`,
        );
        this._topLevelUnmarshalNames.set(topLevelName, unmarshalName);
        // Only used when the top-level is a named pointer type (nullable
        // top-level), which Go doesn't allow as a method receiver.
        const marshalName = new DependencyName(
            namingFunction,
            topLevelName.order,
            (lookup) => `marshal_${lookup(topLevelName)}`,
        );
        this._topLevelMarshalNames.set(topLevelName, marshalName);
        return [unmarshalName, marshalName];
    }

    /// startFile takes a file name, lowercases it, appends ".go" to it, and sets it as the current filename.
    protected startFile(basename: Sourcelike): void {
        if (this._options.multiFileOutput === false) {
            return;
        }

        assert(
            this._currentFilename === undefined,
            `Previous file wasn't finished: ${this._currentFilename}`,
        );
        this._currentFilename = `${this.sourcelikeToString(basename)}.go`;
        this.initializeEmitContextForFilename(this._currentFilename);
        this._currentFileTopLevel =
            basename instanceof Name &&
            !this._options.justTypes &&
            !this._options.justTypesAndPackage &&
            this.namedTopLevelNames.has(basename)
                ? basename
                : undefined;
    }

    // The top-levels that are classes, enums or unions, which have the names
    // of their types.  In multi-file output, such a top-level is in its
    // type's file, which would otherwise be written twice, the second time
    // with the type's own imports after the top-level's functions.
    private get namedTopLevelNames(): ReadonlySet<Name> {
        if (this._namedTopLevelNames === undefined) {
            const names = new Set<Name>();
            this.forEachTopLevel("none", (t, name) => {
                if (this.namedTypeToNameForTopLevel(t) !== undefined) {
                    names.add(name);
                }
            });
            this._namedTopLevelNames = names;
        }

        return this._namedTopLevelNames;
    }

    /// endFile pushes the current file name onto the collection of finished files and then resets the current file name. These finished files are used in index.ts to write the output.
    protected endFile(): void {
        if (this._options.multiFileOutput === false) {
            return;
        }

        this.finishFile(defined(this._currentFilename));
        this._currentFilename = undefined;
    }

    private emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("}");
    }

    private emitFunc(decl: Sourcelike, f: () => void): void {
        this.emitBlock(["func ", decl], f);
    }

    private emitStruct(name: Name, table: Sourcelike[][]): void {
        this.emitBlock(["type ", name, " struct"], () => this.emitTable(table));
    }

    private nullableGoType(t: Type, withIssues: boolean): Sourcelike {
        const goType = this.goType(t, withIssues);
        if (isValueType(t)) {
            return ["*", goType];
        }

        return goType;
    }

    private propertyGoType(cp: ClassProperty): Sourcelike {
        const t = cp.type;
        if (cp.isOptional && (t.kind === "array" || t.kind === "map")) {
            return ["*", this.goType(t, true)];
        }

        if (t instanceof UnionType && nullableFromUnion(t) === null) {
            return ["*", this.goType(t, true)];
        }

        if (cp.isOptional) {
            return this.nullableGoType(t, true);
        }

        return this.goType(t, true);
    }

    private goType(t: Type, withIssues = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            (_anyType) =>
                maybeAnnotated(
                    withIssues,
                    anyTypeIssueAnnotation,
                    "interface{}",
                ),
            (_nullType) =>
                maybeAnnotated(
                    withIssues,
                    nullTypeIssueAnnotation,
                    "interface{}",
                ),
            (_boolType) => "bool",
            (_integerType) => "int64",
            (_doubleType) => "float64",
            (_stringType) => "string",
            (arrayType) => ["[]", this.goType(arrayType.items, withIssues)],
            (classType) => this.nameForNamedType(classType),
            (mapType) => {
                let valueSource: Sourcelike;
                const v = mapType.values;
                if (v instanceof UnionType && nullableFromUnion(v) === null) {
                    valueSource = ["*", this.nameForNamedType(v)];
                } else {
                    valueSource = this.goType(v, withIssues);
                }

                return ["map[string]", valueSource];
            },
            (enumType) => this.nameForNamedType(enumType),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null)
                    return this.nullableGoType(nullable, withIssues);
                return this.nameForNamedType(unionType);
            },
            (transformedStringType) => {
                if (transformedStringType.kind === "date-time") {
                    return "time.Time";
                }

                return "string";
            },
            (tupleType) => this.nameForNamedType(tupleType),
        );
    }

    private emitTopLevel(t: Type, name: Name): void {
        // In multi-file output, a top-level that is a named type is in the
        // type's file, see `startFile`.
        if (
            this._options.multiFileOutput &&
            this.namedTypeToNameForTopLevel(t) !== undefined
        ) {
            return;
        }

        this.startFile(name);

        if (
            this._options.multiFileOutput &&
            this._options.justTypes === false &&
            this._options.justTypesAndPackage === false
        ) {
            this.emitTopLevelComments(name);
        }

        const imports =
            t instanceof ClassType
                ? this.collectClassImports(t)
                : t instanceof UnionType && this.unionNeedsName(t)
                  ? this.collectUnionImports(t)
                  : t instanceof TupleType
                    ? this.collectTupleImports(t)
                    : this.collectAliasImports(t);
        this.emitPackageDefinitons(true, imports);

        let isPointerAlias = false;
        if (this.namedTypeToNameForTopLevel(t) === undefined) {
            const goType = this.goType(t);
            isPointerAlias = this.sourcelikeToString(goType).startsWith("*");
            this.emitLine("type ", name, " ", goType);
        }

        if (this._options.justTypes || this._options.justTypesAndPackage) {
            this.endFile();
            return;
        }

        this.emitTopLevelFunctions(name, isPointerAlias);
        this.endFile();
    }

    // The comments at the start of a top-level's file in multi-file output.
    private emitTopLevelComments(name: Name): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
            return;
        }

        this.emitLineOnce(
            "// Code generated from JSON Schema using quicktype. DO NOT EDIT.",
        );
        this.emitLineOnce(
            "// To parse and unparse this JSON data, add this code to your project and do:",
        );
        this.emitLineOnce("//");
        const ref = modifySource(camelCase, name);
        this.emitLineOnce(
            "//    ",
            ref,
            ", err := ",
            defined(this._topLevelUnmarshalNames.get(name)),
            "(bytes)",
        );
        this.emitLineOnce("//    bytes, err = ", ref, ".Marshal()");
    }

    // A pointer alias (a nullable top-level) can't be a method receiver, so
    // it gets a function `MarshalName` instead of the `Marshal` method.
    private emitTopLevelFunctions(name: Name, isPointerAlias = false): void {
        const unmarshalName = defined(this._topLevelUnmarshalNames.get(name));
        this.ensureBlankLine();
        this.emitFunc(
            [unmarshalName, "(data []byte) (", name, ", error)"],
            () => {
                this.emitLine("var r ", name);
                this.emitLine("err := json.Unmarshal(data, &r)");
                this.emitLine("return r, err");
            },
        );
        this.ensureBlankLine();
        if (isPointerAlias) {
            this.emitFunc(
                [
                    defined(this._topLevelMarshalNames.get(name)),
                    "(r ",
                    name,
                    ") ([]byte, error)",
                ],
                () => {
                    this.emitLine("return json.Marshal(r)");
                },
            );
        } else {
            this.emitFunc(["(r *", name, ") Marshal() ([]byte, error)"], () => {
                this.emitLine("return json.Marshal(r)");
            });
        }
    }

    private emitClass(c: ClassType, className: Name): void {
        this.startFile(className);
        const columns: Sourcelike[][] = [];
        this.forEachClassProperty(c, "none", (name, jsonName, p) => {
            const description = this.descriptionForClassProperty(c, jsonName);
            const docStrings =
                description !== undefined && description.length > 0
                    ? description.map((d) => `// ${d}`)
                    : [];
            const goType = this.propertyGoType(p);
            const omitEmpty = canOmitEmpty(p, this._options.omitEmpty)
                ? ",omitempty"
                : [];

            docStrings.forEach((doc) => {
                columns.push([doc]);
            });
            const tags = this._options.fieldTags
                .split(",")
                .map((tag) => `${tag}:"${stringEscape(jsonName)}${omitEmpty}"`)
                .join(" ");
            columns.push([
                [name, " "],
                [goType, " "],
                ["`", tags, "`"],
            ]);
        });

        this.emitPackageDefinitons(false, this.collectClassImports(c));
        this.emitDescription(this.descriptionForType(c));
        this.emitStruct(className, columns);
        this.endFile();
    }

    private get justTypes(): boolean {
        return this._options.justTypes || this._options.justTypesAndPackage;
    }

    private get haveTuples(): boolean {
        return iterableSome(
            this.typeGraph.allTypesUnordered(),
            (t) => t instanceof TupleType,
        );
    }

    private forEachTuple(
        blankLocations: "leading-and-interposing" | "none",
        f: (t: TupleType, tupleName: Name) => void,
    ): void {
        const tuples: Array<[TupleType, TupleType]> = [];
        this.forEachDeclaration("none", (decl) => {
            if (decl.kind === "define" && decl.type instanceof TupleType) {
                tuples.push([decl.type, decl.type]);
            }
        });
        this.forEachSpecificNamedType(blankLocations, tuples, f);
    }

    // The type of a required item is that of a required property, except
    // that a union is a value, not a pointer: the tuple's methods always
    // pass the field's address.  An optional item is a pointer to that, nil
    // if the item is missing, which keeps a missing item apart from a null
    // one (`**T`).
    private tupleItemGoType(t: Type, optional: boolean): Sourcelike {
        const goType = this.goType(t, true);
        return optional ? ["*", goType] : goType;
    }

    private tupleColumns(t: TupleType): Sourcelike[][] {
        const columns: Sourcelike[][] = t.items.map((item, i) => [
            [`Item${i}`, " "],
            this.tupleItemGoType(item, i >= t.minItems),
        ]);
        if (t.rest !== undefined) {
            columns.push([
                ["Rest", " "],
                ["[]", this.goType(t.rest, true)],
            ]);
        }

        return columns;
    }

    // An item may only follow an optional one that is present: JSON can't
    // leave a gap.  Moving later items into it, or writing null there, would
    // write a different value.
    private tupleGapCondition(t: TupleType): string | undefined {
        const conditions: string[] = [];
        for (let i = t.minItems + 1; i < t.items.length; i++) {
            conditions.push(`x.Item${i - 1} == nil && x.Item${i} != nil`);
        }

        if (t.rest !== undefined && t.minItems < t.items.length) {
            conditions.push(
                `x.Item${t.items.length - 1} == nil && len(x.Rest) > 0`,
            );
        }

        if (conditions.length <= 1) return conditions[0];
        return conditions.map((c) => `(${c})`).join(" || ");
    }

    // A tuple is a struct with a field `ItemN` per item and a slice `Rest`
    // for the rest.  Its methods read and write a JSON array: the required
    // items, the optional ones that are present, then the rest.
    private emitTuple(t: TupleType, tupleName: Name): void {
        this.startFile(tupleName);
        const gap = this.tupleGapCondition(t);
        this.emitPackageDefinitons(true, this.collectTupleImports(t));
        this.emitDescription(this.descriptionForType(t));
        this.emitStruct(tupleName, this.tupleColumns(t));
        if (!this.justTypes) {
            this.ensureBlankLine();
            this.emitTupleUnmarshal(t, tupleName);
            this.ensureBlankLine();
            this.emitTupleMarshal(t, tupleName, gap);
        }

        this.endFile();
    }

    private emitTupleUnmarshal(t: TupleType, tupleName: Name): void {
        const decode = (item: Type, raw: string, target: string): void =>
            this.emitBlock(
                [
                    "if err = unmarshalTupleItem(",
                    raw,
                    ", ",
                    target,
                    ", ",
                    item.isNullable ? "true" : "false",
                    "); err != nil",
                ],
                () => this.emitLine("return err"),
            );
        const maxItems =
            t.rest === undefined ? t.items.length.toString() : "-1";
        this.emitFunc(
            ["(x *", tupleName, ") UnmarshalJSON(data []byte) error"],
            () => {
                this.emitLine(
                    "items, err := unmarshalTuple(data, ",
                    t.minItems.toString(),
                    ", ",
                    maxItems,
                    ")",
                );
                this.emitBlock("if err != nil", () =>
                    this.emitLine("return err"),
                );
                this.emitLine("*x = ", tupleName, "{}");
                t.items.forEach((item, i) => {
                    if (i < t.minItems) {
                        decode(item, `items[${i}]`, `&x.Item${i}`);
                        return;
                    }

                    this.emitBlock(`if len(items) > ${i}`, () => {
                        this.emitLine(
                            `x.Item${i} = new(`,
                            this.goType(item, true),
                            ")",
                        );
                        decode(item, `items[${i}]`, `x.Item${i}`);
                    });
                });
                const rest = t.rest;
                if (rest !== undefined) {
                    // Optional items may be missing, so the rest may start
                    // after the end of the array.
                    this.emitBlock(
                        `for i := ${t.items.length}; i < len(items); i++`,
                        () => {
                            this.emitLine("var v ", this.goType(rest, true));
                            decode(rest, "items[i]", "&v");
                            this.emitLine("x.Rest = append(x.Rest, v)");
                        },
                    );
                }

                this.emitLine("return nil");
            },
        );
    }

    // A value receiver, so that tuples marshal as values, too, e.g. in maps.
    private emitTupleMarshal(
        t: TupleType,
        tupleName: Name,
        gap: string | undefined,
    ): void {
        this.emitFunc(
            ["(x ", tupleName, ") MarshalJSON() ([]byte, error)"],
            () => {
                if (gap !== undefined) {
                    this.emitBlock(["if ", gap], () =>
                        this.emitLine(
                            'return nil, errors.New("',
                            tupleName,
                            ': an item follows a missing optional item")',
                        ),
                    );
                }

                const required = t.items
                    .slice(0, t.minItems)
                    .map((_, i) => `&x.Item${i}`);
                this.emitLine(
                    "items := []interface{}{",
                    required.join(", "),
                    "}",
                );
                for (let i = t.minItems; i < t.items.length; i++) {
                    this.emitBlock(`if x.Item${i} != nil`, () =>
                        this.emitLine(`items = append(items, x.Item${i})`),
                    );
                }

                if (t.rest !== undefined) {
                    this.emitBlock("for i := range x.Rest", () =>
                        this.emitLine("items = append(items, &x.Rest[i])"),
                    );
                }

                this.emitLine("return json.Marshal(items)");
            },
        );
    }

    private emitEnum(e: EnumType, enumName: Name): void {
        // An enum in a union has no methods, so its file in multi-file
        // output needs no encoding/json.
        const allTypes = Array.from(this.typeGraph.allTypesUnordered());
        const inUnion = allTypes.some(
            (t) =>
                t instanceof UnionType &&
                nullableFromUnion(t) === null &&
                t.getChildren().has(e),
        );
        this.startFile(enumName);
        this.emitPackageDefinitons(!inUnion);
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("type ", enumName, " string");
        this.ensureBlankLine();
        this.emitLine("const (");
        const columns: Sourcelike[][] = [];
        const cases: string[] = [];
        this.forEachEnumCase(e, "none", (name, jsonName) => {
            cases.push(this.sourcelikeToString(name));
            columns.push([
                [name, " "],
                [enumName, ' = "', stringEscape(jsonName), '"'],
            ]);
        });
        this.indent(() => this.emitTable(columns));
        this.emitLine(")");
        const type = this.sourcelikeToString(enumName);
        // Plain types have no methods, and no encoding/json import for them.
        if (
            this._options.justTypes ||
            this._options.justTypesAndPackage ||
            inUnion
        ) {
            this.endFile();
            return;
        }
        this.ensureBlankLine();
        this.emitMultiline(`type invalid${type} string
func (x invalid${type}) Error() string { return "invalid ${type}: " + string(x) }

func (x *${type}) UnmarshalJSON(data []byte) error {
    var value string
    if err := json.Unmarshal(data, &value); err != nil { return err }
    switch ${type}(value) {
    case ${cases.join(", ")}: *x = ${type}(value); return nil
    }
    return invalid${type}(value)
}`);
        this.endFile();
    }

    // The classes of a union with several, which its `UnmarshalJSON` tries in
    // turn, in that order.  A class only takes an object with all its
    // required properties, no unknown ones, and null only for nullable
    // ones, so two classes only take the same object if it is valid for
    // both, as with an `anyOf`, or if it is invalid only in a way that isn't
    // checked, such as an unknown key in a nested object.  The class that
    // requires more of the object's properties is the more specific type
    // then, so classes with more required properties are tried first, and
    // others in the order of the union.
    private unionClassesInTryOrder(u: UnionType): ClassType[] | undefined {
        const classes = Array.from(u.members).filter(
            (t): t is ClassType => t instanceof ClassType,
        );
        if (classes.length < 2) return undefined;

        const requiredCount = (c: ClassType): number =>
            Array.from(c.getProperties().values()).filter((p) => !p.isOptional)
                .length;
        return classes.sort((a, b) => requiredCount(b) - requiredCount(a));
    }

    private get haveUnionsWithClasses(): boolean {
        return iterableSome(
            this.namedUnions,
            (u) => this.unionClassesInTryOrder(u) !== undefined,
        );
    }

    // The arguments of `unmarshalClass` that describe the properties of `c`.
    private unmarshalClassArgs(c: ClassType): Sourcelike {
        const required: string[] = [];
        const optional: string[] = [];
        const nullable: string[] = [];
        for (const [jsonName, p] of c.getProperties()) {
            const literal = `"${stringEscape(jsonName)}"`;
            (p.isOptional ? optional : required).push(literal);
            if (p.type.isNullable) nullable.push(literal);
        }

        const list = (names: string[]): string =>
            names.length === 0 ? "nil" : `[]string{${names.join(", ")}}`;
        return [list(required), ", ", list(optional), ", ", list(nullable)];
    }

    private emitUnion(u: UnionType, unionName: Name): void {
        this.startFile(unionName);
        const classes = this.unionClassesInTryOrder(u);
        const [hasNull, nonNulls] = removeNullFromUnion(u);
        const tuples: Array<[Name, TupleType]> = [];
        this.forEachUnionMember(u, nonNulls, "none", null, (fieldName, t) => {
            if (t instanceof TupleType) tuples.push([fieldName, t]);
        });
        const imports = this.collectUnionImports(u);
        if (!this.justTypes) {
            if (classes !== undefined) {
                imports.add("encoding/json");
                imports.add("errors");
            }

            if (tuples.length > 0) {
                imports.add("encoding/json");
                if (this.unionArrayError(u, tuples)) imports.add("errors");
            }
        }

        this.emitPackageDefinitons(false, imports);
        const isNullableArg = hasNull !== null ? "true" : "false";

        const ifMember: <T, U>(
            kind: TypeKind,
            ifNotMember: U,
            f: (t: Type, fieldName: Name, goType: Sourcelike) => T,
        ) => T | U = (kind, ifNotMember, f) => {
            const maybeType = u.findMember(kind);
            if (maybeType === undefined) return ifNotMember;
            return f(
                maybeType,
                this.nameForUnionMember(u, maybeType),
                this.goType(maybeType),
            );
        };

        const maybeAssignNil = (kind: TypeKind): void => {
            ifMember(kind, undefined, (_1, fieldName, _2) => {
                this.emitLine("x.", fieldName, " = nil");
            });
        };

        const makeArgs = (
            primitiveArg: (fieldName: Sourcelike) => Sourcelike,
            compoundArg: (
                isClass: boolean,
                fieldName: Sourcelike,
            ) => Sourcelike,
            arrayArg?: Sourcelike,
        ): Sourcelike => {
            const args: Sourcelike = [];
            for (const kind of primitiveValueTypeKinds) {
                args.push(
                    ifMember(kind, "nil", (_1, fieldName, _2) =>
                        primitiveArg(fieldName),
                    ),
                    ", ",
                );
            }

            for (const kind of compoundTypeKinds) {
                if (kind === "array" && arrayArg !== undefined) {
                    args.push(arrayArg, ", ");
                    continue;
                }

                args.push(
                    ifMember(kind, "false, nil", (t, fieldName, _) =>
                        compoundArg(t.kind === "class", fieldName),
                    ),
                    ", ",
                );
            }

            args.push(isNullableArg);
            return args;
        };

        const columns: Sourcelike[][] = [];
        this.forEachUnionMember(u, nonNulls, "none", null, (fieldName, t) => {
            const goType = this.nullableGoType(t, true);
            columns.push([[fieldName, " "], goType]);
        });
        this.emitDescription(this.descriptionForType(u));
        this.emitStruct(unionName, columns);

        if (this._options.justTypes || this._options.justTypesAndPackage) {
            this.endFile();
            return;
        }

        this.ensureBlankLine();
        if (classes !== undefined) {
            this.emitUnionWithClassesFunctions(
                u,
                unionName,
                classes,
                tuples,
                makeArgs,
            );
            this.endFile();
            return;
        }

        this.emitFunc(
            ["(x *", unionName, ") UnmarshalJSON(data []byte) error"],
            () => {
                for (const kind of compoundTypeKinds) {
                    maybeAssignNil(kind);
                }

                for (const [fieldName] of tuples) {
                    this.emitLine("x.", fieldName, " = nil");
                }

                ifMember("class", undefined, (_1, _2, goType) => {
                    this.emitLine("var c ", goType);
                });
                // Tuples are JSON arrays, too: an array is captured to be
                // decoded here.
                if (tuples.length > 0) {
                    this.emitLine("var array json.RawMessage");
                }

                const args = makeArgs(
                    (fn) => ["&x.", fn],
                    (isClass, fn) => (isClass ? "true, &c" : ["true, &x.", fn]),
                    tuples.length > 0 ? "true, &array" : undefined,
                );
                this.emitLine(
                    "object, err := unmarshalUnion(data, ",
                    args,
                    ")",
                );
                this.emitBlock("if err != nil", () => {
                    this.emitLine("return err");
                });
                this.emitBlock("if object", () => {
                    ifMember("class", undefined, (_1, fieldName, _2) => {
                        this.emitLine("x.", fieldName, " = &c");
                    });
                });
                if (tuples.length > 0) {
                    this.emitBlock("if array != nil", () =>
                        this.emitUnionArrayDecoding(u, tuples),
                    );
                }

                this.emitLine("return nil");
            },
        );
        this.ensureBlankLine();
        // A value receiver, as time.Time has, so that union values marshal
        // with it, too, not only pointers and addressable values.
        this.emitFunc(
            ["(x ", unionName, ") MarshalJSON() ([]byte, error)"],
            () => {
                for (const [fieldName] of tuples) {
                    this.emitBlock(["if x.", fieldName, " != nil"], () =>
                        this.emitLine("return json.Marshal(x.", fieldName, ")"),
                    );
                }

                const args = makeArgs(
                    (fn) => ["x.", fn],
                    (_, fn) => ["x.", fn, " != nil, x.", fn],
                );
                this.emitLine("return marshalUnion(", args, ")");
            },
        );
        this.endFile();
    }

    // `unmarshalUnion` and `marshalUnion` handle a single class.  For a union
    // with several, the former only tells whether the value is an object,
    // which is then decoded into the first class that takes it, see
    // `unionClassesInTryOrder`, and the latter handles everything but the
    // classes.
    private emitUnionWithClassesFunctions(
        u: UnionType,
        unionName: Name,
        classes: readonly ClassType[],
        tuples: Array<[Name, TupleType]>,
        makeArgs: (
            primitiveArg: (fieldName: Sourcelike) => Sourcelike,
            compoundArg: (
                isClass: boolean,
                fieldName: Sourcelike,
            ) => Sourcelike,
            arrayArg?: Sourcelike,
        ) => Sourcelike,
    ): void {
        this.emitFunc(
            ["(x *", unionName, ") UnmarshalJSON(data []byte) error"],
            () => {
                for (const kind of compoundTypeKinds) {
                    for (const t of u.members) {
                        if (t.kind !== kind) continue;
                        this.emitLine(
                            "x.",
                            this.nameForUnionMember(u, t),
                            " = nil",
                        );
                    }
                }

                for (const [fieldName] of tuples) {
                    this.emitLine("x.", fieldName, " = nil");
                }

                // Tuples are JSON arrays, too: an array is captured to be
                // decoded here.
                if (tuples.length > 0) {
                    this.emitLine("var array json.RawMessage");
                }

                const args = makeArgs(
                    (fn) => ["&x.", fn],
                    (isClass, fn) =>
                        isClass
                            ? "true, new(json.RawMessage)"
                            : ["true, &x.", fn],
                    tuples.length > 0 ? "true, &array" : undefined,
                );
                this.emitLine(
                    "object, err := unmarshalUnion(data, ",
                    args,
                    ")",
                );
                this.emitBlock("if err != nil", () => {
                    this.emitLine("return err");
                });
                this.emitBlock("if object", () => {
                    for (const c of classes) {
                        this.emitBlock(
                            [
                                "if c := new(",
                                this.goType(c),
                                "); unmarshalClass(data, c, ",
                                this.unmarshalClassArgs(c),
                                ")",
                            ],
                            () => {
                                this.emitLine(
                                    "x.",
                                    this.nameForUnionMember(u, c),
                                    " = c",
                                );
                                this.emitLine("return nil");
                            },
                        );
                    }

                    this.emitLine(
                        'return errors.New("Object does not match any class of the union")',
                    );
                });
                if (tuples.length > 0) {
                    this.emitBlock("if array != nil", () =>
                        this.emitUnionArrayDecoding(u, tuples),
                    );
                }

                this.emitLine("return nil");
            },
        );
        this.ensureBlankLine();
        // A value receiver, as in `emitUnion`.
        this.emitFunc(
            ["(x ", unionName, ") MarshalJSON() ([]byte, error)"],
            () => {
                for (const [fieldName] of tuples) {
                    this.emitBlock(["if x.", fieldName, " != nil"], () =>
                        this.emitLine("return json.Marshal(x.", fieldName, ")"),
                    );
                }

                this.forEachUnionMember(
                    u,
                    new Set(classes),
                    "none",
                    null,
                    (fieldName) => {
                        this.emitBlock(["if x.", fieldName, " != nil"], () => {
                            this.emitLine(
                                "return json.Marshal(x.",
                                fieldName,
                                ")",
                            );
                        });
                    },
                );
                const args = makeArgs(
                    (fn) => ["x.", fn],
                    (isClass, fn) =>
                        isClass ? "false, nil" : ["x.", fn, " != nil, x.", fn],
                );
                this.emitLine("return marshalUnion(", args, ")");
            },
        );
    }

    // Whether an array that matches none of the union's tuples is an error
    // of its own: the union has several tuples and no array.
    private unionArrayError(
        u: UnionType,
        tuples: Array<[Name, TupleType]>,
    ): boolean {
        return tuples.length > 1 && u.findMember("array") === undefined;
    }

    // The union's tuples are tried in turn, then its array, if any.  Each
    // tuple checks its length and the types of its items, so an array
    // decodes as the first tuple it fits.  The array, or a single tuple, is
    // decoded directly, so that a mismatch reports its own error.
    private emitUnionArrayDecoding(
        u: UnionType,
        tuples: Array<[Name, TupleType]>,
    ): void {
        const arrayMember = u.findMember("array");
        const candidates: Array<[Name, Type]> = [...tuples];
        if (arrayMember !== undefined) {
            candidates.push([
                this.nameForUnionMember(u, arrayMember),
                arrayMember,
            ]);
        }

        const last = this.unionArrayError(u, tuples)
            ? undefined
            : defined(candidates.pop());
        for (const [fieldName, t] of candidates) {
            this.emitBlock(
                [
                    "if t := new(",
                    this.goType(t),
                    "); json.Unmarshal(array, t) == nil",
                ],
                () => {
                    this.emitLine("x.", fieldName, " = t");
                    this.emitLine("return nil");
                },
            );
        }

        if (last === undefined) {
            this.emitLine(
                'return errors.New("Array does not match any tuple of the union")',
            );
            return;
        }

        const [lastName, lastType] = last;
        if (lastType instanceof TupleType) {
            this.emitLine(
                "x.",
                lastName,
                " = new(",
                this.goType(lastType),
                ")",
            );
            this.emitLine("return json.Unmarshal(array, x.", lastName, ")");
        } else {
            this.emitLine("return json.Unmarshal(array, &x.", lastName, ")");
        }
    }

    private emitSingleFileHeaderComments(): void {
        this.emitLineOnce(
            "// Code generated from JSON Schema using quicktype. DO NOT EDIT.",
        );
        this.emitLineOnce(
            "// To parse and unparse this JSON data, add this code to your project and do:",
        );
        this.forEachTopLevel("none", (_: Type, name: Name) => {
            this.emitLine("//");
            const ref = modifySource(camelCase, name);
            this.emitLine(
                "//    ",
                ref,
                ", err := ",
                defined(this._topLevelUnmarshalNames.get(name)),
                "(bytes)",
            );
            this.emitLine("//    bytes, err = ", ref, ".Marshal()");
        });
    }

    private emitPackageDefinitons(
        includeJSONEncodingImport: boolean,
        imports: Set<string> = new Set<string>(),
    ): void {
        // The file of a top-level's type in multi-file output, see
        // `startFile`, starts with the top-level's comments, and its
        // functions follow the imports.
        const topLevel = this._currentFileTopLevel;
        this._currentFileTopLevel = undefined;
        if (topLevel !== undefined) {
            this.emitTopLevelComments(topLevel);
        }

        if (!this._options.justTypes || this._options.justTypesAndPackage) {
            this.ensureBlankLine();
            const packageDeclaration = `package ${this._options.packageName}`;
            this.emitLineOnce(packageDeclaration);
            this.ensureBlankLine();
        }

        if (!this._options.justTypes && !this._options.justTypesAndPackage) {
            if (
                this.haveNamedUnions &&
                this._options.multiFileOutput === false
            ) {
                imports.add("bytes");
                imports.add("errors");
            }

            if (this.haveTuples && this._options.multiFileOutput === false) {
                imports.add("errors");
                imports.add("fmt");
            }

            if (includeJSONEncodingImport || topLevel !== undefined) {
                imports.add("encoding/json");
            }
        }

        this.emitImports(imports);
        if (topLevel !== undefined) {
            this.emitTopLevelFunctions(topLevel);
            this.ensureBlankLine();
        }
    }

    private emitImports(imports: Set<string>): void {
        const sortedImports = Array.from(imports).sort((a, b) =>
            a.localeCompare(b),
        );

        if (sortedImports.length === 0) {
            return;
        }

        sortedImports.forEach((packageName) => {
            this.emitLineOnce(`import "${packageName}"`);
        });
        this.ensureBlankLine();
    }

    private emitHelperFunctions(): void {
        if (this.haveNamedUnions) {
            this.startFile("JSONSchemaSupport");
            const imports = new Set<string>();
            if (this._options.multiFileOutput) {
                imports.add("bytes");
                imports.add("errors");
            }

            this.emitPackageDefinitons(true, imports);
            this.ensureBlankLine();
            this.emitMultiline(`func unmarshalUnion(data []byte, pi **int64, pf **float64, pb **bool, ps **string, haveArray bool, pa interface{}, haveObject bool, pc interface{}, haveMap bool, pm interface{}, haveEnum bool, pe interface{}, nullable bool) (bool, error) {
	if pi != nil {
			*pi = nil
	}
	if pf != nil {
			*pf = nil
	}
	if pb != nil {
			*pb = nil
	}
	if ps != nil {
			*ps = nil
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
			return false, err
	}

	switch v := tok.(type) {
	case json.Number:
			if pi != nil {
					i, err := v.Int64()
					if err == nil {
							*pi = &i
							return false, nil
					}
			}
			if pf != nil {
					f, err := v.Float64()
					if err == nil {
							*pf = &f
							return false, nil
					}
					return false, errors.New("Unparsable number")
			}
			return false, errors.New("Union does not contain number")
	case float64:
			return false, errors.New("Decoder should not return float64")
	case bool:
			if pb != nil {
					*pb = &v
					return false, nil
			}
			return false, errors.New("Union does not contain bool")
	case string:
			if haveEnum {
					return false, json.Unmarshal(data, pe)
			}
			if ps != nil {
					*ps = &v
					return false, nil
			}
			return false, errors.New("Union does not contain string")
	case nil:
			if nullable {
					return false, nil
			}
			return false, errors.New("Union does not contain null")
	case json.Delim:
			if v == '{' {
					if haveObject {
							return true, json.Unmarshal(data, pc)
					}
					if haveMap {
							return false, json.Unmarshal(data, pm)
					}
					return false, errors.New("Union does not contain object")
			}
			if v == '[' {
					if haveArray {
							return false, json.Unmarshal(data, pa)
					}
					return false, errors.New("Union does not contain array")
			}
			return false, errors.New("Cannot handle delimiter")
	}
	return false, errors.New("Cannot unmarshal union")
}

func marshalUnion(pi *int64, pf *float64, pb *bool, ps *string, haveArray bool, pa interface{}, haveObject bool, pc interface{}, haveMap bool, pm interface{}, haveEnum bool, pe interface{}, nullable bool) ([]byte, error) {
	if pi != nil {
			return json.Marshal(*pi)
	}
	if pf != nil {
			return json.Marshal(*pf)
	}
	if pb != nil {
			return json.Marshal(*pb)
	}
	if ps != nil {
			return json.Marshal(*ps)
	}
	if haveArray {
			return json.Marshal(pa)
	}
	if haveObject {
			return json.Marshal(pc)
	}
	if haveMap {
			return json.Marshal(pm)
	}
	if haveEnum {
			return json.Marshal(pe)
	}
	if nullable {
			return json.Marshal(nil)
	}
	return nil, errors.New("Union must not be null")
}`);
            if (this.haveUnionsWithClasses) {
                this.ensureBlankLine();
                this.emitMultiline(`// unmarshalClass decodes data into pc, a pointer to a struct, if data is an
// object with all the required properties, no others but the optional ones,
// and null only for the nullable ones.
func unmarshalClass(data []byte, pc interface{}, required []string, optional []string, nullable []string) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || object == nil {
		return false
	}
	for _, name := range required {
		if _, ok := object[name]; !ok {
			return false
		}
	}
	for name, value := range object {
		if !containsName(required, name) && !containsName(optional, name) {
			return false
		}
		if string(value) == "null" && !containsName(nullable, name) {
			return false
		}
	}
	return json.Unmarshal(data, pc) == nil
}

func containsName(names []string, name string) bool {
	for _, n := range names {
		if n == name {
			return true
		}
	}
	return false
}`);
            }

            this.endFile();
        }

        if (this.haveTuples) {
            this.startFile("JSONSchemaTupleSupport");
            this.emitPackageDefinitons(
                true,
                this._options.multiFileOutput
                    ? new Set(["errors", "fmt"])
                    : undefined,
            );
            this.ensureBlankLine();
            this.emitTupleHelperFunctions();
            this.endFile();
        }
    }

    // The elements of a JSON array of minItems to maxItems elements, or at
    // least minItems if maxItems is negative (a tuple with a rest).  A null
    // item is an error unless the item's type is nullable: JSON null leaves
    // other Go values as they are.
    private emitTupleHelperFunctions(): void {
        this.emitMultiline(`func unmarshalTuple(data []byte, minItems int, maxItems int) ([]json.RawMessage, error) {
	var items []json.RawMessage
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, err
	}
	if items == nil {
		return nil, errors.New("Tuple must not be null")
	}
	if len(items) >= minItems && (maxItems < 0 || len(items) <= maxItems) {
		return items, nil
	}
	expected := fmt.Sprintf("%d to %d", minItems, maxItems)
	if maxItems < 0 {
		expected = fmt.Sprintf("at least %d", minItems)
	} else if minItems == maxItems {
		expected = fmt.Sprint(minItems)
	}
	return nil, fmt.Errorf("Tuple has %d elements, expected %s", len(items), expected)
}

func unmarshalTupleItem(data json.RawMessage, v interface{}, nullable bool) error {
	if !nullable && string(data) == "null" {
		return errors.New("Tuple item must not be null")
	}
	return json.Unmarshal(data, v)
}`);
    }

    protected emitSourceStructure(): void {
        if (this._options.multiFileOutput === false) {
            if (
                this._options.justTypes === false &&
                this._options.justTypesAndPackage === false
            ) {
                if (this.leadingComments !== undefined) {
                    this.emitComments(this.leadingComments);
                } else {
                    this.emitSingleFileHeaderComments();
                }
            }

            // A single file imports everything before its first type: the
            // types only emit the imports that aren't there yet, which Go
            // doesn't allow after a declaration.
            this.emitPackageDefinitons(false, this.collectAllImports());
        }

        this.forEachTopLevel(
            "leading-and-interposing",
            (t, name) => this.emitTopLevel(t, name),
            (t) =>
                !(
                    this._options.justTypes || this._options.justTypesAndPackage
                ) || this.namedTypeToNameForTopLevel(t) === undefined,
        );
        this.forEachObject(
            "leading-and-interposing",
            (c: ClassType, className: Name) => this.emitClass(c, className),
        );
        this.forEachTuple("leading-and-interposing", (t, tupleName) =>
            this.emitTuple(t, tupleName),
        );
        this.forEachEnum(
            "leading-and-interposing",
            (u: EnumType, enumName: Name) => this.emitEnum(u, enumName),
        );
        this.forEachUnion(
            "leading-and-interposing",
            (u: UnionType, unionName: Name) => this.emitUnion(u, unionName),
        );

        if (this._options.justTypes || this._options.justTypesAndPackage) {
            return;
        }

        this.emitHelperFunctions();
    }

    private collectAllImports(): Set<string> {
        let imports = new Set<string>();
        this.forEachObject(
            "leading-and-interposing",
            (c: ClassType, _className: Name) => {
                const classImports = this.collectClassImports(c);
                imports = new Set([...imports, ...classImports]);
            },
        );

        this.forEachUnion(
            "leading-and-interposing",
            (u: UnionType, _unionName: Name) => {
                const unionImports = this.collectUnionImports(u);
                imports = new Set([...imports, ...unionImports]);
            },
        );

        this.forEachTuple("none", (t) => {
            imports = new Set([...imports, ...this.collectTupleImports(t)]);
        });
        return imports;
    }

    private collectTupleImports(t: TupleType): Set<string> {
        const imports = new Set<string>();
        for (const [, goType] of this.tupleColumns(t)) {
            if (this.sourcelikeToString(goType).includes("time.Time")) {
                imports.add("time");
            }
        }

        // For the error about a gap in MarshalJSON.
        if (!this.justTypes && this.tupleGapCondition(t) !== undefined) {
            imports.add("errors");
        }

        return imports;
    }

    private collectClassImports(c: ClassType): Set<string> {
        const goTypes: Sourcelike[] = [];
        this.forEachClassProperty(c, "none", (_name, _jsonName, p) => {
            goTypes.push(this.propertyGoType(p));
        });
        return this.collectGoTypeImports(goTypes);
    }

    // Imports for a top-level emitted as `type Name <goType>`, e.g. a
    // nullable (`*T`), array or map top-level.
    private collectAliasImports(t: Type): Set<string> {
        const imports = new Set<string>();
        if (this.sourcelikeToString(this.goType(t)).includes("time.Time")) {
            imports.add("time");
        }

        return imports;
    }

    private collectUnionImports(u: UnionType): Set<string> {
        const goTypes: Sourcelike[] = [];
        this.forEachUnionMember(u, null, "none", null, (_fieldName, t) => {
            goTypes.push(this.nullableGoType(t, true));
        });
        return this.collectGoTypeImports(goTypes);
    }

    // The packages the Go types refer to: `time` for `time.Time`, also in
    // slices, maps and pointers, such as `map[string][]*time.Time`.
    private collectGoTypeImports(goTypes: readonly Sourcelike[]): Set<string> {
        const imports = new Set<string>();
        for (const goType of goTypes) {
            if (this.sourcelikeToString(goType).includes("time.Time")) {
                imports.add("time");
            }
        }

        return imports;
    }
}
