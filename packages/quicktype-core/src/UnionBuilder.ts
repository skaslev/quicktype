import {
    mapMap,
    mapMerge,
    mapUpdateInto,
    setUnionInto,
} from "collection-utils";

import {
    distinctObjectGroups,
    distinctObjectTypeAttributeKind,
    isDistinctObject,
} from "./attributes/DistinctObjects.js";
import {
    StringTypes,
    stringTypesTypeAttributeKind,
} from "./attributes/StringTypes.js";
import {
    type TypeAttributes,
    combineTypeAttributes,
    emptyTypeAttributes,
    increaseTypeAttributesDistance,
    makeTypeAttributesInferred,
    unionTypeAttributes,
} from "./attributes/TypeAttributes.js";
import { assert, assertNever, defined, panic } from "./support/Support.js";
import {
    type PrimitiveStringTypeKind,
    type PrimitiveTypeKind,
    type TupleType,
    type Type,
    type TypeKind,
    UnionType,
    isPrimitiveTypeKind,
} from "./Type/index.js";
import type { TypeBuilder } from "./Type/TypeBuilder.js";
import type { TypeRef } from "./Type/TypeRef.js";
import { matchTypeExhaustive } from "./Type/TypeUtils.js";

// FIXME: This interface is badly designed.  All the properties
// should use immutable types, and getMemberKinds should be
// implementable using the interface, not be part of it.  That
// means we'll have to expose primitive types, too.
//
// Well, maybe getMemberKinds() is fine as it is.
export interface UnionTypeProvider<TArrayData, TObjectData> {
    readonly arrayData: TArrayData;
    /**
     * The tuples making up the "tuple" members: one member for each
     * shape, see `tupleShapeGroups`.
     */
    readonly tupleData: readonly TupleType[];
    /** The attributes for each of `tupleData`, if known. */
    readonly tupleAttributes?: readonly TypeAttributes[];
    readonly enumCases: ReadonlySet<string>;

    getMemberKinds: () => TypeAttributeMap<TypeKind>;

    readonly lostTypeAttributes: boolean;

    readonly objectData: TObjectData;

    /**
     * The object members and their attributes, if the union keeps several
     * apart, see `distinctObjectGroups`.  Otherwise the union has at most
     * one object member, made from `objectData`.
     */
    readonly objectGroups?: ReadonlyArray<
        readonly [TObjectData, TypeAttributes]
    >;
}

export type TypeAttributeMap<T extends TypeKind> = Map<T, TypeAttributes>;

/**
 * Groups tuples by shape: the number of items, how many of them are
 * required, and whether there's a rest.  A union has a member for each
 * group, with the tuples in a group merged item by item.  Only targets that
 * support tuples see them, and those can tell tuples of different shapes
 * apart.
 */
export function tupleShapeGroups(tuples: readonly TupleType[]): TupleType[][] {
    const groups = new Map<string, TupleType[]>();
    for (const t of tuples) {
        const key = `${t.items.length}/${t.minItems}/${t.rest !== undefined}`;
        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, [t]);
        } else {
            group.push(t);
        }
    }

    return Array.from(groups.values());
}

// The attributes of the members of each kind, one for each member.
type TypeAttributeMapBuilder<T extends TypeKind> = Map<T, TypeAttributes[]>;

function addAttributes(
    accumulatorAttributes: TypeAttributes | undefined,
    newAttributes: TypeAttributes,
): TypeAttributes {
    if (accumulatorAttributes === undefined) return newAttributes;
    return combineTypeAttributes("union", accumulatorAttributes, newAttributes);
}

function setAttributes<T extends TypeKind>(
    attributeMap: TypeAttributeMap<T>,
    kind: T,
    newAttributes: TypeAttributes,
): void {
    attributeMap.set(
        kind,
        addAttributes(attributeMap.get(kind), newAttributes),
    );
}

function addAttributesToBuilder<T extends TypeKind>(
    builder: TypeAttributeMapBuilder<T>,
    kind: T,
    newAttributes: TypeAttributes,
): void {
    let arr = builder.get(kind);
    if (arr === undefined) {
        arr = [];
        builder.set(kind, arr);
    } else if (newAttributes.size === 0 && arr.some((a) => a.size === 0)) {
        // Another member without attributes adds nothing.
        return;
    }

    arr.push(newAttributes);
}

function buildTypeAttributeMap<T extends TypeKind>(
    builder: TypeAttributeMapBuilder<T>,
): TypeAttributeMap<T> {
    return mapMap(builder, (arr) => unionTypeAttributes(arr));
}

// Unifies the members of kind `fromKind` into those of kind `toKind`.
function moveAttributes<T extends TypeKind>(
    map: TypeAttributeMap<T>,
    fromKind: T,
    toKind: T,
): void {
    const fromAttributes = defined(map.get(fromKind));
    map.delete(fromKind);
    const toAttributes = map.get(toKind);
    map.set(
        toKind,
        toAttributes === undefined
            ? fromAttributes
            : unionTypeAttributes([toAttributes, fromAttributes]),
    );
}

export class UnionAccumulator<TArray, TObject>
    implements UnionTypeProvider<TArray[], TObject[]>
{
    private readonly _nonStringTypeAttributes: TypeAttributeMapBuilder<TypeKind> =
        new Map();

    private readonly _stringTypeAttributes: TypeAttributeMapBuilder<PrimitiveStringTypeKind> =
        new Map();

    private readonly _stringCases = new Map<string, number>();

    public readonly arrayData: TArray[] = [];

    public readonly tupleData: TupleType[] = [];

    public readonly tupleAttributes: TypeAttributes[] = [];

    public readonly objectData: TObject[] = [];

    // The attributes of each of `objectData`.
    private readonly _objectAttributes: TypeAttributes[] = [];

    private readonly _enumCases: Set<string> = new Set();

    private _lostTypeAttributes = false;

    public constructor(private readonly _conflateNumbers: boolean) {}

    private have(kind: TypeKind): boolean {
        return (
            this._nonStringTypeAttributes.has(kind) ||
            this._stringTypeAttributes.has(kind as PrimitiveStringTypeKind)
        );
    }

    public addNone(_attributes: TypeAttributes): void {
        // FIXME: Add them to all members?  Or add them to the union, which means we'd have
        // to change getMemberKinds() to also return the attributes for the union itself,
        // or add a new method that does that.
        this._lostTypeAttributes = true;
    }

    public addAny(attributes: TypeAttributes): void {
        addAttributesToBuilder(
            this._nonStringTypeAttributes,
            "any",
            attributes,
        );
        this._lostTypeAttributes = true;
    }

    public addPrimitive(
        kind: PrimitiveTypeKind,
        attributes: TypeAttributes,
    ): void {
        assert(kind !== "any", "any must be added with addAny");
        addAttributesToBuilder(this._nonStringTypeAttributes, kind, attributes);
    }

    protected addFullStringType(
        attributes: TypeAttributes,
        stringTypes: StringTypes | undefined,
    ): void {
        let stringTypesAttributes: TypeAttributes | undefined;
        if (stringTypes === undefined) {
            stringTypes =
                stringTypesTypeAttributeKind.tryGetInAttributes(attributes);
        } else {
            stringTypesAttributes =
                stringTypesTypeAttributeKind.makeAttributes(stringTypes);
        }

        if (stringTypes === undefined) {
            stringTypes = StringTypes.unrestricted;
            stringTypesAttributes =
                stringTypesTypeAttributeKind.makeAttributes(stringTypes);
        }

        const maybeEnumAttributes = this._nonStringTypeAttributes.get("enum");
        if (stringTypes.isRestricted) {
            assert(
                maybeEnumAttributes === undefined,
                "We can't add both an enum as well as a restricted string type to a union builder",
            );
        }

        addAttributesToBuilder(
            this._stringTypeAttributes,
            "string",
            stringTypesAttributes === undefined
                ? attributes
                : combineTypeAttributes(
                      "union",
                      attributes,
                      stringTypesAttributes,
                  ),
        );
    }

    public addStringType(
        kind: PrimitiveStringTypeKind,
        attributes: TypeAttributes,
        stringTypes?: StringTypes,
    ): void {
        if (kind === "string") {
            this.addFullStringType(attributes, stringTypes);
            return;
        }

        addAttributesToBuilder(
            this._stringTypeAttributes,
            kind,
            stringTypes === undefined
                ? attributes
                : combineTypeAttributes(
                      "union",
                      attributes,
                      stringTypesTypeAttributeKind.makeAttributes(stringTypes),
                  ),
        );
    }

    public addArray(t: TArray, attributes: TypeAttributes): void {
        this.arrayData.push(t);
        addAttributesToBuilder(
            this._nonStringTypeAttributes,
            "array",
            attributes,
        );
    }

    public addTuple(t: TupleType, attributes: TypeAttributes): void {
        this.tupleData.push(t);
        this.tupleAttributes.push(attributes);
        addAttributesToBuilder(
            this._nonStringTypeAttributes,
            "tuple",
            attributes,
        );
    }

    public addObject(t: TObject, attributes: TypeAttributes): void {
        this.objectData.push(t);
        this._objectAttributes.push(attributes);
        addAttributesToBuilder(
            this._nonStringTypeAttributes,
            "object",
            attributes,
        );
    }

    public addEnum(
        cases: ReadonlySet<string>,
        attributes: TypeAttributes,
    ): void {
        const maybeStringAttributes = this._stringTypeAttributes.get("string");
        if (maybeStringAttributes !== undefined) {
            addAttributesToBuilder(
                this._stringTypeAttributes,
                "string",
                attributes,
            );
            return;
        }

        addAttributesToBuilder(
            this._nonStringTypeAttributes,
            "enum",
            attributes,
        );
        setUnionInto(this._enumCases, cases);
    }

    public addStringCases(cases: string[], attributes: TypeAttributes): void {
        addAttributesToBuilder(
            this._stringTypeAttributes,
            "string",
            attributes,
        );
        for (const s of new Set(cases)) {
            this._stringCases.set(s, (this._stringCases.get(s) ?? 0) + 1);
        }
    }

    public addStringCase(
        s: string,
        count: number,
        attributes: TypeAttributes,
    ): void {
        addAttributesToBuilder(
            this._stringTypeAttributes,
            "string",
            attributes,
        );
        this._stringCases.set(s, (this._stringCases.get(s) ?? 0) + count);
    }

    public get enumCases(): ReadonlySet<string> {
        return this._enumCases;
    }

    public getMemberKinds(): TypeAttributeMap<TypeKind> {
        assert(
            !(this.have("enum") && this.have("string")),
            "We can't have both strings and enums in the same union",
        );

        const stringTypeAttributes = buildTypeAttributeMap(
            this._stringTypeAttributes,
        );
        if (this._stringCases.size > 0) {
            setAttributes(
                stringTypeAttributes,
                "string",
                stringTypesTypeAttributeKind.makeAttributes(
                    new StringTypes(new Map(this._stringCases), new Set()),
                ),
            );
        }

        const merged = mapMerge(
            buildTypeAttributeMap(this._nonStringTypeAttributes),
            stringTypeAttributes,
        );

        if (merged.size === 0) {
            return new Map([
                ["none", emptyTypeAttributes] as [TypeKind, TypeAttributes],
            ]);
        }

        if (this._nonStringTypeAttributes.has("any")) {
            assert(
                this._lostTypeAttributes,
                "This had to be set when we added 'any'",
            );

            const allAttributes = combineTypeAttributes(
                "union",
                Array.from(merged.values()),
            );
            return new Map([
                ["any", allAttributes] as [TypeKind, TypeAttributes],
            ]);
        }

        if (
            this._conflateNumbers &&
            this.have("integer") &&
            this.have("double")
        ) {
            moveAttributes(merged, "integer", "double");
        }

        if (this.have("map")) {
            moveAttributes(merged, "map", "class");
        }

        // Object types unified with one that isn't a distinct object type
        // don't make a distinct one either.
        const objectAttributes = merged.get("object");
        if (
            objectAttributes !== undefined &&
            isDistinctObject(objectAttributes) &&
            !this._objectAttributes.every(isDistinctObject)
        ) {
            merged.set(
                "object",
                distinctObjectTypeAttributeKind.removeInAttributes(
                    objectAttributes,
                ),
            );
        }

        return merged;
    }

    public get objectGroups(): Array<[TObject[], TypeAttributes]> | undefined {
        const groups = distinctObjectGroups(this._objectAttributes);
        if (groups === undefined) return undefined;

        return groups.map((group) => [
            group.map((i) => this.objectData[i]),
            unionTypeAttributes(group.map((i) => this._objectAttributes[i])),
        ]);
    }

    public get lostTypeAttributes(): boolean {
        return this._lostTypeAttributes;
    }
}

class FauxUnion {
    public getAttributes(): TypeAttributes {
        return emptyTypeAttributes;
    }
}

type UnionOrFaux = UnionType | FauxUnion;

function attributesForTypes(
    types: Iterable<Type>,
): [ReadonlyMap<Type, TypeAttributes>, TypeAttributes] {
    // These two maps are the reverse of each other.  unionsForType is all the unions
    // that are ancestors of that type, when going from one of the given types, only
    // following unions.
    const unionsForType = new Map<Type, Set<UnionOrFaux>>();
    const typesForUnion = new Map<UnionOrFaux, Set<Type>>();

    // All the unions we've seen, starting from types, stopping when we hit non-unions.
    const unions = new Set<UnionType>();
    // All the unions that are equivalent to the single root type.  If more than one type
    // is given, this will be empty.
    let unionsEquivalentToRoot: Set<UnionType> = new Set();
    function traverse(
        t: Type,
        path: UnionOrFaux[],
        isEquivalentToRoot: boolean,
    ): void {
        if (t instanceof UnionType) {
            unions.add(t);
            if (isEquivalentToRoot) {
                unionsEquivalentToRoot = unionsEquivalentToRoot.add(t);
            }

            isEquivalentToRoot = isEquivalentToRoot && t.members.size === 1;
            path.push(t);
            for (const m of t.members) {
                traverse(m, path, isEquivalentToRoot);
            }

            path.pop();
        } else {
            mapUpdateInto(unionsForType, t, (s) =>
                s === undefined ? new Set(path) : setUnionInto(s, path),
            );
            for (const u of path) {
                mapUpdateInto(typesForUnion, u, (s) =>
                    s === undefined ? new Set([t]) : s.add(t),
                );
            }
        }
    }

    const rootPath = [new FauxUnion()];
    const typesArray = Array.from(types);
    for (const t of typesArray) {
        traverse(t, rootPath, typesArray.length === 1);
    }

    const resultAttributes = mapMap(unionsForType, (unionForType, t) => {
        const singleAncestors = Array.from(unionForType).filter(
            (u) => defined(typesForUnion.get(u)).size === 1,
        );
        assert(
            singleAncestors.every((u) => defined(typesForUnion.get(u)).has(t)),
            "We messed up bookkeeping",
        );
        const inheritedAttributes = singleAncestors.map((u) =>
            u.getAttributes(),
        );
        return combineTypeAttributes(
            "union",
            [t.getAttributes()].concat(inheritedAttributes),
        );
    });
    const unionAttributes = Array.from(unions).map((u) => {
        const t = typesForUnion.get(u);
        if (t !== undefined && t.size === 1) {
            return emptyTypeAttributes;
        }

        const attributes = u.getAttributes();
        if (unionsEquivalentToRoot.has(u)) {
            return attributes;
        }

        return makeTypeAttributesInferred(attributes);
    });
    return [resultAttributes, combineTypeAttributes("union", unionAttributes)];
}

// FIXME: Move this to UnifyClasses.ts?
export class TypeRefUnionAccumulator extends UnionAccumulator<
    TypeRef,
    TypeRef
> {
    // There is a method analogous to this in the IntersectionAccumulator.  It might
    // make sense to find a common interface.
    private addType(t: Type, attributes: TypeAttributes): void {
        matchTypeExhaustive(
            t,
            (_noneType) => this.addNone(attributes),
            (_anyType) => this.addAny(attributes),
            (_nullType) => this.addPrimitive("null", attributes),
            (_boolType) => this.addPrimitive("bool", attributes),
            (_integerType) => this.addPrimitive("integer", attributes),
            (_doubleType) => this.addPrimitive("double", attributes),
            (_stringType) => this.addStringType("string", attributes),
            (arrayType) => this.addArray(arrayType.items.typeRef, attributes),
            (classType) => this.addObject(classType.typeRef, attributes),
            (mapType) => this.addObject(mapType.typeRef, attributes),
            (objectType) => this.addObject(objectType.typeRef, attributes),
            // FIXME: We're not carrying counts, so this is not correct if we do enum
            // inference.  JSON Schema input uses this case, however, without enum
            // inference, which is fine, but still a bit ugly.
            (enumType) => this.addEnum(enumType.cases, attributes),
            (_unionType) => {
                return panic(
                    "The unions should have been eliminated in attributesForTypesInUnion",
                );
            },
            (transformedStringType) =>
                this.addStringType(
                    transformedStringType.kind as PrimitiveStringTypeKind,
                    attributes,
                ),
            (tupleType) => this.addTuple(tupleType, attributes),
        );
    }

    public addTypes(types: Iterable<Type>): TypeAttributes {
        const [attributesMap, unionAttributes] = attributesForTypes(types);
        for (const [t, attributes] of attributesMap) {
            this.addType(t, attributes);
        }

        return unionAttributes;
    }
}

export abstract class UnionBuilder<
    TBuilder extends TypeBuilder,
    TArrayData,
    TObjectData,
> {
    public constructor(protected readonly typeBuilder: TBuilder) {}

    protected abstract makeObject(
        objects: TObjectData,
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef;
    protected abstract makeArray(
        arrays: TArrayData,
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef;

    /** Makes one tuple from `tuples`, which all have the same shape. */
    protected makeTuple(
        _typeProvider: UnionTypeProvider<TArrayData, TObjectData>,
        _tuples: readonly TupleType[],
        _typeAttributes: TypeAttributes,
        _forwardingRef: TypeRef | undefined,
    ): TypeRef {
        return panic("This union builder doesn't support tuples");
    }

    private makeTypeOfKind(
        typeProvider: UnionTypeProvider<TArrayData, TObjectData>,
        kind: TypeKind,
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef {
        switch (kind) {
            case "string":
                return this.typeBuilder.getStringType(
                    typeAttributes,
                    undefined,
                    forwardingRef,
                );
            case "enum":
                return this.typeBuilder.getEnumType(
                    typeAttributes,
                    typeProvider.enumCases,
                    forwardingRef,
                );
            case "object":
                return this.makeObject(
                    typeProvider.objectData,
                    typeAttributes,
                    forwardingRef,
                );
            case "array":
                return this.makeArray(
                    typeProvider.arrayData,
                    typeAttributes,
                    forwardingRef,
                );
            case "tuple":
                return this.makeTuple(
                    typeProvider,
                    typeProvider.tupleData,
                    typeAttributes,
                    forwardingRef,
                );
            default:
                if (isPrimitiveTypeKind(kind)) {
                    return this.typeBuilder.getPrimitiveType(
                        kind,
                        typeAttributes,
                        forwardingRef,
                    );
                }

                if (
                    kind === "union" ||
                    kind === "class" ||
                    kind === "map" ||
                    kind === "intersection"
                ) {
                    return panic(`getMemberKinds() shouldn't return ${kind}`);
                }

                return assertNever(kind);
        }
    }

    public buildUnion(
        typeProvider: UnionTypeProvider<TArrayData, TObjectData>,
        unique: boolean,
        typeAttributes: TypeAttributes,
        forwardingRef?: TypeRef,
    ): TypeRef {
        const kinds = typeProvider.getMemberKinds();
        const objectGroups = kinds.has("object")
            ? typeProvider.objectGroups
            : undefined;

        if (typeProvider.lostTypeAttributes) {
            this.typeBuilder.setLostTypeAttributes();
        }

        // FIXME: We don't reconstitute type attributes here, so it's possible that
        // we get type refs for the wrong graphs if the transformation making rewrite
        // makes unions that have to be unified here.  That's a bug anyway, at least
        // right now, it's just a very bad way of surfacing that error.
        const tupleGroups = kinds.has("tuple")
            ? tupleShapeGroups(typeProvider.tupleData)
            : [];
        if (
            kinds.size === 1 &&
            tupleGroups.length <= 1 &&
            objectGroups === undefined
        ) {
            const [[kind, memberAttributes]] = Array.from(kinds);
            const allAttributes = combineTypeAttributes(
                "union",
                typeAttributes,
                increaseTypeAttributesDistance(memberAttributes),
            );
            const t = this.makeTypeOfKind(
                typeProvider,
                kind,
                allAttributes,
                forwardingRef,
            );
            return t;
        }

        const union = unique
            ? this.typeBuilder.getUniqueUnionType(
                  typeAttributes,
                  undefined,
                  forwardingRef,
              )
            : undefined;

        const types: TypeRef[] = [];
        for (const [kind, memberAttributes] of kinds) {
            if (kind === "tuple" && tupleGroups.length > 1) {
                // Each group keeps the attributes of its own tuples.
                const allTuples = typeProvider.tupleData;
                const allAttributes = typeProvider.tupleAttributes;
                for (const group of tupleGroups) {
                    const attributes =
                        allAttributes === undefined
                            ? emptyTypeAttributes
                            : unionTypeAttributes(
                                  group.map((t) =>
                                      defined(
                                          allAttributes[allTuples.indexOf(t)],
                                      ),
                                  ),
                              );
                    types.push(
                        this.makeTuple(
                            typeProvider,
                            group,
                            attributes,
                            undefined,
                        ),
                    );
                }

                continue;
            }

            if (kind === "object" && objectGroups !== undefined) {
                // Each object member keeps the attributes of its own
                // object types.
                for (const [objectData, attributes] of objectGroups) {
                    types.push(
                        this.makeObject(objectData, attributes, undefined),
                    );
                }

                continue;
            }

            types.push(
                this.makeTypeOfKind(
                    typeProvider,
                    kind,
                    memberAttributes,
                    undefined,
                ),
            );
        }

        const typesSet = new Set(types);
        if (union !== undefined) {
            this.typeBuilder.setSetOperationMembers(union, typesSet);
            return union;
        } else {
            return this.typeBuilder.getUnionType(
                typeAttributes,
                typesSet,
                forwardingRef,
            );
        }
    }
}
