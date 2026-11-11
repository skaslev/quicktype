import {
    arrayIntercalate,
    iterableFind,
    iterableFirst,
    iterableSome,
    setUnion,
    toReadonlyArray,
    withDefault,
} from "collection-utils";

import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import { getAccessorName } from "../../attributes/AccessorNames.js";
import { defaultValueForType } from "../../attributes/DefaultValue.js";
import { enumCaseValues } from "../../attributes/EnumValues.js";
import { minMaxItemsForType } from "../../attributes/Constraints.js";
import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer.js";
import type { Declaration } from "../../DeclarationIR.js";
import {
    DependencyName,
    type Name,
    type NameStyle,
    Namespace,
    type Namer,
    SimpleName,
    funPrefixNamer,
} from "../../Naming.js";
import type { BlankLineConfig, RenderContext } from "../../Renderer.js";
import type { OptionValues } from "../../RendererOptions/index.js";
import { type Sourcelike, maybeAnnotated } from "../../Source.js";
import {
    type NamingStyle,
    makeNameStyle,
    stringEscape,
} from "../../support/Strings.js";
import {
    assert,
    assertNever,
    defined,
    numberEnumValues,
    panic,
} from "../../support/Support.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    ArrayType,
    type ClassProperty,
    ClassType,
    EnumType,
    isPrimitiveStringTypeKind,
    MapType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import {
    directlyReachableTypes,
    isNamedType,
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";

import { keywords } from "./constants.js";
import type { cPlusPlusOptions } from "./language.js";
import {
    BaseString,
    type ConstraintMember,
    GlobalNames,
    IncludeKind,
    type IncludeMap,
    type IncludeRecord,
    MemberNames,
    type StringType,
    type TypeContext,
    type TypeRecord,
    WrappingCode,
    addQualifier,
    constraintsForType,
    legalizeName,
    optionalAsSharedType,
    optionalFactoryAsSharedType,
} from "./utils.js";

function elements(n: number): string {
    return n === 1 ? "1 element" : `${n} elements`;
}

// What a tuple with optional items or a rest expects, for error messages.
function expectedTupleLength(min: number, max: number | undefined): string {
    if (max === undefined) {
        return min === 0 ? "an array" : `an array of at least ${elements(min)}`;
    }

    if (min === max) return `an array of ${elements(min)}`;
    return min === 0
        ? `an array of at most ${elements(max)}`
        : `an array of ${min} to ${max} elements`;
}

export class CPlusPlusRenderer extends ConvenienceRenderer {
    /**
     * For forward declaration practically
     */
    private readonly _enumType: string;

    private readonly _generatedFiles: Set<string>;

    private _currentFilename: string | undefined;

    private _allTypeNames: Set<string>;

    private readonly _gettersAndSettersForPropertyName = new Map<
        Name,
        [Name, Name, Name]
    >();

    /// The members of the structs of tuples with optional items or a rest
    private readonly _tupleMemberNames = new Map<
        TupleType,
        { items: Name[]; rest: Name | undefined }
    >();

    private readonly _namespaceNames: readonly string[];

    private readonly _memberNameStyle: NameStyle;

    private readonly _namedTypeNameStyle: NameStyle;

    private readonly _generatedGlobalNames: Map<GlobalNames, string>;

    private readonly _generatedMemberNames: Map<MemberNames, string>;

    private readonly _forbiddenGlobalNames: string[];

    private readonly _memberNamingFunction: Namer;

    private readonly _stringType: StringType;

    /// The type to use as an optional  (std::optional or std::shared)
    private readonly _optionalType: string;

    private readonly _optionalFactory: string;

    private readonly _nulloptType: string;

    private readonly _variantType: string;

    private readonly _variantIndexMethodName: string;

    private _unionClasses: ReadonlySet<Type> | undefined;

    protected readonly typeNamingStyle: NamingStyle;

    protected readonly enumeratorNamingStyle: NamingStyle;

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof cPlusPlusOptions>,
    ) {
        super(targetLanguage, renderContext);

        this._enumType = _options.enumType;
        this._namespaceNames = _options.namespace.split("::");

        this.typeNamingStyle = _options.typeNamingStyle;
        this._namedTypeNameStyle = makeNameStyle(
            this.typeNamingStyle,
            legalizeName,
        );
        this.enumeratorNamingStyle = _options.enumeratorNamingStyle;

        this._memberNameStyle = makeNameStyle(
            _options.memberNamingStyle,
            legalizeName,
        );
        this._memberNamingFunction = funPrefixNamer(
            "members",
            this._memberNameStyle,
        );
        this._gettersAndSettersForPropertyName = new Map();

        this._allTypeNames = new Set<string>();
        this._generatedFiles = new Set<string>();
        this._generatedGlobalNames = new Map();
        this._generatedMemberNames = new Map();
        this._forbiddenGlobalNames = [];

        if (_options.wstring) {
            this._stringType = this.WideString;
        } else {
            this._stringType = this.NarrowString;
        }

        if (_options.boost) {
            this._optionalType = "boost::optional";
            this._optionalFactory = "boost::optional";
            this._nulloptType = "boost::none";
            this._variantType = "boost::variant";
            this._variantIndexMethodName = "which";
        } else {
            this._optionalType = "std::optional";
            this._optionalFactory = "std::make_optional";
            this._nulloptType = "std::nullopt";
            this._variantType = "std::variant";
            this._variantIndexMethodName = "index";
        }

        this.setupGlobalNames();
    }

    // union typeguard
    private isUnion(t: Type | UnionType): t is UnionType {
        return t.kind === "union";
    }

    // Returns true if the type can be stored in
    // a stack based optional type. This requires
    // that the type does not require forward declaration.
    private isOptionalAsValuePossible(t: Type): boolean {
        if (this.isForwardDeclaredType(t)) return false;

        if (this.isUnion(t)) {
            // There is something stinky about this test.
            // There is special handling somewhere that if you
            // have the following schema
            // {
            //     "$schema": "http://json-schema.org/draft-06/schema#",
            //     "$ref": "#/definitions/List",
            //     "definitions": {
            //         "List": {
            //             "type": "object",
            //             "additionalProperties": false,
            //             "properties": {
            //                 "data": {
            //                     "type": "string"
            //                 },
            //                 "next": {
            //                     "anyOf": [
            //                         {
            //                             "$ref": "#/definitions/List"
            //                         }
            //                         {
            //                             "type": "null"
            //                         }
            //                     ]
            //                 }
            //             },
            //             "required": [],
            //             "title": "List"
            //         }
            //     }
            // }
            // Then a variant is not output but the single item inlined
            //
            //     struct TopLevel {
            //       std::optional<std::string> data;
            //       std::optional<TopLevel> next;
            //     };
            //
            // instead of
            //     struct TopLevel {
            //       std::optional<std::string> data;
            //       std::shared_ptr<TopLevel> next;
            //     };
            //
            // checking to see if the collapse of the variant has
            // occurred and then doing the isCycleBreakerType check
            // on the single type the variant would contain seems
            // to solve the problem. But does this point to a problem
            // with the core library or with the CPlusPlus package
            const [, nonNulls] = removeNullFromUnion(t);
            if (nonNulls.size === 1) {
                const tt = defined(iterableFirst(nonNulls));
                return !this.isCycleBreakerType(tt);
            }
        }

        return !this.isCycleBreakerType(t);
    }

    private typeContainsUnion(t: Type, visited = new Set<Type>()): boolean {
        if (t instanceof UnionType) return true;
        if (visited.has(t)) return false;

        visited.add(t);
        return iterableSome(t.getChildren(), (child) =>
            this.typeContainsUnion(child, visited),
        );
    }

    private typeReaches(
        t: Type,
        target: Type,
        visited = new Set<Type>(),
    ): boolean {
        if (t === target) return true;
        if (visited.has(t)) return false;

        visited.add(t);
        return iterableSome(t.getChildren(), (child) =>
            this.typeReaches(child, target, visited),
        );
    }

    private isRecursiveUnion(u: UnionType): boolean {
        return iterableSome(u.getChildren(), (child) =>
            this.typeReaches(child, u),
        );
    }

    // The classes of a union with several, which its `from_json` tries in
    // turn, in that order.  The `from_json` of a class takes only values
    // with all its required properties and no unknown ones, so two classes
    // only take the same value if it is valid for both, as with an `anyOf`,
    // or if it is invalid only in a way that isn't checked, such as an
    // unknown key in a nested object.  The class that requires more of the
    // value's properties is the more specific type then, so classes with
    // more required properties are tried first, and others in the order of
    // the variant.
    private unionClassesInTryOrder(
        members: ReadonlySet<Type>,
    ): ClassType[] | undefined {
        const classes = Array.from(members).filter(
            (t): t is ClassType => t instanceof ClassType,
        );
        if (classes.length < 2) return undefined;

        const requiredCount = (c: ClassType): number =>
            Array.from(c.getProperties().values()).filter((p) => !p.isOptional)
                .length;
        return classes.sort((a, b) => requiredCount(b) - requiredCount(a));
    }

    // Whether `c` is one of several classes of a union.  A union only has
    // several if they don't allow additional properties, so their
    // `from_json` rejects unknown properties, and only takes values of its
    // own class.
    private isUnionClass(c: ClassType): boolean {
        if (this._unionClasses === undefined) {
            const unionClasses = new Set<Type>();
            for (const t of this.typeGraph.allTypesUnordered()) {
                if (!(t instanceof UnionType)) continue;
                for (const m of this.unionClassesInTryOrder(t.members) ?? []) {
                    unionClasses.add(m);
                }
            }

            this._unionClasses = unionClasses;
        }

        return this._unionClasses.has(c);
    }

    private recursiveUnionUsesStackOptional(u: UnionType): boolean {
        const [maybeNull] = removeNullFromUnion(u, true);
        return (
            this.isRecursiveUnion(u) &&
            maybeNull !== null &&
            this.isOptionalAsValuePossible(u)
        );
    }

    private isRecursiveTuple(t: TupleType): boolean {
        return iterableSome(t.getChildren(), (child) =>
            this.typeReaches(child, t),
        );
    }

    // Fixed-length tuples are spelled out as std::tuple<A, B>, unless the
    // schema names them or they contain themselves.  Named tuples are type
    // aliases, or structs deriving from std::tuple if they contain
    // themselves: an alias can't refer to itself.  A std::tuple can't leave
    // out items, so tuples with optional items or a rest are always structs
    // with a member per item.
    protected tupleNeedsName(t: TupleType): boolean {
        const isNamedAnyway = (u: TupleType): boolean =>
            !u.isFixedLength || this.hasGivenName(u);
        return (
            isNamedAnyway(t) ||
            this.isInCycleThrough(
                t,
                (c) =>
                    !["class", "enum"].includes(c.kind) &&
                    !(c instanceof UnionType && this.unionNeedsName(c)) &&
                    !(c instanceof TupleType && isNamedAnyway(c)),
            )
        );
    }

    // A tuple declared as a struct: a struct deriving from std::tuple, or
    // one with a member per item.  Either has its own from_json and to_json.
    private isTupleStruct(t: Type): t is TupleType {
        return (
            t instanceof TupleType &&
            this.tupleNeedsName(t) &&
            (!t.isFixedLength || this.isRecursiveTuple(t))
        );
    }

    private tupleMemberNames(t: TupleType): {
        items: Name[];
        rest: Name | undefined;
    } {
        return defined(this._tupleMemberNames.get(t));
    }

    // The members of a tuple's struct are `item0`, `item1`, ... and `rest`,
    // in the member naming style.  They mustn't be named like a type: GCC
    // rejects a member that changes what a name used in the class means.
    protected setUpNaming(): ReadonlySet<Namespace> {
        const namespaces = super.setUpNaming();
        const tupleNamespaces: Namespace[] = [];
        for (const t of this.typeGraph.allTypesUnordered()) {
            if (!(t instanceof TupleType) || t.isFixedLength) continue;

            const ns = new Namespace(
                t.getCombinedName(),
                undefined,
                namespaces,
                [],
            );
            const member = (name: string): Name =>
                ns.add(new SimpleName([name], this._memberNamingFunction, 0));
            this._tupleMemberNames.set(t, {
                items: t.items.map((_, i) => member(`item${i}`)),
                rest: t.rest === undefined ? undefined : member("rest"),
            });
            tupleNamespaces.push(ns);
        }

        return setUnion(namespaces, tupleNamespaces);
    }

    private forEachTupleStruct(
        blankLocations: BlankLineConfig,
        f: (t: TupleType, name: Name) => void,
    ): void {
        const tuples: Array<[TupleType, TupleType]> = [];
        this.forEachDeclaration("none", (decl) => {
            if (decl.kind === "define" && this.isTupleStruct(decl.type)) {
                tuples.push([decl.type, decl.type]);
            }
        });
        this.forEachSpecificNamedType(blankLocations, tuples, f);
    }

    // Whether a std::tuple is used: the other tuples are structs.
    private get haveStdTuples(): boolean {
        return iterableSome(
            this.typeGraph.allTypesUnordered(),
            (t) => t instanceof TupleType && t.isFixedLength,
        );
    }

    private haveTuplesWith(f: (t: TupleType) => boolean): boolean {
        return iterableSome(
            this.typeGraph.allTypesUnordered(),
            (t) => t instanceof TupleType && f(t),
        );
    }

    // Tuple structs convert their nullable items and rest elements, which
    // are optionals, with wide strings.
    private get haveTupleStructsWithNullables(): boolean {
        return this.haveTuplesWith(
            (t) =>
                !t.isFixedLength &&
                iterableSome(
                    t.getNonAttributeChildren(),
                    (c) =>
                        c instanceof UnionType &&
                        removeNullFromUnion(c)[0] !== null,
                ),
        );
    }

    public isImplicitCycleBreaker(t: Type): boolean {
        // Containers break completeness cycles for classes, but not for type
        // aliases: an alias name is not in scope on its own right-hand side.
        const kind = t.kind;
        if (kind !== "array" && kind !== "map") return false;

        return !iterableSome(t.getChildren(), (child) =>
            this.typeContainsUnion(child),
        );
    }

    protected canBreakCycles(t: Type): boolean {
        return (
            t instanceof ClassType ||
            t instanceof UnionType ||
            this.isTupleStruct(t)
        );
    }

    // Is likely to return std::optional or boost::optional
    private optionalTypeStack(): string {
        return this._optionalType;
    }

    // Is likely to return std::make_optional or boost::optional
    private optionalFactoryStack(): string {
        return this._optionalFactory;
    }

    // Is likely to return std::shared_ptr
    private optionalTypeHeap(): string {
        return optionalAsSharedType;
    }

    // Is likely to return std::make_shared
    private optionalFactoryHeap(): string {
        return optionalFactoryAsSharedType;
    }

    // Returns the optional type most suitable for the given type.
    // Classes that don't require forward declarations can be stored
    // in std::optional ( or boost::optional )
    private optionalType(t: Type): string {
        if (this.isOptionalAsValuePossible(t)) {
            return this.optionalTypeStack();
        }

        return this.optionalTypeHeap();
    }

    // Whether the code holds values in an optional or a shared_ptr, which
    // nlohmann/json converts with the optional helpers: optional properties,
    // nullable types (unions with null), and the forward-declared types,
    // which are held in shared_ptrs even where they're required.
    private get haveOptionals(): boolean {
        return (
            this.haveUnions ||
            this.haveOptionalProperties ||
            iterableSome(this.typeGraph.allTypesUnordered(), (t) =>
                this.isForwardDeclaredType(t),
            )
        );
    }

    // Returns a label that can be used to distinguish between
    // heap and stack based optional handling methods
    private optionalTypeLabel(t: Type): string {
        if (this.isOptionalAsValuePossible(t)) {
            return "stack";
        }

        return "heap";
    }

    protected getConstraintMembers(): ConstraintMember[] {
        return [
            {
                name: MemberNames.MinIntValue,
                getter: MemberNames.GetMinIntValue,
                setter: MemberNames.SetMinIntValue,
                cppType: "int64_t",
            },
            {
                name: MemberNames.MaxIntValue,
                getter: MemberNames.GetMaxIntValue,
                setter: MemberNames.SetMaxIntValue,
                cppType: "int64_t",
            },
            {
                name: MemberNames.MinDoubleValue,
                getter: MemberNames.GetMinDoubleValue,
                setter: MemberNames.SetMinDoubleValue,
                cppType: "double",
            },
            {
                name: MemberNames.MaxDoubleValue,
                getter: MemberNames.GetMaxDoubleValue,
                setter: MemberNames.SetMaxDoubleValue,
                cppType: "double",
            },
            {
                name: MemberNames.MinLength,
                getter: MemberNames.GetMinLength,
                setter: MemberNames.SetMinLength,
                cppType: "size_t",
            },
            {
                name: MemberNames.MaxLength,
                getter: MemberNames.GetMaxLength,
                setter: MemberNames.SetMaxLength,
                cppType: "size_t",
            },
            {
                name: MemberNames.Pattern,
                getter: MemberNames.GetPattern,
                setter: MemberNames.SetPattern,
                cppType: this._stringType.getType(),
                cppConstType: this._stringType.getConstType(),
            },
        ];
    }

    protected lookupGlobalName(type: GlobalNames): string {
        return defined(this._generatedGlobalNames.get(type));
    }

    protected lookupMemberName(type: MemberNames): string {
        return defined(this._generatedMemberNames.get(type));
    }

    protected addGlobalName(type: GlobalNames): void {
        const genName = this._namedTypeNameStyle(GlobalNames[type]);
        this._generatedGlobalNames.set(type, genName);
        this._forbiddenGlobalNames.push(genName);
    }

    protected addMemberName(type: MemberNames): void {
        this._generatedMemberNames.set(
            type,
            this._memberNameStyle(MemberNames[type]),
        );
    }

    protected setupGlobalNames(): void {
        for (const v of numberEnumValues(GlobalNames)) {
            this.addGlobalName(v);
        }

        for (const v of numberEnumValues(MemberNames)) {
            this.addMemberName(v);
        }
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return [...keywords, ...this._forbiddenGlobalNames];
    }

    // A member hides the type of the same name in the rest of its class, and
    // can't have the name of its class if the class has a constructor.
    protected forbiddenForObjectProperties(
        _c: ClassType,
        _className: Name,
    ): ForbiddenWordsInfo {
        return {
            names: [],
            includeGlobalForbidden: true,
            includeGlobalNames: true,
        };
    }

    protected forbiddenForEnumCases(
        _e: EnumType,
        _enumName: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected makeNamedTypeNamer(): Namer {
        return funPrefixNamer("types", this._namedTypeNameStyle);
    }

    protected namerForObjectProperty(): Namer {
        return this._memberNamingFunction;
    }

    protected makeUnionMemberNamer(): null {
        return null;
    }

    protected makeEnumCaseNamer(): Namer {
        return funPrefixNamer(
            "enumerators",
            makeNameStyle(this.enumeratorNamingStyle, legalizeName),
        );
    }

    protected makeNamesForPropertyGetterAndSetter(
        _c: ClassType,
        _className: Name,
        _p: ClassProperty,
        _jsonName: string,
        name: Name,
    ): [Name, Name, Name] {
        const getterName = new DependencyName(
            this._memberNamingFunction,
            name.order,
            (lookup) => `get_${lookup(name)}`,
        );
        const mutableGetterName = new DependencyName(
            this._memberNamingFunction,
            name.order,
            (lookup) => `getMutable_${lookup(name)}`,
        );
        const setterName = new DependencyName(
            this._memberNamingFunction,
            name.order,
            (lookup) => `set_${lookup(name)}`,
        );
        return [getterName, mutableGetterName, setterName];
    }

    protected makePropertyDependencyNames(
        c: ClassType,
        className: Name,
        p: ClassProperty,
        jsonName: string,
        name: Name,
    ): Name[] {
        const getterAndSetterNames = this.makeNamesForPropertyGetterAndSetter(
            c,
            className,
            p,
            jsonName,
            name,
        );
        this._gettersAndSettersForPropertyName.set(name, getterAndSetterNames);
        return getterAndSetterNames;
    }

    protected withConst(s: Sourcelike): Sourcelike {
        if (this._options.westConst) {
            return ["const ", s];
        }

        return [s, " const"];
    }

    protected emitInclude(global: boolean, name: Sourcelike): void {
        this.emitLine(
            "#include ",
            global ? "<" : '"',
            name,
            global ? ">" : '"',
        );
    }

    protected startFile(basename: Sourcelike, includeHelper = true): void {
        assert(
            this._currentFilename === undefined,
            "Previous file wasn't finished",
        );
        if (basename !== undefined) {
            this._currentFilename = this.sourcelikeToString(basename);
        }

        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        } else if (!this._options.justTypes) {
            this.emitCommentLines([
                " To parse this JSON data, first install",
                "",
            ]);
            if (this._options.boost) {
                this.emitCommentLines(["     Boost     http://www.boost.org"]);
            }

            this.emitCommentLines([
                "     json.hpp  https://github.com/nlohmann/json",
                "",
                " Then include this file, and then do",
                "",
            ]);

            this.forEachTopLevel("none", (t, topLevelName) => {
                this.emitLine(
                    "//     ",
                    topLevelName,
                    " data = nlohmann::json::parse(jsonString)",
                    this.topLevelNeedsGet(t)
                        ? [".get<", topLevelName, ">()"]
                        : [],
                    ";",
                );
            });

            if (this._options.wstring) {
                this.emitLine("//");
                this.emitLine(
                    "//  You can get std::wstring data back out using",
                );
                this.emitLine("//");
                this.forEachTopLevel("none", (_, topLevelName) => {
                    this.emitLine(
                        "//     std::wcout << ",
                        "wdump((nlohmann::json) ",
                        topLevelName,
                        ");",
                    );
                });
            }
        }

        this.ensureBlankLine();

        this.emitLine("#pragma once");
        this.ensureBlankLine();

        const justTypesIncludes = this._options.justTypes
            ? this.justTypesIncludes()
            : undefined;

        // With getters and setters, emitExtraIncludes includes the optional
        // header anyway.
        if (
            this.haveOptionalProperties ||
            justTypesIncludes?.optional === true ||
            (!this._options.codeFormat &&
                iterableSome(this.namedUnions, (u) =>
                    this.recursiveUnionUsesStackOptional(u),
                )) ||
            (!this._options.codeFormat &&
                !this._options.justTypes &&
                this.haveOptionals) ||
            this.haveTuplesWith((t) => t.minItems < t.items.length)
        ) {
            if (this._options.boost) {
                this.emitInclude(true, "boost/optional.hpp");
            } else {
                this.emitInclude(true, "optional");
            }
        }

        if (this.haveNamedUnions) {
            if (this._options.boost) {
                this.emitInclude(true, "boost/variant.hpp");
            } else {
                this.emitInclude(true, "variant");
            }
        }

        if (this.haveStdTuples) {
            this.emitInclude(true, "tuple");
        }

        if (justTypesIncludes !== undefined) {
            for (const header of justTypesIncludes.headers) {
                this.emitInclude(true, header);
            }
        }

        if (!this._options.justTypes || justTypesIncludes?.json === true) {
            if (!this._options.includeLocation) {
                this.emitInclude(true, "nlohmann/json.hpp");
            } else {
                this.emitInclude(false, "json.hpp");
            }
        }

        if (
            !this._options.justTypes &&
            includeHelper &&
            !this._options.typeSourceStyle
        ) {
            this.emitInclude(false, "helper.hpp");
        }

        this.ensureBlankLine();
    }

    // Copy-initializing a std::optional from the JSON doesn't use the
    // optional helper's adl_serializer, but the optional's converting
    // constructor, which reads the value type, so a nullable top level
    // throws on null.  boost::variant's converting constructor takes the
    // JSON, too, which converts to each of its alternatives, so it doesn't
    // compile.  `get` always uses the adl_serializers.
    private topLevelNeedsGet(t: Type): boolean {
        if (!(t instanceof UnionType)) return false;
        const [maybeNull, nonNulls] = removeNullFromUnion(t, true);
        if (maybeNull === null) {
            return this._options.boost && nonNulls.size > 1;
        }

        return !this._options.boost && this.isOptionalAsValuePossible(t);
    }

    // In full mode nlohmann/json.hpp brings in the standard headers the
    // generated types use.  Just-types output doesn't include it, so work out
    // which headers the types need.
    private justTypesIncludes(): {
        headers: string[];
        json: boolean;
        optional: boolean;
    } {
        const kinds = new Set<string>();
        let json = false;
        let optional = false;
        let sharedPtr = false;
        for (const t of this.typeGraph.allTypesUnordered()) {
            kinds.add(t.kind);
            if (t.kind === "any") json = true;
            // Forward-declared types and the types that break a cycle are
            // held in std::shared_ptr where they're optional.
            if (this.isForwardDeclaredType(t) || this.isCycleBreakerType(t)) {
                sharedPtr = true;
            }
            if (t instanceof UnionType) {
                // Unions with null become (boost|std)::optional<...>.
                if (removeNullFromUnion(t)[0] !== null) optional = true;
            } else if (
                iterableSome(t.getChildren(), (child) => child.kind === "null")
            ) {
                // Outside of a union, null is rendered as nlohmann::json.
                json = true;
            }
        }

        for (const t of this.topLevels.values()) {
            if (t.kind === "null") json = true;
        }

        const headers: string[] = [];
        if (kinds.has("integer")) headers.push("cstdint");
        if (kinds.has("map")) headers.push("map");
        if (sharedPtr) headers.push("memory");
        if (
            kinds.has("map") ||
            iterableSome(kinds, isPrimitiveStringTypeKind)
        ) {
            headers.push("string");
        }

        // Arrays and the rests of tuples are std::vectors.
        if (
            kinds.has("array") ||
            this.haveTuplesWith((t) => t.rest !== undefined)
        ) {
            headers.push("vector");
        }

        return { headers, json, optional };
    }

    protected finishFile(): void {
        super.finishFile(defined(this._currentFilename));
        this._currentFilename = undefined;
    }

    protected get needsTypeDeclarationBeforeUse(): boolean {
        return true;
    }

    protected canBeForwardDeclared(t: Type): boolean {
        const kind = t.kind;
        return kind === "class" || this.isTupleStruct(t);
    }

    protected get commentLinesSpliceOnBackslash(): boolean {
        return true;
    }

    protected emitDescriptionBlock(lines: Sourcelike[]): void {
        this.emitCommentLines(lines, {
            lineStart: " * ",
            beforeComment: "/**",
            afterComment: " */",
        });
    }

    protected emitBlock(
        line: Sourcelike,
        withSemicolon: boolean,
        f: () => void,
        withIndent = true,
    ): void {
        this.emitLine(line, " {");
        this.preventBlankLine();
        if (withIndent) {
            this.indent(f);
        } else {
            f();
        }

        this.preventBlankLine();
        if (withSemicolon) {
            this.emitLine("};");
        } else {
            this.emitLine("}");
        }
    }

    protected emitNamespaces(
        namespaceNames: Iterable<string>,
        f: () => void,
    ): void {
        const namesArray = toReadonlyArray(namespaceNames);
        const first = namesArray[0];
        if (first === undefined) {
            f();
        } else {
            this.emitBlock(
                ["namespace ", first],
                false,
                () => this.emitNamespaces(namesArray.slice(1), f),
                namesArray.length === 1,
            );
        }
    }

    protected cppTypeInOptional(
        nonNulls: ReadonlySet<Type>,
        ctx: TypeContext,
        withIssues: boolean,
        forceNarrowString: boolean,
    ): Sourcelike {
        if (nonNulls.size === 1) {
            return this.cppType(
                defined(iterableFirst(nonNulls)),
                ctx,
                withIssues,
                forceNarrowString,
                false,
            );
        }

        const typeList: Sourcelike = [];
        for (const t of nonNulls) {
            if (typeList.length > 0) {
                typeList.push(", ");
            }

            typeList.push(
                this.cppType(
                    t,
                    {
                        needsForwardIndirection: true,
                        needsOptionalIndirection: false,
                        inJsonNamespace: ctx.inJsonNamespace,
                    },
                    withIssues,
                    false,
                    false,
                ),
            );
        }

        return [this._variantType, "<", typeList, ">"];
    }

    protected variantType(u: UnionType, inJsonNamespace: boolean): Sourcelike {
        const [maybeNull, nonNulls] = removeNullFromUnion(u, true);
        assert(
            nonNulls.size >= 2,
            "Variant not needed for less than two types.",
        );
        const indirection = maybeNull !== null;
        const variant = this.cppTypeInOptional(
            nonNulls,
            {
                needsForwardIndirection: !indirection,
                needsOptionalIndirection: !indirection,
                inJsonNamespace,
            },
            true,
            false,
        );
        if (!indirection) {
            return variant;
        }

        return [this.optionalType(u), "<", variant, ">"];
    }

    protected ourQualifier(inJsonNamespace: boolean): Sourcelike {
        return inJsonNamespace
            ? [arrayIntercalate("::", this._namespaceNames), "::"]
            : [];
    }

    protected jsonQualifier(inJsonNamespace: boolean): Sourcelike {
        return inJsonNamespace ? [] : "nlohmann::";
    }

    protected variantIndirection(
        type: Type,
        needIndirection: boolean,
        typeSrc: Sourcelike,
    ): Sourcelike {
        if (!needIndirection) return typeSrc;
        return [this.optionalType(type), "<", typeSrc, ">"];
    }

    protected cppType(
        t: Type,
        ctx: TypeContext,
        withIssues: boolean,
        forceNarrowString: boolean,
        isOptional: boolean,
    ): Sourcelike {
        const inJsonNamespace = ctx.inJsonNamespace;
        if (isOptional && t instanceof UnionType) {
            // avoid have optionalType<optionalType<Type>>
            for (const tChild of t.getChildren()) {
                if (tChild.isNullable) {
                    isOptional = false;
                    break;
                }
            }
        }

        const typeSource = matchType<Sourcelike>(
            t,
            (_anyType) => {
                isOptional = false;
                return maybeAnnotated(withIssues, anyTypeIssueAnnotation, [
                    this.jsonQualifier(inJsonNamespace),
                    "json",
                ]);
            },
            (_nullType) => {
                isOptional = false;
                return maybeAnnotated(withIssues, nullTypeIssueAnnotation, [
                    this.jsonQualifier(inJsonNamespace),
                    "json",
                ]);
            },
            (_boolType) => "bool",
            (_integerType) => "int64_t",
            (_doubleType) => "double",
            (_stringType) => {
                if (forceNarrowString) {
                    return "std::string";
                }

                return this._stringType.getType();
            },
            (arrayType) => [
                "std::vector<",
                this.cppType(
                    arrayType.items,
                    {
                        needsForwardIndirection: false,
                        needsOptionalIndirection: true,
                        inJsonNamespace,
                    },
                    withIssues,
                    forceNarrowString,
                    false,
                ),
                ">",
            ],
            (classType) =>
                this.variantIndirection(
                    classType,
                    ctx.needsForwardIndirection &&
                        this.isForwardDeclaredType(classType) &&
                        !isOptional,
                    [
                        this.ourQualifier(inJsonNamespace),
                        this.nameForNamedType(classType),
                    ],
                ),
            (mapType) => {
                let keyType = this._stringType.getType();
                if (forceNarrowString) {
                    keyType = "std::string";
                }

                return [
                    "std::map<",
                    keyType,
                    ", ",
                    this.cppType(
                        mapType.values,
                        {
                            needsForwardIndirection: false,
                            needsOptionalIndirection: true,
                            inJsonNamespace,
                        },
                        withIssues,
                        forceNarrowString,
                        false,
                    ),
                    ">",
                ];
            },
            (enumType) => [
                this.ourQualifier(inJsonNamespace),
                this.nameForNamedType(enumType),
            ],
            (unionType) => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    isOptional = true;
                    return this.cppType(
                        nullable,
                        {
                            needsForwardIndirection: false,
                            needsOptionalIndirection: false,
                            inJsonNamespace,
                        },
                        withIssues,
                        forceNarrowString,
                        false,
                    );
                }

                return [
                    this.ourQualifier(inJsonNamespace),
                    this.nameForNamedType(unionType),
                ];
            },
            // uuid and date-time are strings, too.
            (_transformedStringType) => {
                if (forceNarrowString) {
                    return "std::string";
                }

                return this._stringType.getType();
            },
            (tupleType) => {
                // With wide strings, the JSON side of a conversion is the
                // tuple with narrow strings, which has no name, unless it's
                // a struct, which converts its items itself.
                if (
                    !this.tupleNeedsName(tupleType) ||
                    (forceNarrowString &&
                        this._stringType !== this.NarrowString &&
                        !this.isTupleStruct(tupleType))
                ) {
                    return this.cppTupleType(
                        tupleType,
                        inJsonNamespace,
                        withIssues,
                        forceNarrowString,
                    );
                }

                return this.variantIndirection(
                    tupleType,
                    ctx.needsForwardIndirection &&
                        this.isForwardDeclaredType(tupleType) &&
                        !isOptional,
                    [
                        this.ourQualifier(inJsonNamespace),
                        this.nameForNamedType(tupleType),
                    ],
                );
            },
        );
        if (!isOptional) return typeSource;
        return [this.optionalType(t), "<", typeSource, ">"];
    }

    // The elements of a std::tuple must be complete types, like the members
    // of a class.
    protected cppTupleType(
        t: TupleType,
        inJsonNamespace: boolean,
        withIssues: boolean,
        forceNarrowString: boolean,
    ): Sourcelike {
        const items = t.items.map((item) =>
            this.cppType(
                item,
                {
                    needsForwardIndirection: true,
                    needsOptionalIndirection: true,
                    inJsonNamespace,
                },
                withIssues,
                forceNarrowString,
                false,
            ),
        );
        return ["std::tuple<", arrayIntercalate(", ", items), ">"];
    }

    // The member for a required item is what a class member for a required
    // property would be.
    private tupleRequiredItemType(
        item: Type,
        withIssues: boolean,
        forceNarrowString: boolean,
    ): Sourcelike {
        return this.cppType(
            item,
            {
                needsForwardIndirection: true,
                needsOptionalIndirection: true,
                inJsonNamespace: false,
            },
            withIssues,
            forceNarrowString,
            false,
        );
    }

    // The member for an optional item is an optional (or std::shared_ptr,
    // where the type can't be held by value), empty if the item is missing.
    // Returns the optional and the type it holds.  An item of a nullable
    // type is an optional of the nullable type, which keeps a missing item
    // apart from a null one.
    private tupleOptionalItemType(
        item: Type,
        withIssues: boolean,
        forceNarrowString: boolean,
    ): [string, Sourcelike] {
        if (item.isNullable) {
            return [
                this.optionalTypeStack(),
                this.tupleRequiredItemType(item, withIssues, forceNarrowString),
            ];
        }

        return [
            this.optionalType(item),
            this.cppType(
                item,
                {
                    needsForwardIndirection: false,
                    needsOptionalIndirection: true,
                    inJsonNamespace: false,
                },
                withIssues,
                forceNarrowString,
                false,
            ),
        ];
    }

    private tupleItemType(
        t: TupleType,
        i: number,
        withIssues: boolean,
        forceNarrowString: boolean,
    ): Sourcelike {
        const item = t.items[i];
        if (i < t.minItems) {
            return this.tupleRequiredItemType(
                item,
                withIssues,
                forceNarrowString,
            );
        }

        const [optional, inner] = this.tupleOptionalItemType(
            item,
            withIssues,
            forceNarrowString,
        );
        return [optional, "<", inner, ">"];
    }

    // The elements of the rest, like those of an array.
    private tupleRestElementType(
        rest: Type,
        withIssues: boolean,
        forceNarrowString: boolean,
    ): Sourcelike {
        return this.cppType(
            rest,
            {
                needsForwardIndirection: false,
                needsOptionalIndirection: true,
                inJsonNamespace: false,
            },
            withIssues,
            forceNarrowString,
            false,
        );
    }

    // How many elements a JSON array for a tuple with optional items or a
    // rest may have: the tuple's shape, narrowed by the schema's `minItems`
    // and `maxItems`, which also limit a rest.  No maximum for an unlimited
    // rest.
    private tupleLengthBounds(t: TupleType): [number, number | undefined] {
        const [minItems, maxItems] = minMaxItemsForType(t) ?? [];
        const min = Math.max(t.minItems, minItems ?? 0);
        let max = t.rest === undefined ? t.items.length : undefined;
        if (maxItems !== undefined) {
            max = max === undefined ? maxItems : Math.min(max, maxItems);
        }

        return [min, max];
    }

    // Whether `j` has the length of the tuple.
    private tupleLengthCondition(t: TupleType): Sourcelike {
        if (t.isFixedLength) {
            return ["j.is_array() && j.size() == ", t.items.length.toString()];
        }

        const [min, max] = this.tupleLengthBounds(t);
        const conditions = ["j.is_array()"];
        if (min === max) {
            conditions.push(`j.size() == ${min}`);
        } else {
            if (min > 0) conditions.push(`j.size() >= ${min}`);
            if (max !== undefined) conditions.push(`j.size() <= ${max}`);
        }

        return conditions.join(" && ");
    }

    /**
     * similar to cppType, it practically gathers all the generated types within
     * 't'. It also records, whether a given sub-type is part of a variant or not.
     */
    protected generatedTypes(
        isClassMember: boolean,
        theType: Type,
    ): TypeRecord[] {
        const result: TypeRecord[] = [];
        // A recursive union contains itself, e.g. through an array: collect
        // the subtypes of each union once.
        const collectedUnions = new Set<UnionType>();
        const recur = (
            forceInclude: boolean,
            isVariant: boolean,
            l: number,
            t: Type,
            inOptional = false,
        ): void => {
            if (t instanceof ArrayType) {
                recur(true, isVariant, l + 1, t.items);
            } else if (t instanceof ClassType) {
                result.push({
                    name: this.nameForNamedType(t),
                    type: t,
                    level: l,
                    variant: isVariant,
                    forceInclude,
                    inOptional,
                });
            } else if (t instanceof MapType) {
                recur(true, isVariant, l + 1, t.values);
            } else if (t instanceof TupleType) {
                if (this.tupleNeedsName(t)) {
                    // The struct of a tuple with optional items or a rest
                    // can be forward declared, like a class.
                    result.push({
                        name: this.nameForNamedType(t),
                        type: t,
                        level: l,
                        variant: isVariant,
                        forceInclude: t.isFixedLength || forceInclude,
                    });
                } else {
                    // The elements of a std::tuple must be complete types.
                    for (const item of t.items) {
                        recur(true, isVariant, l + 1, item);
                    }
                }
            } else if (t instanceof EnumType) {
                result.push({
                    name: this.nameForNamedType(t),
                    type: t,
                    level: l,
                    variant: isVariant,
                    forceInclude: false,
                });
            } else if (t instanceof UnionType) {
                /**
                 * If we have a union as a class member and we see it as a "named union",
                 * we can safely include it as-is.
                 * HOWEVER if we define a union on its own, we must recurse into the
                 * typedefinition and include all subtypes.
                 * A named union in that definition, in an array or a map, must be
                 * included too: it's an alias, which can't be forward declared.
                 */
                if (this.unionNeedsName(t) && (isClassMember || l > 0)) {
                    /**
                     * This is NOT ENOUGH.
                     * We have a variant member in a class, e.g. defined with a boost::variant.
                     * The compiler can only compile the class if IT KNOWS THE SIZES
                     * OF ALL MEMBERS OF THE VARIANT.
                     * So it means that you must include ALL SUBTYPES (practically classes only)
                     * AS WELL
                     */
                    forceInclude = true;
                    result.push({
                        name: this.nameForNamedType(t),
                        type: t,
                        level: l,
                        variant: true,
                        forceInclude,
                    });
                    /** intentional "fall-through", add all subtypes as well - but forced include */
                }

                if (collectedUnions.has(t)) return;
                collectedUnions.add(t);

                const [hasNull, nonNulls] = removeNullFromUnion(t);
                isVariant = hasNull !== null;
                // `T | null` is a std::optional<T> where it can be, see
                // `optionalType`, which holds T by value.
                const optionalByValue =
                    !this.unionNeedsName(t) &&
                    this.isOptionalAsValuePossible(t);
                /** we need to collect all the subtypes of the union */
                for (const tt of nonNulls) {
                    recur(forceInclude, isVariant, l + 1, tt, optionalByValue);
                }
            }
        };

        recur(false, false, 0, theType);
        return result;
    }

    protected constraintMember(jsonName: string): string {
        return this._memberNameStyle(`${jsonName}Constraint`);
    }

    protected emitMember(
        cppType: Sourcelike,
        name: Sourcelike,
        defaultValue?: Sourcelike,
    ): void {
        this.emitLine(
            cppType,
            " ",
            name,
            defaultValue === undefined ? [] : [" = ", defaultValue],
            ";",
        );
    }

    protected cppDefaultValue(t: Type): Sourcelike | undefined {
        const defaultValue = defaultValueForType(t);
        if (defaultValue === undefined) return undefined;

        if (defaultValue === null) return "nullptr";
        if (typeof defaultValue === "boolean") {
            return defaultValue ? "true" : "false";
        }

        if (typeof defaultValue === "number") return String(defaultValue);
        if (t instanceof EnumType && t.cases.has(defaultValue)) {
            return [
                this.nameForNamedType(t),
                "::",
                this.nameForEnumCase(t, defaultValue),
            ];
        }

        return this._stringType.createStringLiteral([
            stringEscape(defaultValue),
        ]);
    }

    protected emitClassMembers(
        c: ClassType,
        constraints: Map<string, Sourcelike> | undefined,
    ): void {
        if (this._options.codeFormat) {
            this.emitLine("private:");

            this.forEachClassProperty(c, "none", (name, jsonName, property) => {
                this.emitMember(
                    this.cppType(
                        property.type,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: false,
                        },
                        true,
                        false,
                        property.isOptional,
                    ),
                    name,
                    this.cppDefaultValue(property.type),
                );
                if (constraints?.has(jsonName)) {
                    /** FIXME!!! NameStyle will/can collide with other Names */
                    const cnst = this.lookupGlobalName(
                        GlobalNames.ClassMemberConstraints,
                    );
                    this.emitMember(cnst, this.constraintMember(jsonName));
                }
            });

            this.ensureBlankLine();
            this.emitLine("public:");
        }

        this.forEachClassProperty(c, "none", (name, jsonName, property) => {
            this.emitDescription(this.descriptionForClassProperty(c, jsonName));
            if (!this._options.codeFormat) {
                this.emitMember(
                    this.cppType(
                        property.type,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: false,
                        },
                        true,
                        false,
                        property.isOptional,
                    ),
                    name,
                    this.cppDefaultValue(property.type),
                );
            } else {
                const [getterName, mutableGetterName, setterName] = defined(
                    this._gettersAndSettersForPropertyName.get(name),
                );
                const rendered = this.cppType(
                    property.type,
                    {
                        needsForwardIndirection: true,
                        needsOptionalIndirection: true,
                        inJsonNamespace: false,
                    },
                    true,
                    false,
                    property.isOptional,
                );

                /**
                 * fix for optional type -> e.g. unique_ptrs can't be copied
                 * One might as why the "this->xxx = value". Simple if we have
                 * a member called 'value' value = value will screw up the compiler
                 */
                const checkConst = this.lookupGlobalName(
                    GlobalNames.CheckConstraint,
                );
                if (
                    property.type instanceof UnionType &&
                    property.type.findMember("null") !== undefined
                ) {
                    this.emitLine(
                        rendered,
                        " ",
                        getterName,
                        "() const { return ",
                        name,
                        "; }",
                    );
                    if (constraints?.has(jsonName)) {
                        this.emitLine(
                            "void ",
                            setterName,
                            "(",
                            rendered,
                            " value) { if (value) ",
                            checkConst,
                            "(",
                            this._stringType.createStringLiteral([name]),
                            ", ",
                            this.constraintMember(jsonName),
                            ", *value); this->",
                            name,
                            " = value; }",
                        );
                    } else {
                        this.emitLine(
                            "void ",
                            setterName,
                            "(",
                            rendered,
                            " value) { this->",
                            name,
                            " = value; }",
                        );
                    }
                } else {
                    this.emitLine(
                        this.withConst(rendered),
                        " & ",
                        getterName,
                        "() const { return ",
                        name,
                        "; }",
                    );
                    this.emitLine(
                        rendered,
                        " & ",
                        mutableGetterName,
                        "() { return ",
                        name,
                        "; }",
                    );
                    if (constraints?.has(jsonName)) {
                        this.emitLine(
                            "void ",
                            setterName,
                            "(",
                            this.withConst(rendered),
                            " & value) { ",
                            checkConst,
                            "(",
                            this._stringType.createStringLiteral([name]),
                            ", ",
                            this.constraintMember(jsonName),
                            ", value); this->",
                            name,
                            " = value; }",
                        );
                    } else {
                        this.emitLine(
                            "void ",
                            setterName,
                            "(",
                            this.withConst(rendered),
                            " & value) { this->",
                            name,
                            " = value; }",
                        );
                    }
                }

                this.ensureBlankLine();
            }
        });
    }

    protected generateClassConstraints(
        c: ClassType,
    ): Map<string, Sourcelike> | undefined {
        const res: Map<string, Sourcelike> = new Map<string, Sourcelike>();
        this.forEachClassProperty(c, "none", (_name, jsonName, property) => {
            const constraints = constraintsForType(property.type);
            if (constraints === undefined) return;
            const { minMax, minMaxLength, pattern } = constraints;

            // TODO is there a better way to check if property.type is an integer or a number?
            // We only generate this to classify the underlying type, so we
            // always pass `false` for `isOptional` — otherwise `cppType`
            // wraps the type in the optional<> container and the comparisons
            // below never match.
            const cppType = this.cppType(
                property.type,
                {
                    needsForwardIndirection: true,
                    needsOptionalIndirection: true,
                    inJsonNamespace: false,
                },
                true,
                false,
                false,
            );

            // Compare bounds against `undefined` explicitly, since 0 is a
            // valid constraint value too.
            res.set(jsonName, [
                this.constraintMember(jsonName),
                "(",
                minMax?.[0] !== undefined && cppType === "int64_t"
                    ? String(minMax[0])
                    : this._nulloptType,
                ", ",
                minMax?.[1] !== undefined && cppType === "int64_t"
                    ? String(minMax[1])
                    : this._nulloptType,
                ", ",
                minMax?.[0] !== undefined && cppType === "double"
                    ? String(minMax[0])
                    : this._nulloptType,
                ", ",
                minMax?.[1] !== undefined && cppType === "double"
                    ? String(minMax[1])
                    : this._nulloptType,
                ", ",
                minMaxLength?.[0] !== undefined
                    ? String(minMaxLength[0])
                    : this._nulloptType,
                ", ",
                minMaxLength?.[1] !== undefined
                    ? String(minMaxLength[1])
                    : this._nulloptType,
                ", ",
                pattern === undefined
                    ? this._nulloptType
                    : [
                          this._stringType.getType(),
                          "(",
                          this._stringType.createStringLiteral([
                              stringEscape(pattern),
                          ]),
                          ")",
                      ],
                ")",
            ]);
        });

        return res.size === 0 ? undefined : res;
    }

    protected emitClass(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitBlock(
            [this._options.codeFormat ? "class " : "struct ", className],
            true,
            () => {
                // Constraints are checked by the setters, with the
                // ClassMemberConstraints and CheckConstraint helpers that
                // just-types output doesn't have.
                const constraints = this._options.justTypes
                    ? undefined
                    : this.generateClassConstraints(c);
                if (this._options.codeFormat) {
                    this.emitLine("public:");
                    if (constraints === undefined) {
                        this.emitLine(className, "() = default;");
                    } else {
                        this.emitLine(className, "() :");
                        let numEmits = 0;
                        constraints.forEach(
                            (initializer: Sourcelike, _propName: string) => {
                                numEmits++;
                                this.indent(() => {
                                    if (numEmits === constraints.size) {
                                        this.emitLine(initializer);
                                    } else {
                                        this.emitLine(initializer, ",");
                                    }
                                });
                            },
                        );
                        this.emitLine("{}");
                    }

                    this.emitLine("virtual ~", className, "() = default;");
                    this.ensureBlankLine();
                }

                this.emitClassMembers(c, constraints);
            },
        );
    }

    protected emitTopLevelHeaders(t: Type, className: Name): void {
        // Forward declarations for std::map<std::wstring, Key> (need to convert UTF16 <-> UTF8)
        if (t instanceof MapType && this._stringType !== this.NarrowString) {
            const ourQualifier = this.ourQualifier(true);

            this.emitBlock(
                ["struct adl_serializer<", ourQualifier, className, ">"],
                true,
                () => {
                    this.emitLine("template <>");
                    this.emitLine(
                        "static void from_json(",
                        this.withConst("json"),
                        " & j, ",
                        ourQualifier,
                        className,
                        " & x);",
                    );
                    this.emitLine(
                        "static void to_json(json & j, ",
                        this.withConst([ourQualifier, className]),
                        " & x);",
                    );
                },
            );
        }
    }

    protected emitClassHeaders(className: Name): void {
        const ourQualifier = this.ourQualifier(false);

        this.emitLine(
            "void from_json(",
            this.withConst("json"),
            " & j, ",
            ourQualifier,
            className,
            " & x);",
        );
        this.emitLine(
            "void to_json(json & j, ",
            this.withConst([ourQualifier, className]),
            " & x);",
        );
    }

    protected emitTopLevelFunction(t: Type, className: Name): void {
        // Function definitions for std::map<std::wstring, Key> (need to convert UTF16 <-> UTF8)
        if (t instanceof MapType && this._stringType !== this.NarrowString) {
            const ourQualifier = this.ourQualifier(true);
            let cppType: Sourcelike;
            let toType: Sourcelike;

            this.emitBlock(
                [
                    "inline void adl_serializer<",
                    ourQualifier,
                    className,
                    ">::from_json(",
                    this.withConst("json"),
                    " & j, ",
                    ourQualifier,
                    className,
                    "& x)",
                ],
                false,
                () => {
                    cppType = this.cppType(
                        t,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: true,
                        },
                        false,
                        true,
                        false,
                    );
                    toType = this.cppType(
                        t,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: true,
                        },
                        false,
                        false,
                        false,
                    );

                    this.emitLine([
                        "x = ",
                        this._stringType.wrapEncodingChange(
                            [ourQualifier],
                            cppType,
                            toType,
                            ["j.get<", cppType, ">()"],
                        ),
                        ";",
                    ]);
                },
            );

            this.emitBlock(
                [
                    "inline void adl_serializer<",
                    ourQualifier,
                    className,
                    ">::to_json(json & j, ",
                    this.withConst([ourQualifier, className]),
                    " & x)",
                ],
                false,
                () => {
                    cppType = this.cppType(
                        t,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: true,
                        },
                        false,
                        false,
                        false,
                    );
                    toType = this.cppType(
                        t,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: true,
                        },
                        false,
                        true,
                        false,
                    );

                    this.emitLine([
                        "j = ",
                        this._stringType.wrapEncodingChange(
                            [ourQualifier],
                            cppType,
                            toType,
                            "x",
                        ),
                        ";",
                    ]);
                },
            );
        }
    }

    // Throws if the object `j` has a property that class `c` doesn't have.
    private emitUnknownPropertiesCheck(c: ClassType): void {
        const keys = Array.from(c.getProperties().keys()).map((json) =>
            this.NarrowString.createStringLiteral([stringEscape(json)]),
        );
        if (keys.length === 0) {
            this.emitLine(
                'if (!j.empty()) throw std::runtime_error("Unexpected property " + j.begin().key());',
            );
            return;
        }

        this.emitBlock(
            "for (auto it = j.begin(); it != j.end(); ++it)",
            false,
            () => {
                this.emitLine(this.withConst("auto"), " & key = it.key();");
                this.emitLine(
                    "if (",
                    arrayIntercalate<Sourcelike>(
                        " && ",
                        keys.map((key) => ["key != ", key]),
                    ),
                    ') throw std::runtime_error("Unexpected property " + key);',
                );
            },
        );
    }

    protected emitClassFunctions(c: ClassType, className: Name): void {
        const ourQualifier = this.ourQualifier(false);
        let cppType: Sourcelike;
        let toType: Sourcelike;

        this.emitBlock(
            [
                "inline void from_json(",
                this.withConst("json"),
                " & j, ",
                ourQualifier,
                className,
                "& x)",
            ],
            false,
            () => {
                this.emitLine(
                    'if (!j.is_object()) throw std::runtime_error("Expected object");',
                );
                const isUnionClass = this.isUnionClass(c);
                if (isUnionClass) {
                    this.emitUnknownPropertiesCheck(c);
                }

                if (c.getProperties().size === 0) {
                    if (!isUnionClass) this.emitLine("(void)j;");
                    this.emitLine("(void)x;");
                }

                this.forEachClassProperty(c, "none", (name, json, p) => {
                    const [, , setterName] = defined(
                        this._gettersAndSettersForPropertyName.get(name),
                    );
                    const propType = p.type;

                    let assignment: WrappingCode;
                    if (this._options.codeFormat) {
                        assignment = new WrappingCode(
                            ["x.", setterName, "("],
                            [")"],
                        );
                    } else {
                        assignment = new WrappingCode(["x.", name, " = "], []);
                    }

                    if (propType.kind === "null" || propType.kind === "any") {
                        // Other required properties are read with `at`,
                        // which throws if they are missing.
                        if (isUnionClass && !p.isOptional) {
                            this.emitLine(
                                "j.at(",
                                this.NarrowString.createStringLiteral([
                                    stringEscape(json),
                                ]),
                                ");",
                            );
                        }

                        this.emitLine(
                            assignment.wrap(
                                [],
                                [
                                    ourQualifier,
                                    "get_untyped(j, ",
                                    this._stringType.wrapEncodingChange(
                                        [ourQualifier],
                                        this._stringType.getType(),
                                        this.NarrowString.getType(),
                                        [
                                            this._stringType.createStringLiteral(
                                                [stringEscape(json)],
                                            ),
                                        ],
                                    ),
                                    ")",
                                ],
                            ),
                            ";",
                        );
                        return;
                    }

                    if (propType.kind === "integer") {
                        const key = this.NarrowString.createStringLiteral([
                            stringEscape(json),
                        ]);
                        this.emitLine(
                            "if (j.find(",
                            key,
                            ") != j.end() && !j.at(",
                            key,
                            ').is_number_integer()) throw std::runtime_error("Expected integer");',
                        );
                    }

                    if (propType.kind === "uuid") {
                        const key = this.NarrowString.createStringLiteral([
                            stringEscape(json),
                        ]);
                        this.emitLine(
                            "if (j.find(",
                            key,
                            ") != j.end() && !std::regex_match(j.at(",
                            key,
                            ').get<std::string>(), std::regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"))) throw std::runtime_error("Expected UUID");',
                        );
                    }

                    if (propType.kind === "date-time") {
                        const key = this.NarrowString.createStringLiteral([
                            stringEscape(json),
                        ]);
                        this.emitLine(
                            "if (j.find(",
                            key,
                            ") != j.end() && !std::regex_match(j.at(",
                            key,
                            ').get<std::string>(), std::regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*$"))) throw std::runtime_error("Expected date-time");',
                        );
                    }

                    const minMaxItems = minMaxItemsForType(propType);
                    if (minMaxItems !== undefined) {
                        const [minItems, maxItems] = minMaxItems;
                        const key = this.sourcelikeToString(
                            this.NarrowString.createStringLiteral([
                                stringEscape(json),
                            ]),
                        );
                        // An optional property may be absent.
                        const present = p.isOptional
                            ? `j.find(${key}) != j.end() && `
                            : "";
                        if (minItems !== undefined)
                            this.emitLine(
                                `if (${present}j.at(${key}).size() < ${minItems}) throw std::runtime_error("Too few items");`,
                            );
                        if (maxItems !== undefined)
                            this.emitLine(
                                `if (${present}j.at(${key}).size() > ${maxItems}) throw std::runtime_error("Too many items");`,
                            );
                    }

                    if (!p.isOptional && propType.isNullable) {
                        this.emitLine(
                            "j.at(",
                            this.NarrowString.createStringLiteral([
                                stringEscape(json),
                            ]),
                            ");",
                        );
                    }

                    if (p.isOptional && !propType.isNullable) {
                        const key = this.NarrowString.createStringLiteral([
                            stringEscape(json),
                        ]);
                        this.emitLine(
                            "if (j.find(",
                            key,
                            ") != j.end() && j.at(",
                            key,
                            ').is_null()) throw std::runtime_error("Unexpected null");',
                        );
                    }

                    if (p.isOptional || propType instanceof UnionType) {
                        const [nullOrOptional, typeSet] = ((): [
                            boolean,
                            ReadonlySet<Type>,
                        ] => {
                            if (propType instanceof UnionType) {
                                const [maybeNull, nonNulls] =
                                    removeNullFromUnion(propType, true);
                                return [
                                    maybeNull !== null || p.isOptional,
                                    nonNulls,
                                ];
                            }

                            const set = new Set<Type>();
                            set.add(propType);
                            return [true, set];
                        })();
                        const isRecursiveNamedUnion =
                            propType instanceof UnionType &&
                            this.namedUnions.has(propType) &&
                            this.isRecursiveUnion(propType);
                        if (
                            isRecursiveNamedUnion &&
                            p.isOptional &&
                            removeNullFromUnion(propType, true)[0] !== null
                        ) {
                            cppType = this.cppType(
                                propType,
                                {
                                    needsForwardIndirection: true,
                                    needsOptionalIndirection: true,
                                    inJsonNamespace: false,
                                },
                                false,
                                true,
                                true,
                            );
                            const propertyName =
                                this._stringType.wrapEncodingChange(
                                    [ourQualifier],
                                    this._stringType.getType(),
                                    this.NarrowString.getType(),
                                    this._stringType.createStringLiteral([
                                        stringEscape(json),
                                    ]),
                                );
                            this.emitLine(
                                assignment.wrap(
                                    [],
                                    [
                                        "j.find(",
                                        propertyName,
                                        ") != j.end() ? j.at(",
                                        propertyName,
                                        ").get<",
                                        cppType,
                                        ">() : ",
                                        cppType,
                                        "()",
                                    ],
                                ),
                                ";",
                            );
                            return;
                        }

                        if (nullOrOptional) {
                            const optionalTypes = isRecursiveNamedUnion
                                ? new Set<Type>([propType])
                                : typeSet;
                            cppType = this.cppTypeInOptional(
                                optionalTypes,
                                {
                                    needsForwardIndirection: false,
                                    needsOptionalIndirection: false,
                                    inJsonNamespace: false,
                                },
                                false,
                                true,
                            );
                            toType = this.cppTypeInOptional(
                                optionalTypes,
                                {
                                    needsForwardIndirection: false,
                                    needsOptionalIndirection: false,
                                    inJsonNamespace: false,
                                },
                                false,
                                false,
                            );
                            this.emitLine(
                                assignment.wrap(
                                    [],
                                    [
                                        this._stringType.wrapEncodingChange(
                                            [ourQualifier],
                                            [
                                                this.optionalType(propType),
                                                "<",
                                                cppType,
                                                ">",
                                            ],
                                            [
                                                this.optionalType(propType),
                                                "<",
                                                toType,
                                                ">",
                                            ],
                                            [
                                                ourQualifier,
                                                `get_${this.optionalTypeLabel(propType)}_optional<`,
                                                cppType,
                                                ">(j, ",
                                                this._stringType.wrapEncodingChange(
                                                    [ourQualifier],
                                                    this._stringType.getType(),
                                                    this.NarrowString.getType(),
                                                    [
                                                        this._stringType.createStringLiteral(
                                                            [
                                                                stringEscape(
                                                                    json,
                                                                ),
                                                            ],
                                                        ),
                                                    ],
                                                ),
                                                ")",
                                            ],
                                        ),
                                    ],
                                ),
                                ";",
                            );
                            return;
                        }
                    }

                    cppType = this.cppType(
                        propType,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: false,
                        },
                        false,
                        true,
                        p.isOptional,
                    );
                    toType = this.cppType(
                        propType,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: false,
                        },
                        false,
                        false,
                        p.isOptional,
                    );
                    this.emitLine(
                        assignment.wrap(
                            [],
                            this._stringType.wrapEncodingChange(
                                [ourQualifier],
                                cppType,
                                toType,
                                [
                                    "j.at(",
                                    this._stringType.wrapEncodingChange(
                                        [ourQualifier],
                                        this._stringType.getType(),
                                        this.NarrowString.getType(),
                                        this._stringType.createStringLiteral([
                                            stringEscape(json),
                                        ]),
                                    ),
                                    ").get<",
                                    cppType,
                                    ">()",
                                ],
                            ),
                        ),
                        ";",
                    );
                });
            },
        );
        this.ensureBlankLine();

        this.emitBlock(
            [
                "inline void to_json(json & j, ",
                this.withConst([ourQualifier, className]),
                " & x)",
            ],
            false,
            () => {
                this.emitLine("j = json::object();");
                if (c.getProperties().size === 0) {
                    this.emitLine("(void)x;");
                }

                this.forEachClassProperty(c, "none", (name, json, p) => {
                    const propType = p.type;
                    cppType = this.cppType(
                        propType,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: false,
                        },
                        false,
                        false,
                        p.isOptional,
                    );
                    toType = this.cppType(
                        propType,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: false,
                        },
                        false,
                        true,
                        p.isOptional,
                    );
                    const [getterName, ,] = defined(
                        this._gettersAndSettersForPropertyName.get(name),
                    );
                    let getter: Sourcelike[];
                    if (this._options.codeFormat) {
                        getter = [getterName, "()"];
                    } else {
                        getter = [name];
                    }

                    const value = this._stringType.wrapEncodingChange(
                        [ourQualifier],
                        cppType,
                        toType,
                        ["x.", getter],
                    );
                    const assignment: Sourcelike[] = [
                        "j[",
                        this._stringType.wrapEncodingChange(
                            [ourQualifier],
                            this._stringType.getType(),
                            this.NarrowString.getType(),
                            this._stringType.createStringLiteral([
                                stringEscape(json),
                            ]),
                        ),
                        "] = ",
                        value,
                        ";",
                    ];
                    // An absent optional property that isn't nullable
                    // can't be written as null: from_json rejects that.
                    if (
                        p.isOptional &&
                        (this._options.hideNullOptional || !propType.isNullable)
                    ) {
                        const condition =
                            propType.kind === "null" || propType.kind === "any"
                                ? ["!", value, ".is_null()"]
                                : value;
                        this.emitBlock(["if (", condition, ")"], false, () => {
                            this.emitLine(assignment);
                        });
                    } else {
                        this.emitLine(assignment);
                    }
                });
            },
        );
    }

    protected emitEnum(e: EnumType, enumName: Name): void {
        const caseNames: Sourcelike[] = [];
        const enumValues = enumCaseValues(e, this.targetLanguage.name);

        this.forEachEnumCase(e, "none", (name, jsonName) => {
            if (caseNames.length > 0) caseNames.push(", ");
            caseNames.push(name);

            if (enumValues !== undefined) {
                const [enumValue] = getAccessorName(enumValues, jsonName);
                if (enumValue !== undefined) {
                    caseNames.push(" = ", enumValue.toString());
                }
            }
        });
        this.emitDescription(this.descriptionForType(e));
        this.emitLine(
            "enum class ",
            enumName,
            " : ",
            this._enumType,
            " { ",
            caseNames,
            " };",
        );
    }

    protected emitUnionTypedefs(u: UnionType, unionName: Name): void {
        const variantType = this.variantType(u, false);
        if (!this.isRecursiveUnion(u)) {
            this.emitLine("using ", unionName, " = ", variantType, ";");
            return;
        }

        // A struct introduces its name before the base type is parsed, allowing
        // recursion through containers such as std::vector.
        this.emitBlock(["struct ", unionName, " : ", variantType], true, () => {
            this.emitLine("using base = ", variantType, ";");
            this.emitLine("using base::base;");
            this.emitLine("using base::operator=;");
        });
    }

    protected emitUnionWrapperHeaders(u: UnionType, unionName: Name): void {
        if (!this.isRecursiveUnion(u)) return;

        this.emitLine(
            "void from_json(",
            this.withConst("json"),
            " & j, ",
            unionName,
            " & x);",
        );
        this.emitLine(
            "void to_json(json & j, ",
            this.withConst(unionName),
            " & x);",
        );
    }

    protected emitUnionWrapperFunctions(u: UnionType, unionName: Name): void {
        if (!this.isRecursiveUnion(u)) return;

        this.emitBlock(
            [
                "inline void from_json(",
                this.withConst("json"),
                " & j, ",
                unionName,
                " & x)",
            ],
            false,
            () => this.emitLine("x = j.get<", unionName, "::base>();"),
        );
        this.ensureBlankLine();
        this.emitBlock(
            [
                "inline void to_json(json & j, ",
                this.withConst(unionName),
                " & x)",
            ],
            false,
            () =>
                this.emitLine(
                    "j = static_cast<",
                    this.withConst([unionName, "::base"]),
                    " &>(x);",
                ),
        );
    }

    protected emitTupleTypedef(t: TupleType, tupleName: Name): void {
        this.emitDescription(this.descriptionForType(t));
        if (!t.isFixedLength) {
            this.emitTupleMembersStruct(t, tupleName);
            return;
        }

        const tupleType = this.cppTupleType(t, false, true, false);
        if (!this.isRecursiveTuple(t)) {
            this.emitLine("using ", tupleName, " = ", tupleType, ";");
            return;
        }

        // As for recursive unions, a struct introduces its name before the
        // base type is parsed.
        this.emitBlock(["struct ", tupleName, " : ", tupleType], true, () => {
            this.emitLine("using base = ", tupleType, ";");
            this.emitLine("using base::base;");
            this.emitLine("using base::operator=;");
        });
    }

    protected emitTupleStructHeaders(tupleName: Name): void {
        this.emitLine(
            "void from_json(",
            this.withConst("json"),
            " & j, ",
            tupleName,
            " & x);",
        );
        this.emitLine(
            "void to_json(json & j, ",
            this.withConst(tupleName),
            " & x);",
        );
    }

    protected emitTupleStructFunctions(t: TupleType, tupleName: Name): void {
        if (!t.isFixedLength) {
            this.emitTupleMembersFunctions(t, tupleName);
            return;
        }

        const base: Sourcelike = [tupleName, "::base"];
        // With wide strings, the JSON side is the tuple with narrow strings.
        const narrow = this.cppTupleType(t, false, false, true);
        const jsonBase =
            this.sourcelikeToString(narrow) ===
            this.sourcelikeToString(this.cppTupleType(t, false, false, false))
                ? base
                : narrow;
        this.emitBlock(
            [
                "inline void from_json(",
                this.withConst("json"),
                " & j, ",
                tupleName,
                " & x)",
            ],
            false,
            () =>
                this.emitLine(
                    "x = ",
                    this._stringType.wrapEncodingChange([], jsonBase, base, [
                        "j.get<",
                        jsonBase,
                        ">()",
                    ]),
                    ";",
                ),
        );
        this.ensureBlankLine();
        this.emitBlock(
            [
                "inline void to_json(json & j, ",
                this.withConst(tupleName),
                " & x)",
            ],
            false,
            () =>
                this.emitLine(
                    "j = ",
                    this._stringType.wrapEncodingChange([], base, jsonBase, [
                        "static_cast<",
                        this.withConst(base),
                        " &>(x)",
                    ]),
                    ";",
                ),
        );
    }

    // A std::tuple has an element per item, so a tuple with optional items
    // or a rest is a struct with a member per item and a std::vector for the
    // rest:
    //
    //     struct SlotRange {
    //         int64_t item0;
    //         int64_t item1;
    //         SlotNode item2;
    //         std::vector<SlotNode> rest;
    //     };
    //
    // It's a plain struct in both code formats, as the std::tuple it stands
    // in for is: fixed-length tuples have no getters and setters either,
    // and those of classes check constraints that tuples don't.
    protected emitTupleMembersStruct(t: TupleType, tupleName: Name): void {
        const names = this.tupleMemberNames(t);
        this.emitBlock(["struct ", tupleName], true, () => {
            t.items.forEach((_, i) => {
                this.emitMember(
                    this.tupleItemType(t, i, true, false),
                    names.items[i],
                );
            });
            if (t.rest !== undefined) {
                this.emitMember(
                    [
                        "std::vector<",
                        this.tupleRestElementType(t.rest, true, false),
                        ">",
                    ],
                    defined(names.rest),
                );
            }
        });
    }

    // An item may only follow an optional one that is present: JSON can't
    // leave a gap.
    private tupleGapCondition(t: TupleType): Sourcelike | undefined {
        const names = this.tupleMemberNames(t);
        const conditions: Sourcelike[] = [];
        for (let i = t.minItems + 1; i < t.items.length; i++) {
            conditions.push([
                "!x.",
                names.items[i - 1],
                " && x.",
                names.items[i],
            ]);
        }

        if (t.rest !== undefined && t.minItems < t.items.length) {
            conditions.push([
                "!x.",
                names.items[t.items.length - 1],
                " && !x.",
                defined(names.rest),
                ".empty()",
            ]);
        }

        if (conditions.length <= 1) return conditions[0];
        return arrayIntercalate<Sourcelike>(
            " || ",
            conditions.map((c) => ["(", c, ")"]),
        );
    }

    // from_json checks the length of the array, then reads the required
    // items, the optional ones that are there, and the rest.  to_json
    // writes them in the same order.  An item after a missing optional one
    // can't be written: moving it into the gap, or writing null there,
    // would make a different value, so that's an error.
    protected emitTupleMembersFunctions(t: TupleType, tupleName: Name): void {
        const names = this.tupleMemberNames(t);
        const [min, max] = this.tupleLengthBounds(t);
        const wrap = (
            from: Sourcelike,
            to: Sourcelike,
            inner: Sourcelike,
        ): Sourcelike =>
            this._stringType.wrapEncodingChange([], from, to, inner);
        const get = (index: string, narrow: Sourcelike, wide: Sourcelike) =>
            wrap(narrow, wide, ["j.at(", index, ").get<", narrow, ">()"]);
        // nlohmann/json would convert a floating point number to an
        // integer, so integers are checked, as for class members.
        const checkInteger = (
            item: Type,
            index: string,
            guard: string[] = [],
        ): void => {
            if (item.kind !== "integer") return;
            this.emitLine(
                "if (",
                [...guard, `!j.at(${index}).is_number_integer()`].join(" && "),
                ') throw std::runtime_error("',
                tupleName,
                ': expected an integer");',
            );
        };

        this.emitBlock(
            [
                "inline void from_json(",
                this.withConst("json"),
                " & j, ",
                tupleName,
                " & x)",
            ],
            false,
            () => {
                const tooShortOrLong = ["!j.is_array()"];
                if (min > 0) tooShortOrLong.push(`j.size() < ${min}`);
                if (max !== undefined) tooShortOrLong.push(`j.size() > ${max}`);
                this.emitLine(
                    "if (",
                    tooShortOrLong.join(" || "),
                    ') throw std::runtime_error("',
                    tupleName,
                    ": expected ",
                    expectedTupleLength(min, max),
                    '");',
                );
                t.items.forEach((item, i) => {
                    const index = i.toString();
                    if (i < t.minItems) {
                        checkInteger(item, index);
                        this.emitLine(
                            "x.",
                            names.items[i],
                            " = ",
                            get(
                                index,
                                this.tupleRequiredItemType(item, false, true),
                                this.tupleRequiredItemType(item, false, false),
                            ),
                            ";",
                        );
                        return;
                    }

                    const [optional, narrow] = this.tupleOptionalItemType(
                        item,
                        false,
                        true,
                    );
                    const [, wide] = this.tupleOptionalItemType(
                        item,
                        false,
                        false,
                    );
                    const factory =
                        optional === this.optionalTypeHeap()
                            ? this.optionalFactoryHeap()
                            : this.optionalFactoryStack();
                    checkInteger(item, index, [`j.size() > ${index}`]);
                    this.emitLine(
                        "x.",
                        names.items[i],
                        " = j.size() > ",
                        index,
                        " ? ",
                        factory,
                        "<",
                        wide,
                        ">(",
                        get(index, narrow, wide),
                        ") : ",
                        optional,
                        "<",
                        wide,
                        ">();",
                    );
                });

                const restType = t.rest;
                if (restType !== undefined) {
                    const rest = defined(names.rest);
                    const loop = [
                        "for (std::size_t i = ",
                        t.items.length.toString(),
                        "; i < j.size(); i++)",
                    ];
                    const pushBack = [
                        "x.",
                        rest,
                        ".push_back(",
                        get(
                            "i",
                            this.tupleRestElementType(restType, false, true),
                            this.tupleRestElementType(restType, false, false),
                        ),
                        ");",
                    ];
                    this.emitLine("x.", rest, ".clear();");
                    if (restType.kind === "integer") {
                        this.emitBlock(loop, false, () => {
                            checkInteger(restType, "i");
                            this.emitLine(pushBack);
                        });
                    } else {
                        this.emitLine(loop, " ", pushBack);
                    }
                }
            },
        );
        this.ensureBlankLine();

        this.emitBlock(
            [
                "inline void to_json(json & j, ",
                this.withConst(tupleName),
                " & x)",
            ],
            false,
            () => {
                const gap = this.tupleGapCondition(t);
                if (gap !== undefined) {
                    this.emitLine(
                        "if (",
                        gap,
                        ') throw std::runtime_error("',
                        tupleName,
                        ': an item follows a missing optional item");',
                    );
                }

                this.emitLine("j = json::array();");
                t.items.forEach((item, i) => {
                    if (i < t.minItems) {
                        this.emitLine(
                            "j.push_back(",
                            wrap(
                                this.tupleRequiredItemType(item, false, false),
                                this.tupleRequiredItemType(item, false, true),
                                ["x.", names.items[i]],
                            ),
                            ");",
                        );
                        return;
                    }

                    const [, wide] = this.tupleOptionalItemType(
                        item,
                        false,
                        false,
                    );
                    const [, narrow] = this.tupleOptionalItemType(
                        item,
                        false,
                        true,
                    );
                    this.emitLine(
                        "if (x.",
                        names.items[i],
                        ") j.push_back(",
                        wrap(wide, narrow, ["*x.", names.items[i]]),
                        ");",
                    );
                });

                if (t.rest !== undefined) {
                    // Not `auto`, which would be a proxy for the elements
                    // of a std::vector<bool>.
                    const wide = this.tupleRestElementType(
                        t.rest,
                        false,
                        false,
                    );
                    this.emitLine(
                        "for (",
                        this.withConst(wide),
                        " & item : x.",
                        defined(names.rest),
                        ") j.push_back(",
                        wrap(
                            wide,
                            this.tupleRestElementType(t.rest, false, true),
                            "item",
                        ),
                        ");",
                    );
                }
            },
        );
    }

    protected emitUnionHeaders(u: UnionType): void {
        // Forward declarations for boost::variant<Ts...>. If none of the Ts were defined by us (e.g. if we have
        // boost::variant<int32_t, std::string>) then we need to specialize nlohmann::adl_serializer for our
        // variant type. If at least one of the Ts is our type then we could get away with regular adl definitions,
        // but it's nontrivial to detect that (consider variant<string, variant<map<string, string>, int>> which
        // does need an adl_serializer specialization) so we'll just specialize every time.

        const nonNulls = removeNullFromUnion(u, true)[1];
        const variantType = this.cppTypeInOptional(
            nonNulls,
            {
                needsForwardIndirection: false,
                needsOptionalIndirection: false,
                inJsonNamespace: true,
            },
            false,
            false,
        );

        this.emitLine("template <>");
        this.emitBlock(
            ["struct adl_serializer<", variantType, ">"],
            true,
            () => {
                this.emitLine(
                    "static void from_json(",
                    this.withConst("json"),
                    " & j, ",
                    variantType,
                    " & x);",
                );
                this.emitLine(
                    "static void to_json(json & j, ",
                    this.withConst(variantType),
                    " & x);",
                );
            },
        );
    }

    protected emitUnionFunctions(u: UnionType): void {
        // Function definitions for boost::variant<Ts...>.

        const ourQualifier = this.ourQualifier(true) as string;

        const functionForKind: Array<[string, string]> = [
            ["bool", "is_boolean"],
            ["integer", "is_number_integer"],
            ["double", "is_number"],
            ["string", "is_string"],
            ["uuid", "is_string"],
            ["date-time", "is_string"],
            ["class", "is_object"],
            ["map", "is_object"],
            ["array", "is_array"],
            ["enum", "is_string"],
        ];
        const nonNulls = removeNullFromUnion(u, true)[1];
        const variantType = this.cppTypeInOptional(
            nonNulls,
            {
                needsForwardIndirection: false,
                needsOptionalIndirection: false,
                inJsonNamespace: true,
            },
            false,
            false,
        );

        this.emitBlock(
            [
                "inline void adl_serializer<",
                variantType,
                ">::from_json(",
                this.withConst("json"),
                " & j, ",
                variantType,
                " & x)",
            ],
            false,
            () => {
                const emitAssignment = (t: Type): void => {
                    const cppType = this.cppType(
                        t,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: true,
                        },
                        false,
                        true,
                        false,
                    );
                    const toType = this.cppType(
                        t,
                        {
                            needsForwardIndirection: true,
                            needsOptionalIndirection: true,
                            inJsonNamespace: true,
                        },
                        false,
                        false,
                        false,
                    );
                    this.emitLine(
                        "x = ",
                        this._stringType.wrapEncodingChange(
                            [ourQualifier],
                            cppType,
                            toType,
                            ["j.get<", cppType, ">()"],
                        ),
                        ";",
                    );
                };

                // Tuples are arrays, too.  The tuples of a union have
                // different shapes, so where the lengths they allow don't
                // overlap, the length tells them apart.  But an array of a
                // tuple's length may be the union's array instead, or
                // another tuple of that length, so then the tuples are tried
                // in turn first.
                const tuples = Array.from(nonNulls).filter(
                    (t): t is TupleType => t instanceof TupleType,
                );
                const tupleCases: Array<[Type, Sourcelike]> = tuples.map(
                    (t) => [t, this.tupleLengthCondition(t)],
                );
                const bounds = tuples.map((t): [number, number] => {
                    if (t.isFixedLength)
                        return [t.items.length, t.items.length];
                    const [min, max] = this.tupleLengthBounds(t);
                    return [min, max ?? Number.POSITIVE_INFINITY];
                });
                const tuplesOverlap = bounds.some(([min, max], i) =>
                    bounds
                        .slice(i + 1)
                        .some(
                            ([otherMin, otherMax]) =>
                                min <= otherMax && otherMin <= max,
                        ),
                );
                const tryTuples =
                    tupleCases.length > 0 &&
                    (tuplesOverlap ||
                        iterableSome(nonNulls, (t) => t instanceof ArrayType));
                if (tryTuples) {
                    for (const [t, condition] of tupleCases) {
                        this.emitBlock(["if (", condition, ")"], false, () => {
                            this.emitLine("try {");
                            this.indent(() => {
                                emitAssignment(t);
                                this.emitLine("return;");
                            });
                            this.emitLine(
                                "} catch (",
                                this.withConst("std::exception"),
                                " &) {}",
                            );
                        });
                    }
                }

                const classes = this.unionClassesInTryOrder(nonNulls);
                const cases: Array<[Type, Sourcelike]> = [];
                for (const [kind, func] of functionForKind) {
                    if (kind === "array" && !tryTuples) {
                        cases.push(...tupleCases);
                    }

                    const typeForKind = iterableFind(
                        nonNulls,
                        (t) => t.kind === kind,
                    );
                    if (typeForKind === undefined) continue;
                    cases.push([typeForKind, ["j.", func, "()"]]);
                }

                let onFirst = true;
                for (const [typeForKind, test] of cases) {
                    const condition = [
                        onFirst ? "if" : "else if",
                        " (",
                        test,
                        ")",
                    ];
                    onFirst = false;

                    if (typeForKind.kind === "class" && classes !== undefined) {
                        // Each class only takes values of its own.
                        this.emitBlock(condition, false, () => {
                            for (const c of classes) {
                                this.emitLine("try {");
                                this.indent(() => {
                                    emitAssignment(c);
                                    this.emitLine("return;");
                                });
                                this.emitLine(
                                    "} catch (",
                                    this.withConst("std::exception"),
                                    " &) {}",
                                );
                            }

                            this.emitLine(
                                'throw std::runtime_error("Could not deserialise!");',
                            );
                        });
                        continue;
                    }

                    this.emitLine(condition);
                    this.indent(() => emitAssignment(typeForKind));
                }

                this.emitLine(
                    'else throw std::runtime_error("Could not deserialise!");',
                );
            },
        );
        this.ensureBlankLine();

        this.emitBlock(
            [
                "inline void adl_serializer<",
                variantType,
                ">::to_json(json & j, ",
                this.withConst(variantType),
                " & x)",
            ],
            false,
            () => {
                this.emitBlock(
                    ["switch (x.", this._variantIndexMethodName, "())"],
                    false,
                    () => {
                        let i = 0;
                        for (const t of nonNulls) {
                            this.emitLine("case ", i.toString(), ":");
                            this.indent(() => {
                                const cppType = this.cppType(
                                    t,
                                    {
                                        needsForwardIndirection: true,
                                        needsOptionalIndirection: true,
                                        inJsonNamespace: true,
                                    },
                                    false,
                                    false,
                                    false,
                                );
                                const toType = this.cppType(
                                    t,
                                    {
                                        needsForwardIndirection: true,
                                        needsOptionalIndirection: true,
                                        inJsonNamespace: true,
                                    },
                                    false,
                                    true,
                                    false,
                                );
                                this.emitLine(
                                    "j = ",
                                    this._stringType.wrapEncodingChange(
                                        [ourQualifier],
                                        cppType,
                                        toType,
                                        [
                                            this._options.boost
                                                ? "boost::get<"
                                                : "std::get<",
                                            cppType,
                                            ">(x)",
                                        ],
                                    ),
                                    ";",
                                );
                                this.emitLine("break;");
                            });
                            i++;
                        }

                        this.emitLine(
                            'default: throw std::runtime_error("Input JSON does not conform to schema!");',
                        );
                    },
                );
            },
        );
    }

    protected emitEnumHeaders(enumName: Name): void {
        const ourQualifier = this.ourQualifier(false);

        this.emitLine(
            "void from_json(",
            this.withConst("json"),
            " & j, ",
            ourQualifier,
            enumName,
            " & x);",
        );
        this.emitLine(
            "void to_json(json & j, ",
            this.withConst([ourQualifier, enumName]),
            " & x);",
        );
    }

    private isLargeEnum(e: EnumType): boolean {
        // This is just an estimation. Someone might want to do some
        // benchmarks to find the optimum value here
        return e.cases.size > 15;
    }

    protected emitEnumFunctions(e: EnumType, enumName: Name): void {
        const ourQualifier = this.ourQualifier(false);

        this.emitBlock(
            [
                "inline void from_json(",
                this.withConst("json"),
                " & j, ",
                ourQualifier,
                enumName,
                " & x)",
            ],
            false,
            () => {
                if (this.isLargeEnum(e)) {
                    this.emitBlock(
                        [
                            "static std::unordered_map<",
                            this._stringType.getType(),
                            ", ",
                            ourQualifier,
                            enumName,
                            "> enumValues",
                        ],
                        true,
                        () => {
                            this.forEachEnumCase(
                                e,
                                "none",
                                (name, jsonName) => {
                                    this.emitLine(
                                        "{",
                                        this._stringType.wrapEncodingChange(
                                            [ourQualifier],
                                            this._stringType.getType(),
                                            this.NarrowString.getType(),
                                            [
                                                this._stringType.createStringLiteral(
                                                    [stringEscape(jsonName)],
                                                ),
                                            ],
                                        ),
                                        ", ",
                                        ourQualifier,
                                        enumName,
                                        "::",
                                        name,
                                        "},",
                                    );
                                },
                            );
                        },
                    );

                    this.emitLine(
                        `auto iter = enumValues.find(j.get<${this._stringType.getType()}>());`,
                    );
                    this.emitBlock(
                        "if (iter != enumValues.end())",
                        false,
                        () => {
                            this.emitLine("x = iter->second;");
                        },
                    );
                } else {
                    let onFirst = true;
                    this.forEachEnumCase(e, "none", (name, jsonName) => {
                        const maybeElse = onFirst ? "" : "else ";
                        this.emitLine(
                            maybeElse,
                            "if (j == ",
                            this._stringType.wrapEncodingChange(
                                [ourQualifier],
                                this._stringType.getType(),
                                this.NarrowString.getType(),
                                [
                                    this._stringType.createStringLiteral([
                                        stringEscape(jsonName),
                                    ]),
                                ],
                            ),
                            ") x = ",
                            ourQualifier,
                            enumName,
                            "::",
                            name,
                            ";",
                        );
                        onFirst = false;
                    });
                }
                this.emitLine(
                    'else { throw std::runtime_error("Cannot deserialize to enumeration \\"',
                    enumName,
                    '\\""); }',
                );
            },
        );
        this.ensureBlankLine();

        this.emitBlock(
            [
                "inline void to_json(json & j, ",
                this.withConst([ourQualifier, enumName]),
                " & x)",
            ],
            false,
            () => {
                this.emitBlock("switch (x)", false, () => {
                    this.forEachEnumCase(e, "none", (name, jsonName) => {
                        this.emitLine(
                            "case ",
                            ourQualifier,
                            enumName,
                            "::",
                            name,
                            ": j = ",
                            this._stringType.wrapEncodingChange(
                                [ourQualifier],
                                this._stringType.getType(),
                                this.NarrowString.getType(),
                                [
                                    this._stringType.createStringLiteral([
                                        stringEscape(jsonName),
                                    ]),
                                ],
                            ),
                            "; break;",
                        );
                    });
                    this.emitLine(
                        `default: throw std::runtime_error("Unexpected value in enumeration \\"`,
                        enumName,
                        `\\": " + std::to_string(static_cast<int>(x)));`,
                    );
                });
            },
        );
    }

    protected emitTopLevelTypedef(t: Type, name: Name): void {
        this.emitLine(
            "using ",
            name,
            " = ",
            this.cppType(
                t,
                {
                    needsForwardIndirection: true,
                    needsOptionalIndirection: true,
                    inJsonNamespace: false,
                },
                true,
                false,
                false,
            ),
            ";",
        );
    }

    protected emitAllUnionFunctions(): void {
        this.forEachUniqueUnion(
            "leading-and-interposing",
            (u) =>
                this.sourcelikeToString(
                    this.cppTypeInOptional(
                        removeNullFromUnion(u, true)[1],
                        {
                            needsForwardIndirection: false,
                            needsOptionalIndirection: false,
                            inJsonNamespace: true,
                        },
                        false,
                        false,
                    ),
                ),
            (u: UnionType) => this.emitUnionFunctions(u),
        );
    }

    protected emitAllUnionHeaders(): void {
        this.forEachUniqueUnion(
            "interposing",
            (u) =>
                this.sourcelikeToString(
                    this.cppTypeInOptional(
                        removeNullFromUnion(u, true)[1],
                        {
                            needsForwardIndirection: false,
                            needsOptionalIndirection: false,
                            inJsonNamespace: true,
                        },
                        false,
                        false,
                    ),
                ),
            (u: UnionType) => this.emitUnionHeaders(u),
        );
    }

    protected emitOptionalHelpers(): void {
        this.emitLine("#ifndef NLOHMANN_OPT_HELPER");
        this.emitLine("#define NLOHMANN_OPT_HELPER");

        this.emitNamespaces(["nlohmann"], () => {
            const emitAdlStruct = (optType: string, factory: string): void => {
                this.emitLine("template <typename T>");
                this.emitBlock(
                    ["struct adl_serializer<", optType, "<T>>"],
                    true,
                    () => {
                        this.emitBlock(
                            [
                                "static void to_json(json & j, ",
                                this.withConst([optType, "<T>"]),
                                " & opt)",
                            ],
                            false,
                            () => {
                                this.emitLine(
                                    "if (!opt) j = nullptr; else j = *opt;",
                                );
                            },
                        );

                        this.ensureBlankLine();

                        this.emitBlock(
                            [
                                "static ",
                                optType,
                                "<T> from_json(",
                                this.withConst("json"),
                                " & j)",
                            ],
                            false,
                            () => {
                                // A JSON null must become an *empty*
                                // optional.  Only `optType<T>()` guarantees
                                // that: the factory would wrap a
                                // default-constructed T (std::make_optional
                                // and std::make_shared both do), turning
                                // null into 0/""/{} on round-trip.
                                this.emitLine(
                                    `if (j.is_null()) return ${optType}<T>(); else return ${factory}<T>(j.get<T>());`,
                                );
                            },
                        );
                    },
                );
            };

            emitAdlStruct(this.optionalTypeHeap(), this.optionalFactoryHeap());
            emitAdlStruct(
                this.optionalTypeStack(),
                this.optionalFactoryStack(),
            );
        });

        this.emitLine("#endif");
    }

    // nlohmann/json reads a std::tuple from the first elements of an array,
    // so it takes longer arrays, and it takes a number for an integer,
    // rounding it.  This adl_serializer checks the array's length and the
    // integer items, also where unions try tuples.
    protected emitTupleHelpers(): void {
        this.emitLine("#ifndef NLOHMANN_TUPLE_HELPER");
        this.emitLine("#define NLOHMANN_TUPLE_HELPER");

        this.emitNamespaces(["nlohmann"], () => {
            this.emitLine("template <typename... T>");
            this.emitBlock(
                ["struct adl_serializer<std::tuple<T...>>"],
                true,
                () => {
                    this.emitBlock(
                        [
                            "static void to_json(json & j, ",
                            this.withConst("std::tuple<T...>"),
                            " & t)",
                        ],
                        false,
                        () => {
                            this.emitLine("j = json::array();");
                            this.emitLine(
                                "std::apply([&j](",
                                this.withConst("T"),
                                " &... e) { (j.push_back(e), ...); }, t);",
                            );
                        },
                    );
                    this.ensureBlankLine();
                    this.emitBlock(
                        [
                            "static std::tuple<T...> from_json(",
                            this.withConst("json"),
                            " & j)",
                        ],
                        false,
                        () => {
                            this.emitLine(
                                'if (!j.is_array() || j.size() != sizeof...(T)) throw std::runtime_error("Expected an array of " + std::to_string(sizeof...(T)) + " elements");',
                            );
                            this.emitLine(
                                "return get_items(j, std::index_sequence_for<T...>());",
                            );
                        },
                    );
                    this.ensureBlankLine();
                    this.emitLine("template <std::size_t... I>");
                    this.emitBlock(
                        [
                            "static std::tuple<T...> get_items(",
                            this.withConst("json"),
                            " & j, std::index_sequence<I...>)",
                        ],
                        false,
                        () => {
                            this.emitLine(
                                "return std::tuple<T...>{get_item<T>(j[I])...};",
                            );
                        },
                    );
                    this.ensureBlankLine();
                    this.emitLine("template <typename U>");
                    this.emitBlock(
                        ["static U get_item(", this.withConst("json"), " & j)"],
                        false,
                        () => {
                            this.emitLine(
                                'if (std::is_same<U, int64_t>::value && !j.is_number_integer()) throw std::runtime_error("Expected integer");',
                            );
                            this.emitLine("return j.get<U>();");
                        },
                    );
                },
            );
        });

        this.emitLine("#endif");
    }

    protected emitDeclaration(decl: Declaration): void {
        if (decl.kind === "forward") {
            if (this._options.codeFormat && !(decl.type instanceof TupleType)) {
                this.emitLine("class ", this.nameForNamedType(decl.type), ";");
            } else {
                this.emitLine("struct ", this.nameForNamedType(decl.type), ";");
            }
        } else if (decl.kind === "define") {
            const type = decl.type;
            const name = this.nameForNamedType(type);
            if (type instanceof ClassType) {
                this.emitClass(type, name);
            } else if (type instanceof EnumType) {
                this.emitEnum(type, name);
            } else if (type instanceof UnionType) {
                this.emitUnionTypedefs(type, name);
            } else if (type instanceof TupleType) {
                this.emitTupleTypedef(type, name);
            } else {
                panic(`Cannot declare type ${type.kind}`);
            }
        } else {
            assertNever(decl.kind);
        }
    }

    protected emitGetterSetter(
        t: string,
        getterName: string,
        setterName: string,
        memberName: string,
    ): void {
        this.emitLine(
            "void ",
            setterName,
            "(",
            t,
            " ",
            memberName,
            ") { this->",
            memberName,
            " = ",
            memberName,
            "; }",
        );
        this.emitLine(
            "auto ",
            getterName,
            "() const { return ",
            memberName,
            "; }",
        );
    }

    protected emitNumericCheckConstraints(
        checkConst: string,
        classConstraint: string,
        getterMinValue: string,
        getterMaxValue: string,
        cppType: string,
    ): void {
        this.emitBlock(
            [
                "inline void ",
                checkConst,
                "(",
                this._stringType.getConstType(),
                " name, ",
                this.withConst(classConstraint),
                " & c, ",
                cppType,
                " value)",
            ],
            false,
            () => {
                this.emitBlock(
                    [
                        "if (c.",
                        getterMinValue,
                        "() != ",
                        this._nulloptType,
                        " && value < *c.",
                        getterMinValue,
                        "())",
                    ],
                    false,
                    () => {
                        this.emitLine(
                            "throw ",
                            this.lookupGlobalName(
                                GlobalNames.ValueTooLowException,
                            ),
                            " (",
                            this._stringType.createStringLiteral([
                                "Value too low for ",
                            ]),
                            " + name + ",
                            this._stringType.createStringLiteral([" ("]),
                            " + ",
                            this._stringType.wrapToString(["value"]),
                            " + ",
                            this._stringType.createStringLiteral(["<"]),
                            " + ",
                            this._stringType.wrapToString([
                                "*c.",
                                getterMinValue,
                                "()",
                            ]),
                            " + ",
                            this._stringType.createStringLiteral([")"]),
                            ");",
                        );
                    },
                );
                this.ensureBlankLine();

                this.emitBlock(
                    [
                        "if (c.",
                        getterMaxValue,
                        "() != ",
                        this._nulloptType,
                        " && value > *c.",
                        getterMaxValue,
                        "())",
                    ],
                    false,
                    () => {
                        this.emitLine(
                            "throw ",
                            this.lookupGlobalName(
                                GlobalNames.ValueTooHighException,
                            ),
                            " (",
                            this._stringType.createStringLiteral([
                                "Value too high for ",
                            ]),
                            " + name + ",
                            this._stringType.createStringLiteral([" ("]),
                            " + ",
                            this._stringType.wrapToString(["value"]),
                            " + ",
                            this._stringType.createStringLiteral([">"]),
                            " + ",
                            this._stringType.wrapToString([
                                "*c.",
                                getterMaxValue,
                                "()",
                            ]),
                            " + ",
                            this._stringType.createStringLiteral([")"]),
                            ");",
                        );
                    },
                );
                this.ensureBlankLine();
            },
        );
        this.ensureBlankLine();

        this.emitBlock(
            [
                "inline void ",
                checkConst,
                "(",
                this._stringType.getConstType(),
                " name, ",
                this.withConst(classConstraint),
                " & c, const ",
                this._optionalType,
                "<",
                cppType,
                "> & value)",
            ],
            false,
            () => {
                this.emitBlock(["if (value)"], false, () => {
                    this.emitLine(checkConst, "(name, c, *value);");
                });
            },
        );
        this.ensureBlankLine();
    }

    protected emitConstraintClasses(): void {
        const ourQualifier = this.ourQualifier(false) as string;

        const getterMinIntValue = this.lookupMemberName(
            MemberNames.GetMinIntValue,
        );
        const getterMaxIntValue = this.lookupMemberName(
            MemberNames.GetMaxIntValue,
        );
        const getterMinDoubleValue = this.lookupMemberName(
            MemberNames.GetMinDoubleValue,
        );
        const getterMaxDoubleValue = this.lookupMemberName(
            MemberNames.GetMaxDoubleValue,
        );
        const getterMinLength = this.lookupMemberName(MemberNames.GetMinLength);
        const getterMaxLength = this.lookupMemberName(MemberNames.GetMaxLength);
        const getterPattern = this.lookupMemberName(MemberNames.GetPattern);
        const classConstraint = this.lookupGlobalName(
            GlobalNames.ClassMemberConstraints,
        );

        this.emitBlock(["class ", classConstraint], true, () => {
            this.emitLine("private:");
            const constraintMembers: ConstraintMember[] =
                this.getConstraintMembers();
            for (const member of constraintMembers) {
                this.emitMember(
                    [this._optionalType, "<", member.cppType, ">"],
                    this.lookupMemberName(member.name),
                );
            }

            this.ensureBlankLine();
            this.emitLine("public:");
            this.emitLine(classConstraint, "(");
            this.indent(() => {
                this.iterableForEach(
                    constraintMembers,
                    ({ name, cppType }, pos) => {
                        const comma =
                            pos === "first" || pos === "middle" ? "," : [];
                        this.emitLine(
                            this._optionalType,
                            "<",
                            cppType,
                            "> ",
                            this.lookupMemberName(name),
                            comma,
                        );
                    },
                );
            });

            const args = constraintMembers.map(({ name }) => {
                const member = this.lookupMemberName(name);
                return [member, "(", member, ")"];
            });
            this.emitLine(") : ", arrayIntercalate([", "], args), " {}");

            this.emitLine(classConstraint, "() = default;");
            this.emitLine("virtual ~", classConstraint, "() = default;");
            for (const member of constraintMembers) {
                this.ensureBlankLine();
                this.emitGetterSetter(
                    withDefault(member.cppConstType, member.cppType),
                    this.lookupMemberName(member.getter),
                    this.lookupMemberName(member.setter),
                    this.lookupMemberName(member.name),
                );
            }
        });
        this.ensureBlankLine();

        const classConstEx = this.lookupGlobalName(
            GlobalNames.ClassMemberConstraintException,
        );
        this.emitBlock(
            ["class ", classConstEx, " : public std::runtime_error"],
            true,
            () => {
                this.emitLine("public:");
                this.emitLine(
                    classConstEx,
                    "(",
                    this._stringType.getConstType(),
                    " msg) : std::runtime_error(",
                    this._stringType.wrapEncodingChange(
                        [ourQualifier],
                        this._stringType.getType(),
                        this.NarrowString.getType(),
                        ["msg"],
                    ),
                    ") {}",
                );
            },
        );
        this.ensureBlankLine();

        const exceptions: GlobalNames[] = [
            GlobalNames.ValueTooLowException,
            GlobalNames.ValueTooHighException,
            GlobalNames.ValueTooShortException,
            GlobalNames.ValueTooLongException,
            GlobalNames.InvalidPatternException,
        ];

        for (const ex of exceptions) {
            const name = this.lookupGlobalName(ex);
            this.emitBlock(
                ["class ", name, " : public ", classConstEx],
                true,
                () => {
                    this.emitLine("public:");
                    this.emitLine(
                        name,
                        "(",
                        this._stringType.getConstType(),
                        " msg) : ",
                        classConstEx,
                        "(msg) {}",
                    );
                },
            );
            this.ensureBlankLine();
        }

        const checkConst = this.lookupGlobalName(GlobalNames.CheckConstraint);
        this.emitNumericCheckConstraints(
            checkConst,
            classConstraint,
            getterMinIntValue,
            getterMaxIntValue,
            "int64_t",
        );
        this.emitNumericCheckConstraints(
            checkConst,
            classConstraint,
            getterMinDoubleValue,
            getterMaxDoubleValue,
            "double",
        );

        const codePointLength = this.lookupGlobalName(
            GlobalNames.CodePointLength,
        );
        this.emitBlock(
            [
                "inline size_t ",
                codePointLength,
                "(",
                this._stringType.getConstType(),
                " value)",
            ],
            false,
            () => {
                const isCodePointStart = this._options.wstring
                    ? "(ch & 0xFC00) != 0xDC00"
                    : "(static_cast<unsigned char>(ch) & 0xC0) != 0x80";
                this.emitLine(
                    `return std::count_if(value.begin(), value.end(), [](${this._options.wstring ? "wchar_t" : "char"} ch) { return ${isCodePointStart}; });`,
                );
            },
        );
        this.ensureBlankLine();

        this.emitBlock(
            [
                "inline void ",
                checkConst,
                "(",
                this._stringType.getConstType(),
                " name, ",
                this.withConst(classConstraint),
                " & c, ",
                this._stringType.getConstType(),
                " value)",
            ],
            false,
            () => {
                this.emitBlock(
                    [
                        "if (c.",
                        getterMinLength,
                        "() != ",
                        this._nulloptType,
                        " && ",
                        codePointLength,
                        "(value) < *c.",
                        getterMinLength,
                        "())",
                    ],
                    false,
                    () => {
                        this.emitLine(
                            "throw ",
                            this.lookupGlobalName(
                                GlobalNames.ValueTooShortException,
                            ),
                            " (",
                            this._stringType.createStringLiteral([
                                "Value too short for ",
                            ]),
                            " + name + ",
                            this._stringType.createStringLiteral([" ("]),
                            " + ",
                            this._stringType.wrapToString([
                                codePointLength,
                                "(value)",
                            ]),
                            " + ",
                            this._stringType.createStringLiteral(["<"]),
                            " + ",
                            this._stringType.wrapToString([
                                "*c.",
                                getterMinLength,
                                "()",
                            ]),
                            " + ",
                            this._stringType.createStringLiteral([")"]),
                            ");",
                        );
                    },
                );
                this.ensureBlankLine();

                this.emitBlock(
                    [
                        "if (c.",
                        getterMaxLength,
                        "() != ",
                        this._nulloptType,
                        " && ",
                        codePointLength,
                        "(value) > *c.",
                        getterMaxLength,
                        "())",
                    ],
                    false,
                    () => {
                        this.emitLine(
                            "throw ",
                            this.lookupGlobalName(
                                GlobalNames.ValueTooLongException,
                            ),
                            " (",
                            this._stringType.createStringLiteral([
                                "Value too long for ",
                            ]),
                            " + name + ",
                            this._stringType.createStringLiteral([" ("]),
                            " + ",
                            this._stringType.wrapToString([
                                codePointLength,
                                "(value)",
                            ]),
                            " + ",
                            this._stringType.createStringLiteral([">"]),
                            " + ",
                            this._stringType.wrapToString([
                                "*c.",
                                getterMaxLength,
                                "()",
                            ]),
                            " + ",
                            this._stringType.createStringLiteral([")"]),
                            ");",
                        );
                    },
                );
                this.ensureBlankLine();

                this.emitBlock(
                    ["if (c.", getterPattern, "() != ", this._nulloptType, ")"],
                    false,
                    () => {
                        this.emitLine(this._stringType.getSMatch(), " result;");
                        this.emitLine(
                            "std::regex_search(value, result, ",
                            this._stringType.getRegex(),
                            "( *c.",
                            getterPattern,
                            "() ));",
                        );
                        this.emitBlock(["if (result.empty())"], false, () => {
                            this.emitLine(
                                "throw ",
                                this.lookupGlobalName(
                                    GlobalNames.InvalidPatternException,
                                ),
                                " (",
                                this._stringType.createStringLiteral([
                                    "Value doesn't match pattern for ",
                                ]),
                                " + name + ",
                                this._stringType.createStringLiteral([" ("]),
                                " + value +",
                                this._stringType.createStringLiteral([" != "]),
                                " + *c.",
                                getterPattern,
                                "() + ",
                                this._stringType.createStringLiteral([")"]),
                                ");",
                            );
                        });
                    },
                );
                this.ensureBlankLine();
            },
        );
        this.ensureBlankLine();

        this.emitBlock(
            [
                "inline void ",
                checkConst,
                "(",
                this._stringType.getConstType(),
                " name, ",
                this.withConst(classConstraint),
                " & c, const ",
                this._optionalType,
                "<",
                this._stringType.getType(),
                "> & value)",
            ],
            false,
            () => {
                this.emitBlock(["if (value)"], false, () => {
                    this.emitLine(checkConst, "(name, c, *value);");
                });
            },
        );
    }

    private get haveConstraintClasses(): boolean {
        return (
            this._options.codeFormat &&
            !this._options.justTypes &&
            iterableSome(
                this.typeGraph.allTypesUnordered(),
                (t) => constraintsForType(t) !== undefined,
            )
        );
    }

    protected emitHelperFunctions(): void {
        this._stringType.emitHelperFunctions();

        if (this.haveConstraintClasses) {
            this.emitConstraintClasses();
            this.ensureBlankLine();
        }

        this.ensureBlankLine();

        let untypedMacroName = "NLOHMANN_UNTYPED_";
        let optionalMacroName = "NLOHMANN_OPTIONAL_";
        this._namespaceNames.forEach((value) => {
            // We can't use upper name, because namespaces are case sensitive
            untypedMacroName += value;
            untypedMacroName += "_";

            optionalMacroName += value;
            optionalMacroName += "_";
        });

        untypedMacroName += "HELPER";
        optionalMacroName += "HELPER";

        this.emitLine(`#ifndef ${untypedMacroName}`);
        this.emitLine(`#define ${untypedMacroName}`);

        this.emitBlock(
            [
                "inline json get_untyped(",
                this.withConst("json"),
                " & j, ",
                this.withConst("char"),
                " * property)",
            ],
            false,
            () => {
                this.emitBlock(
                    ["if (j.find(property) != j.end())"],
                    false,
                    () => {
                        this.emitLine("return j.at(property).get<json>();");
                    },
                );
                this.emitLine("return json();");
            },
        );

        this.ensureBlankLine();

        this.emitBlock(
            [
                "inline json get_untyped(",
                this.withConst("json"),
                " & j, std::string property)",
            ],
            false,
            () => {
                this.emitLine("return get_untyped(j, property.data());");
            },
        );

        this.emitLine("#endif");

        this.ensureBlankLine();

        if (this.haveUnions || this.haveOptionalProperties) {
            this.ensureBlankLine();

            this.emitLine(`#ifndef ${optionalMacroName}`);
            this.emitLine(`#define ${optionalMacroName}`);

            const emitGetOptional = (
                optionalType: string,
                label: string,
            ): void => {
                this.emitLine("template <typename T>");
                this.emitBlock(
                    [
                        "inline ",
                        optionalType,
                        `<T> get_${label}_optional(`,
                        this.withConst("json"),
                        " & j, ",
                        this.withConst("char"),
                        " * property)",
                    ],
                    false,
                    () => {
                        this.emitLine(["auto it = j.find(property);"]);
                        this.emitBlock(
                            ["if (it != j.end() && !it->is_null())"],
                            false,
                            () => {
                                this.emitLine(
                                    "return j.at(property).get<",
                                    optionalType,
                                    "<T>>();",
                                );
                            },
                        );
                        this.emitLine("return ", optionalType, "<T>();");
                    },
                );

                this.ensureBlankLine();

                this.emitLine("template <typename T>");
                this.emitBlock(
                    [
                        "inline ",
                        optionalType,
                        `<T> get_${label}_optional(`,
                        this.withConst("json"),
                        " & j, std::string property)",
                    ],
                    false,
                    () => {
                        this.emitLine(
                            `return get_${label}_optional<T>(j, property.data());`,
                        );
                    },
                );
            };

            emitGetOptional(this.optionalTypeHeap(), "heap");
            emitGetOptional(this.optionalTypeStack(), "stack");

            this.emitLine("#endif");

            this.ensureBlankLine();
        }
    }

    protected emitExtraIncludes(): void {
        this.ensureBlankLine();

        if (this._options.codeFormat) {
            if (this._options.boost) {
                this.emitInclude(true, "boost/optional.hpp");
            } else {
                this.emitInclude(true, "optional");
            }

            // Just-types output has no code that throws or matches patterns.
            if (!this._options.justTypes) {
                this.emitInclude(true, "stdexcept");
                this.emitInclude(true, "regex");
            }
        }

        if (this.haveConstraintClasses) {
            this.emitInclude(true, "algorithm");
        }

        if (this._options.wstring) {
            this.emitInclude(true, "codecvt");
            this.emitInclude(true, "locale");
        }

        // Include unordered_map if contains large enums
        if (
            Array.from(this.enums).some((enumType) =>
                this.isLargeEnum(enumType),
            )
        ) {
            this.emitInclude(true, "unordered_map");
        }

        this.ensureBlankLine();
    }

    protected emitHelper(): void {
        this.startFile("helper.hpp", false);

        this.emitExtraIncludes();

        this.emitInclude(true, "sstream");
        this.ensureBlankLine();
        this.emitNamespaces(this._namespaceNames, () => {
            this.emitLine("using nlohmann::json;");
            this.ensureBlankLine();
            this.emitHelperFunctions();
        });

        if (this.haveOptionals) {
            this.ensureBlankLine();
            this.emitOptionalHelpers();
        }

        if (this.haveStdTuples) {
            this.ensureBlankLine();
            this.emitTupleHelpers();
        }

        this.finishFile();
    }

    protected emitTypes(): void {
        if (!this._options.justTypes) {
            this.emitLine("using nlohmann::json;");
            this.ensureBlankLine();
            this.emitHelperFunctions();
        }

        if (iterableSome(this.namedUnions, (u) => this.isRecursiveUnion(u))) {
            this.forEachUnion("none", (u: UnionType, unionName: Name) => {
                if (this.isRecursiveUnion(u)) {
                    this.emitLine("struct ", unionName, ";");
                }
            });
            this.ensureBlankLine();
        }

        this.forEachDeclaration("interposing", (decl) =>
            this.emitDeclaration(decl),
        );
        this.forEachTopLevel(
            "leading",
            (t: Type, name: Name) => this.emitTopLevelTypedef(t, name),
            (t) => this.namedTypeToNameForTopLevel(t) === undefined,
        );
    }

    protected gatherUserNamespaceForwardDecls(): Sourcelike[] {
        return this.gatherSource(() => {
            this.forEachObject(
                "leading-and-interposing",
                (_: unknown, className: Name) =>
                    this.emitClassHeaders(className),
            );

            this.forEachEnum(
                "leading-and-interposing",
                (_: unknown, enumName: Name) => this.emitEnumHeaders(enumName),
            );

            this.forEachUnion(
                "leading-and-interposing",
                (u: UnionType, unionName: Name) =>
                    this.emitUnionWrapperHeaders(u, unionName),
            );

            this.forEachTupleStruct("leading-and-interposing", (_, name) =>
                this.emitTupleStructHeaders(name),
            );
        });
    }

    protected gatherNlohmannNamespaceForwardDecls(): Sourcelike[] {
        return this.gatherSource(() => {
            this.forEachTopLevel(
                "leading-and-interposing",
                (t: Type, className: Name) =>
                    this.emitTopLevelHeaders(t, className),
            );

            this.ensureBlankLine();

            this.emitAllUnionHeaders();
        });
    }

    protected emitUserNamespaceImpls(): void {
        this.forEachObject(
            "leading-and-interposing",
            (c: ClassType, className: Name) =>
                this.emitClassFunctions(c, className),
        );

        this.forEachEnum(
            "leading-and-interposing",
            (e: EnumType, enumName: Name) =>
                this.emitEnumFunctions(e, enumName),
        );

        this.forEachUnion(
            "leading-and-interposing",
            (u: UnionType, unionName: Name) =>
                this.emitUnionWrapperFunctions(u, unionName),
        );

        this.forEachTupleStruct("leading-and-interposing", (t, name) =>
            this.emitTupleStructFunctions(t, name),
        );
    }

    protected emitNlohmannNamespaceImpls(): void {
        this.forEachTopLevel(
            "leading-and-interposing",
            (t: Type, name: Name) => this.emitTopLevelFunction(t, name),
            (t) => this.namedTypeToNameForTopLevel(t) === undefined,
        );

        this.ensureBlankLine();

        this.emitAllUnionFunctions();
    }

    protected emitGenerators(): void {
        // In just-types mode there are no generators; top-level typedefs are
        // emitted by emitTypes, inside the namespace with the other types.
        if (!this._options.justTypes) {
            const userNamespaceForwardDecls =
                this.gatherUserNamespaceForwardDecls();
            const nlohmannNamespaceForwardDecls =
                this.gatherNlohmannNamespaceForwardDecls();

            if (
                userNamespaceForwardDecls.length === 0 &&
                nlohmannNamespaceForwardDecls.length > 0
            ) {
                this.emitNamespaces(["nlohmann"], () => {
                    this.emitGatheredSource(nlohmannNamespaceForwardDecls);
                    this.emitNlohmannNamespaceImpls();
                });
            } else if (
                userNamespaceForwardDecls.length > 0 &&
                nlohmannNamespaceForwardDecls.length === 0
            ) {
                this.emitNamespaces(this._namespaceNames, () => {
                    this.emitGatheredSource(userNamespaceForwardDecls);
                    this.emitUserNamespaceImpls();
                });
            } else if (
                userNamespaceForwardDecls.length > 0 &&
                nlohmannNamespaceForwardDecls.length > 0
            ) {
                this.emitNamespaces(this._namespaceNames, () => {
                    this.emitGatheredSource(userNamespaceForwardDecls);
                });
                this.emitNamespaces(["nlohmann"], () => {
                    this.emitGatheredSource(nlohmannNamespaceForwardDecls);
                });
                this.emitNamespaces(this._namespaceNames, () => {
                    this.emitUserNamespaceImpls();
                });
                this.emitNamespaces(["nlohmann"], () => {
                    this.emitNlohmannNamespaceImpls();
                });
            }
        }
    }

    protected emitSingleSourceStructure(proposedFilename: string): void {
        this.startFile(proposedFilename);
        this._generatedFiles.add(proposedFilename);

        this.emitExtraIncludes();

        if (!this._options.justTypes && this.haveOptionals) {
            this.emitOptionalHelpers();
            this.ensureBlankLine();
        }

        if (!this._options.justTypes && this.haveStdTuples) {
            this.emitTupleHelpers();
            this.ensureBlankLine();
        }

        this.emitNamespaces(this._namespaceNames, () => this.emitTypes());

        this.ensureBlankLine();

        this.emitGenerators();

        this.finishFile();
    }

    protected updateIncludes(
        isClassMember: boolean,
        includes: IncludeMap,
        propertyType: Type,
        definedType: Type,
    ): void {
        const propTypes = this.generatedTypes(isClassMember, propertyType);

        for (const t of propTypes) {
            const typeName = this.sourcelikeToString(t.name);

            const propRecord: IncludeRecord = {
                kind: undefined,
                typeKind: undefined,
            };

            if (t.type instanceof ClassType) {
                /**
                 * Ok. We can NOT forward declare direct class members, e.g. a class type is included
                 * at level#0. HOWEVER if it is not a direct class member (e.g. std::shared_ptr<Class>),
                 * - level > 0 - then we can SURELY forward declare it.
                 */
                propRecord.typeKind = "class";
                propRecord.kind =
                    t.level === 0
                        ? IncludeKind.Include
                        : IncludeKind.ForwardDeclare;
                if (t.forceInclude) {
                    propRecord.kind = IncludeKind.Include;
                }
                /**
                 * A class that contains the type being defined is in a cycle with
                 * it, so it's held through a std::shared_ptr or in a container,
                 * where a declaration is enough.  Its header includes this one.
                 * But a std::optional holds its class by value.
                 */
                if (t.inOptional === true) {
                    propRecord.kind = IncludeKind.Include;
                } else if (this.typeReaches(t.type, definedType)) {
                    propRecord.kind = IncludeKind.ForwardDeclare;
                }
            } else if (t.type instanceof EnumType) {
                propRecord.typeKind = "enum";
                propRecord.kind = IncludeKind.ForwardDeclare;
            } else if (t.type instanceof UnionType) {
                propRecord.typeKind = "union";
                /** Recurse into the union */
                const [maybeNull] = removeNullFromUnion(t.type, true);
                if (maybeNull !== undefined) {
                    /** Houston this is a variant, include it */
                    propRecord.kind = IncludeKind.Include;
                } else if (t.forceInclude) {
                    propRecord.kind = IncludeKind.Include;
                } else {
                    propRecord.kind = IncludeKind.ForwardDeclare;
                }
            } else if (t.type instanceof TupleType) {
                // A forward declaration is enough where a tuple's struct is
                // forward declared, and so held in a std::shared_ptr, which
                // breaks the include cycles of recursive types.
                propRecord.typeKind = "tuple";
                propRecord.kind =
                    t.level === 0 ||
                    t.forceInclude ||
                    !this.isForwardDeclaredType(t.type)
                        ? IncludeKind.Include
                        : IncludeKind.ForwardDeclare;
            }

            if (includes.has(typeName)) {
                const incKind = includes.get(typeName);
                /**
                 * If we already include the type as typed include,
                 * do not write it over with forward declare
                 */
                if (
                    incKind !== undefined &&
                    incKind.kind === IncludeKind.ForwardDeclare
                ) {
                    includes.set(typeName, propRecord);
                }
            } else {
                includes.set(typeName, propRecord);
            }
        }
    }

    protected emitIncludes(
        c: ClassType | UnionType | EnumType | TupleType,
        defName: string,
    ): void {
        /**
         * Need to generate "includes", in terms 'c' has members, which
         * are defined by others
         */
        const includes: IncludeMap = new Map();

        if (c instanceof UnionType) {
            this.updateIncludes(false, includes, c, c);
            if (this.isRecursiveUnion(c)) {
                // A recursive union is a struct deriving from the variant,
                // which needs the classes it holds by value to be complete:
                // those not forward declared, see `cppTypeInOptional`.
                for (const t of removeNullFromUnion(c)[1]) {
                    if (!(t instanceof ClassType)) continue;
                    if (this.isForwardDeclaredType(t)) continue;
                    includes.set(
                        this.sourcelikeToString(this.nameForNamedType(t)),
                        { kind: IncludeKind.Include, typeKind: "class" },
                    );
                }
            }
        } else if (c instanceof TupleType) {
            for (const item of c.getNonAttributeChildren()) {
                this.updateIncludes(true, includes, item, c);
            }
        } else if (c instanceof ClassType) {
            this.forEachClassProperty(
                c,
                "none",
                (_name, _jsonName, property) => {
                    this.updateIncludes(true, includes, property.type, c);
                },
            );
        }

        if (includes.size > 0) {
            let numForwards = 0;
            let numIncludes = 0;
            includes.forEach((rec: IncludeRecord, name: string) => {
                /** Don't bother including the one we are defining */
                if (name === defName) {
                    return;
                }

                if (rec.kind !== IncludeKind.ForwardDeclare) {
                    this.emitInclude(false, [name, ".hpp"]);
                    numIncludes++;
                } else {
                    numForwards++;
                }
            });

            if (numIncludes > 0) {
                this.ensureBlankLine();
            }

            if (numForwards > 0) {
                this.emitNamespaces(this._namespaceNames, () => {
                    includes.forEach((rec: IncludeRecord, name: string) => {
                        /** Don't bother including the one we are defining */
                        if (name === defName) {
                            return;
                        }

                        if (rec.kind !== IncludeKind.ForwardDeclare) {
                            return;
                        }

                        if (
                            rec.typeKind === "class" ||
                            rec.typeKind === "union"
                        ) {
                            if (this._options.codeFormat) {
                                this.emitLine("class ", name, ";");
                            } else {
                                this.emitLine("struct ", name, ";");
                            }
                        } else if (rec.typeKind === "tuple") {
                            this.emitLine("struct ", name, ";");
                        } else if (rec.typeKind === "enum") {
                            this.emitLine(
                                "enum class ",
                                name,
                                " : ",
                                this._enumType,
                                ";",
                            );
                        } else {
                            panic(
                                `Invalid type "${rec.typeKind}" to forward declare`,
                            );
                        }
                    });
                });
            }

            this.ensureBlankLine();
        }
    }

    protected emitDefinition(
        d: ClassType | EnumType | UnionType | TupleType,
        defName: Name,
    ): void {
        const name = `${this.sourcelikeToString(defName)}.hpp`;
        this.startFile(name, true);
        this._generatedFiles.add(name);

        this.emitIncludes(d, this.sourcelikeToString(defName));

        this.emitNamespaces(this._namespaceNames, () => {
            this.emitDescription(this.descriptionForType(d));
            this.ensureBlankLine();
            // Just-types output doesn't include nlohmann/json.hpp, and the
            // types spell out `nlohmann::json`.
            if (!this._options.justTypes) {
                this.emitLine("using nlohmann::json;");
                this.ensureBlankLine();
            }
            if (d instanceof ClassType) {
                this.emitClass(d, defName);
            } else if (d instanceof EnumType) {
                this.emitEnum(d, defName);
            } else if (d instanceof UnionType) {
                this.emitUnionTypedefs(d, defName);
            } else if (d instanceof TupleType) {
                this.emitTupleTypedef(d, defName);
            }
        });

        this.finishFile();
    }

    protected emitMultiSourceStructure(proposedFilename: string): void {
        if (!this._options.justTypes && this.haveNamedTypes) {
            this.emitHelper();

            this.startFile("Generators.hpp", true);
            this._generatedFiles.add("Generators.hpp");

            this._allTypeNames.forEach((t) => {
                this.emitInclude(false, [t, ".hpp"]);
            });

            this.ensureBlankLine();
            this.emitGenerators();

            this.finishFile();
        }

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) => {
                this.emitDefinition(c, n);
            },
            (e, n) => {
                this.emitDefinition(e, n);
            },
            (u, n) => {
                this.emitDefinition(u, n);
            },
            (t, n) => {
                this.emitDefinition(t, n);
            },
        );

        /**
         * If for some reason we have not generated anything,
         * it means that a unnamed type has been generated - or nothing.
         */
        if (!this._generatedFiles.has(proposedFilename)) {
            if (!this.haveNamedTypes) {
                this.emitHelper();
            }

            this.startFile(proposedFilename);

            this._generatedFiles.forEach((f) => {
                this.emitInclude(false, f);
            });

            this.emitNamespaces(this._namespaceNames, () => {
                this.forEachTopLevel(
                    "leading",
                    (t: Type, name: Name) => this.emitTopLevelTypedef(t, name),
                    (t) => this.namedTypeToNameForTopLevel(t) === undefined,
                );
            });

            this.finishFile();
        }
    }

    protected emitSourceStructure(proposedFilename: string): void {
        this._generatedFiles.clear();

        /** Gather all the unique/custom types used by the schema */
        this._allTypeNames.clear();
        this.forEachDeclaration("none", (decl) => {
            const definedTypes = directlyReachableTypes<string>(
                decl.type,
                (t) => {
                    if (
                        (isNamedType(t) &&
                            (t instanceof ClassType ||
                                t instanceof EnumType ||
                                t instanceof UnionType)) ||
                        (t instanceof TupleType && this.tupleNeedsName(t))
                    ) {
                        return new Set([
                            this.sourcelikeToString(
                                this.cppType(
                                    t,
                                    {
                                        needsForwardIndirection: false,
                                        needsOptionalIndirection: false,
                                        inJsonNamespace: false,
                                    },
                                    true,
                                    false,
                                    false,
                                ),
                            ),
                        ]);
                    }

                    return null;
                },
            );

            this._allTypeNames = setUnion(definedTypes, this._allTypeNames);
        });

        if (this._options.typeSourceStyle) {
            this.emitSingleSourceStructure(proposedFilename);
        } else {
            this.emitMultiSourceStructure(proposedFilename);
        }
    }

    protected isConversionRequired(t: Type): boolean {
        const originalType = this.cppType(
            t,
            {
                needsForwardIndirection: true,
                needsOptionalIndirection: true,
                inJsonNamespace: true,
            },
            false,
            false,
            false,
        );

        const newType = this.cppType(
            t,
            {
                needsForwardIndirection: true,
                needsOptionalIndirection: true,
                inJsonNamespace: true,
            },
            false,
            true,
            false,
        );

        return originalType !== newType;
    }

    public NarrowString = new (class extends BaseString implements StringType {
        public constructor() {
            super(
                "std::string",
                "const std::string & ",
                "std::smatch",
                "std::regex",
                "",
                new WrappingCode(["std::to_string("], [")"]),
                "",
                "",
            );
        }

        public wrapEncodingChange(
            _qualifier: Sourcelike[],
            _fromType: Sourcelike,
            _toType: Sourcelike,
            inner: Sourcelike,
        ): Sourcelike {
            return inner;
        }

        public emitHelperFunctions(): void {}
    })();

    public WideString = new (class extends BaseString implements StringType {
        public constructor(public superThis: CPlusPlusRenderer) {
            super(
                "std::wstring",
                "const std::wstring & ",
                "std::wsmatch",
                "std::wregex",
                "L",
                new WrappingCode(["std::to_wstring("], [")"]),
                "Utf16_Utf8",
                "convert",
            );
        }

        public wrapEncodingChange(
            qualifier: Sourcelike[],
            fromType: Sourcelike,
            toType: Sourcelike,
            inner: Sourcelike,
        ): Sourcelike {
            if (
                this.superThis.sourcelikeToString(fromType) ===
                this.superThis.sourcelikeToString(toType)
            ) {
                return inner;
            }

            return [
                addQualifier(qualifier, [this._encodingClass]),
                "<",
                fromType,
                ", ",
                toType,
                ">::",
                this._encodingFunction,
                "(",
                inner,
                ")",
            ];
        }

        public emitHelperFunctions(): void {
            this.superThis.emitLine("template<typename T>");
            this.superThis.emitLine("struct tag {};");
            this.superThis.ensureBlankLine();

            this.superThis.emitLine(
                "template<typename fromType, typename toType>",
            );
            this.superThis.emitBlock(["class Utf16_Utf8"], true, () => {
                this.superThis.emitLine("private:");
                this.superThis.emitLine("template<typename TF, typename TT>");
                this.superThis.emitBlock(
                    [
                        "static toType convert(tag<std::shared_ptr<TF> >, tag<std::shared_ptr<TT> >, fromType ptr)",
                    ],
                    false,
                    () => {
                        this.superThis.emitLine(
                            "if (ptr == nullptr) return std::unique_ptr<TT>(); else return std::unique_ptr<TT>(new TT(Utf16_Utf8<TF,TT>::convert(*ptr)));",
                        );
                    },
                );
                this.superThis.ensureBlankLine();

                // Optional properties and nullable types (unions with null)
                // are optionals.
                if (
                    this.superThis.haveOptionalProperties ||
                    this.superThis.haveUnions ||
                    this.superThis.haveTupleStructsWithNullables
                ) {
                    this.superThis.emitLine(
                        "template<typename TF, typename TT>",
                    );
                    this.superThis.emitBlock(
                        [
                            "static toType convert(tag<",
                            this.superThis._optionalType,
                            "<TF> >, tag<",
                            this.superThis._optionalType,
                            "<TT> >, fromType opt)",
                        ],
                        false,
                        () => {
                            this.superThis.emitLine(
                                "if (!opt) return toType(); else return toType(Utf16_Utf8<TF,TT>::convert(*opt));",
                            );
                        },
                    );
                    this.superThis.ensureBlankLine();
                }

                this.superThis.emitLine("template<typename TF, typename TT>");
                this.superThis.emitBlock(
                    [
                        "static toType convert(tag<std::vector<TF> >, tag<std::vector<TT> >, fromType v)",
                    ],
                    false,
                    () => {
                        this.superThis.emitLine("auto it = v.begin();");
                        this.superThis.emitLine(
                            "auto newVector = std::vector<TT>();",
                        );
                        this.superThis.emitBlock(
                            ["while (it != v.end())"],
                            false,
                            () => {
                                this.superThis.emitLine(
                                    "newVector.push_back(Utf16_Utf8<TF,TT>::convert(*it));",
                                );
                                this.superThis.emitLine("it++;");
                            },
                        );
                        this.superThis.emitLine("return newVector;");
                    },
                );
                this.superThis.ensureBlankLine();

                this.superThis.emitLine(
                    "template<typename KF, typename VF, typename KT, typename VT>",
                );
                this.superThis.emitBlock(
                    [
                        "static toType convert(tag<std::map<KF,VF> >, tag<std::map<KT,VT> >, fromType m)",
                    ],
                    false,
                    () => {
                        this.superThis.emitLine("auto it = m.begin();");
                        this.superThis.emitLine(
                            "auto newMap = std::map<KT, VT>();",
                        );
                        this.superThis.emitBlock(
                            ["while (it != m.end())"],
                            false,
                            () => {
                                this.superThis.emitLine(
                                    "newMap.insert(std::pair<KT, VT>(Utf16_Utf8<KF, KT>::convert(it->first), Utf16_Utf8<VF, VT>::convert(it->second)));",
                                );
                                this.superThis.emitLine("it++;");
                            },
                        );
                        this.superThis.emitLine("return newMap;");
                    },
                );
                this.superThis.ensureBlankLine();

                if (this.superThis.haveStdTuples) {
                    this.superThis.emitLine(
                        "template<typename... TF, typename... TT>",
                    );
                    this.superThis.emitBlock(
                        [
                            "static toType convert(tag<std::tuple<TF...> >, tag<std::tuple<TT...> >, fromType t)",
                        ],
                        false,
                        () => {
                            this.superThis.emitLine(
                                "return std::apply([](TF... e) { return toType(Utf16_Utf8<TF, TT>::convert(e)...); }, t);",
                            );
                        },
                    );
                    this.superThis.ensureBlankLine();
                }

                this.superThis.emitLine("template<typename TF, typename TT>");
                this.superThis.emitBlock(
                    [
                        "static fromType convert(tag<TF>, tag<TT>, fromType from)",
                    ],
                    false,
                    () => {
                        this.superThis.emitLine("return from;");
                    },
                );
                this.superThis.ensureBlankLine();

                this.superThis.emitBlock(
                    [
                        "static std::wstring convert(tag<std::string>, tag<std::wstring>, std::string str)",
                    ],
                    false,
                    () => {
                        this.superThis.emitLine(
                            "return std::wstring_convert<std::codecvt_utf8_utf16<wchar_t, 0x10ffff, std::little_endian>, wchar_t>{}.from_bytes(str.data());",
                        );
                    },
                );
                this.superThis.ensureBlankLine();

                this.superThis.emitBlock(
                    [
                        "static std::string convert(tag<std::wstring>, tag<std::string>, std::wstring str)",
                    ],
                    false,
                    () => {
                        this.superThis.emitLine(
                            "return std::wstring_convert<std::codecvt_utf8_utf16<wchar_t, 0x10ffff, std::little_endian>, wchar_t>{}.to_bytes(str.data());",
                        );
                    },
                );
                this.superThis.ensureBlankLine();

                this.superThis.emitLine("public:");
                this.superThis.emitBlock(
                    ["static toType convert(fromType in)"],
                    false,
                    () => {
                        this.superThis.emitLine(
                            "return convert(tag<fromType>(), tag<toType>(), in);",
                        );
                    },
                );
            });
            this.superThis.ensureBlankLine();

            this.superThis.emitLine("template<typename T>");
            this.superThis.emitBlock(
                ["std::wstring wdump(const T& j)"],
                false,
                () => {
                    this.superThis.emitLine("std::ostringstream s;");
                    this.superThis.emitLine("s << j;");
                    this.superThis.emitLine(
                        "return ",
                        this.superThis.ourQualifier(false),
                        "Utf16_Utf8<std::string, std::wstring>::convert(s.str()); ",
                    );
                },
            );
            this.superThis.ensureBlankLine();
        }
    })(this);
}
