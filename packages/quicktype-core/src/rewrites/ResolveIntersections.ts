/* eslint-disable @typescript-eslint/brace-style */
import {
    iterableEvery,
    iterableFind,
    iterableFirst,
    iterableSome,
    mapMap,
    mapMapEntries,
    mapMergeWithInto,
    mapUpdateInto,
    setFilter,
    setIntersect,
    setMap,
    setSubtract,
    setUnionInto,
} from "collection-utils";

import {
    isDistinctArray,
    itemIntersectionsConflict,
    keysOfKind,
} from "../attributes/DistinctArrays.js";
import { distinctObjectGroups } from "../attributes/DistinctObjects.js";
import {
    type TypeAttributes,
    combineTypeAttributes,
    emptyTypeAttributes,
    increaseTypeAttributesDistance,
    makeTypeAttributesInferred,
    unionTypeAttributes,
} from "../attributes/TypeAttributes.js";
import type { GraphRewriteBuilder, TypeLookerUp } from "../GraphRewriting.js";
import { assert, defined, mustNotHappen, panic } from "../support/Support.js";
import {
    ArrayType,
    GenericClassProperty,
    IntersectionType,
    ObjectType,
    type PrimitiveTypeKind,
    SetOperationType,
    TupleType,
    Type,
    type TypeKind,
    UnionType,
    isNumberTypeKind,
    isPrimitiveTypeKind,
} from "../Type/index.js";
import type { TypeBuilder } from "../Type/TypeBuilder.js";
import type { StringTypeMapping } from "../Type/TypeBuilderUtils.js";
import type { TypeGraph } from "../Type/TypeGraph.js";
import type { TypeRef } from "../Type/TypeRef.js";
import {
    makeGroupsToFlatten,
    matchTypeExhaustive,
    setOperationMembersRecursively,
} from "../Type/TypeUtils.js";
import {
    type TypeAttributeMap,
    UnionBuilder,
    type UnionTypeProvider,
} from "../UnionBuilder.js";

function canResolve(t: IntersectionType): boolean {
    const members = setOperationMembersRecursively(t, undefined)[0];
    if (members.size <= 1) return true;
    return iterableEvery(
        members,
        (m) => !(m instanceof UnionType) || m.isCanonical,
    );
}

function attributesForTypes<T extends TypeKind>(
    types: ReadonlySet<Type>,
): TypeAttributeMap<T> {
    return mapMapEntries(
        types.entries(),
        (t) => [t.kind, t.getAttributes()] as [T, TypeAttributes],
    );
}

// A type that a value must have, or a set of types, one of which it must
// have, from object types that a union keeps apart.
type TypeTerm = Type | ReadonlySet<Type>;

type PropertyMap = Map<string, GenericClassProperty<Set<TypeTerm>>>;

type ObjectData = [PropertyMap, ReadonlySet<TypeTerm> | undefined] | undefined;

function typeTerm(types: ReadonlySet<Type>): TypeTerm {
    return types.size === 1 ? defined(iterableFirst(types)) : types;
}

// The properties, additional properties, and attributes of the object types
// in a union.  A union only has more than one if it keeps them apart, see
// `distinctObjectGroups`.  Intersections unify them, like `unifyTypes` would,
// unless they distribute over the union, see `distributeObjects`:
// intersecting with each of them can make object types that are impossible.
function unifyObjects(
    objects: readonly ObjectType[],
): [
    ReadonlyMap<string, GenericClassProperty<TypeTerm>>,
    TypeTerm | undefined,
    TypeAttributes,
] {
    if (objects.length === 1) {
        const o = objects[0];
        return [
            mapMap(
                o.getProperties(),
                (cp) =>
                    new GenericClassProperty<TypeTerm>(cp.type, cp.isOptional),
            ),
            o.getAdditionalProperties(),
            o.getAttributes(),
        ];
    }

    const propertyNames = new Set<string>();
    for (const o of objects) {
        setUnionInto(propertyNames, o.getProperties().keys());
    }

    const properties = new Map<string, GenericClassProperty<TypeTerm>>();
    for (const name of propertyNames) {
        const types = new Set<Type>();
        let isOptional = false;
        for (const o of objects) {
            const property = o.getProperties().get(name);
            const additional = o.getAdditionalProperties();
            if (property !== undefined) {
                types.add(property.type);
                isOptional = isOptional || property.isOptional;
            } else {
                isOptional = true;
                if (additional !== undefined && additional.kind !== "any") {
                    types.add(additional);
                }
            }
        }

        properties.set(
            name,
            new GenericClassProperty(typeTerm(types), isOptional),
        );
    }

    const additionalTypes = new Set<Type>();
    for (const o of objects) {
        const additional = o.getAdditionalProperties();
        if (additional !== undefined) additionalTypes.add(additional);
    }

    return [
        properties,
        additionalTypes.size === 0 ? undefined : typeTerm(additionalTypes),
        increaseTypeAttributesDistance(
            combineTypeAttributes(
                "union",
                objects.map((o) => o.getAttributes()),
            ),
        ),
    ];
}

// The types of one kind, object or array, that an intersection intersects,
// for each case of a union it distributes over: a union that keeps several
// object or array types apart, see `distinctObjectGroups` and
// `distinctArrayGroups`.  The intersection is then the union of its
// intersections with each of them, if those can be kept apart, too, see
// `distributeObjects` and `distributeArrays`.  It distributes over at most
// one union.
class Distribution<T extends Type> {
    private _cases: T[][] | undefined = [[]];

    private _isDistributed = false;

    public add(types: readonly T[]): void {
        if (this._cases === undefined) return;

        if (types.length === 0) {
            this._cases = undefined;
        } else if (types.length === 1) {
            for (const c of this._cases) {
                c.push(types[0]);
            }
        } else if (this._isDistributed) {
            this._cases = undefined;
        } else {
            this._isDistributed = true;
            this._cases = this._cases.flatMap((c) =>
                types.map((t) => [...c, t]),
            );
        }
    }

    public get cases(): ReadonlyArray<readonly T[]> | undefined {
        return this._isDistributed ? this._cases : undefined;
    }
}

// The keys, see `keysOfKind`, of the values of `t`, or `undefined` if it can
// have values of any key.  An intersection that hasn't been resolved yet
// can only have values of the keys of all its members.
function valueKeys(t: Type, seen: Set<Type>): ReadonlySet<string> | undefined {
    if (t.kind === "any" || seen.has(t)) return undefined;
    if (t.kind === "none") return new Set();
    if (!(t instanceof SetOperationType)) return new Set(keysOfKind(t.kind));

    seen.add(t);
    const keys =
        t instanceof UnionType
            ? unionKeys(t.members, seen)
            : intersectionKeys(t.members, seen);
    seen.delete(t);
    return keys;
}

function unionKeys(
    types: Iterable<Type>,
    seen: Set<Type>,
): ReadonlySet<string> | undefined {
    const keys = new Set<string>();
    for (const t of types) {
        const memberKeys = valueKeys(t, seen);
        if (memberKeys === undefined) return undefined;
        setUnionInto(keys, memberKeys);
    }

    return keys;
}

function intersectionKeys(
    terms: Iterable<TypeTerm>,
    seen: Set<Type>,
): ReadonlySet<string> | undefined {
    let keys: ReadonlySet<string> | undefined;
    for (const term of terms) {
        const termKeys =
            term instanceof Type
                ? valueKeys(term, seen)
                : unionKeys(term, seen);
        if (termKeys === undefined) continue;
        keys = keys === undefined ? termKeys : setIntersect(keys, termKeys);
    }

    return keys;
}

// The object types an intersection makes by distributing over the object
// types of a union, one for each, if they can be kept apart, too: each must
// not allow additional properties, and must be made from different
// schemas, so that a union keeps them apart, see `distinctObjectGroups`.
// Each must also have values.  An object type that doesn't allow
// additional properties must declare all properties the others declare:
// the intersection keeps them, though it doesn't allow them, and one that
// another requires would make it impossible.  A property of types without
// values in common, such as one declared `false`, is left out if it's
// optional, and makes the object type impossible if it's required.
// Otherwise the intersection unifies the union's object types into one,
// see `unifyObjects`.
function distributeObjects(
    cases: ReadonlyArray<readonly ObjectType[]> | undefined,
    intersect: (
        objects: readonly ObjectType[],
    ) => [PropertyMap, ReadonlySet<TypeTerm> | undefined, TypeAttributes],
): Array<[ObjectData, TypeAttributes]> | undefined {
    if (cases === undefined) return undefined;

    const groups: Array<[ObjectData, TypeAttributes]> = [];
    for (const objects of cases) {
        const [properties, additionalProperties, attributes] =
            intersect(objects);
        if (additionalProperties !== undefined) return undefined;

        for (const o of objects) {
            if (o.getAdditionalProperties() !== undefined) continue;
            for (const name of properties.keys()) {
                if (!o.getProperties().has(name)) return undefined;
            }
        }

        for (const [name, property] of properties) {
            const keys = intersectionKeys(property.typeData, new Set());
            if (keys === undefined || keys.size > 0) continue;

            if (!property.isOptional) return undefined;
            properties.delete(name);
        }

        groups.push([[properties, undefined], attributes]);
    }

    const distinctGroups = distinctObjectGroups(groups.map(([, a]) => a));
    if (distinctGroups === undefined || distinctGroups.length < groups.length) {
        return undefined;
    }

    return groups;
}

// The array types an intersection makes by distributing over the array
// types of a union, one for each, if a union keeps them apart, too, see
// `distinctArrayGroups`.  Otherwise the intersection unifies the union's
// array types into one, see `updateArrayItemTypes`.
function distributeArrays(
    cases: ReadonlyArray<readonly ArrayType[]> | undefined,
): Array<[ReadonlySet<TypeTerm>, TypeAttributes]> | undefined {
    if (cases === undefined) return undefined;

    const items = cases.map((arrays) =>
        arrays.map((a) => a.items).filter((t) => t.kind !== "any"),
    );
    const attributes = cases.map((arrays) =>
        combineTypeAttributes(
            "intersect",
            arrays.map((a) => a.getAttributes()),
        ),
    );
    if (!attributes.every(isDistinctArray)) return undefined;

    for (let i = 0; i < cases.length; i++) {
        for (let j = i + 1; j < cases.length; j++) {
            if (itemIntersectionsConflict(items[i], items[j])) {
                return undefined;
            }
        }
    }

    return cases.map((_, i) => [new Set<TypeTerm>(items[i]), attributes[i]]);
}

// The members of an intersection without the unions that keep several
// object or array types apart and have another member as one of theirs,
// and the attributes of those unions: the intersection of such a union and
// one of its members is that member.  Distributing over the union could
// only unify the union's other members instead, if intersecting them with
// that one makes impossible types, see `distributeObjects`.
function withoutAbsorbedUnions(
    members: ReadonlySet<Type>,
): [ReadonlySet<Type>, TypeAttributes] {
    const absorbed = setFilter(members, (u) => {
        if (!(u instanceof UnionType)) return false;

        const unionMembers = Array.from(u.members);
        const objects = unionMembers.filter((m) => m instanceof ObjectType);
        const arrays = unionMembers.filter((m) => m instanceof ArrayType);
        if (objects.length < 2 && arrays.length < 2) return false;

        return iterableSome(members, (m) => m !== u && u.members.has(m));
    });
    if (absorbed.size === 0) return [members, emptyTypeAttributes];

    const attributes = makeTypeAttributesInferred(
        combineTypeAttributes(
            "intersect",
            Array.from(absorbed, (u) => u.getAttributes()),
        ),
    );
    return [setSubtract(members, absorbed), attributes];
}

class IntersectionAccumulator
    implements UnionTypeProvider<ReadonlySet<TypeTerm>, ObjectData>
{
    private _primitiveTypes: Set<PrimitiveTypeKind> | undefined;

    private readonly _primitiveAttributes: TypeAttributeMap<PrimitiveTypeKind> =
        new Map();

    // * undefined: We haven't seen any types yet.
    // * Set: All types we've seen can be arrays.
    // * false: At least one of the types seen can't be an array.
    private _arrayItemTypes: Set<TypeTerm> | undefined | false;

    private _arrayAttributes: TypeAttributes = emptyTypeAttributes;

    // The tuples among the intersected types.  If there are any, the
    // intersection is a tuple, and the item types of the arrays in
    // `_arrayItemTypes` constrain each of its items.
    private readonly _tuples: TupleType[] = [];

    private readonly _arrayCases = new Distribution<ArrayType>();

    // We start out with all object types allowed, which means
    // _additionalPropertyTypes is empty - no restrictions - and
    // _classProperties is empty - no defined properties so far.
    //
    // If _additionalPropertyTypes is undefined, no additional
    // properties are allowed anymore.  If _classProperties is
    // undefined, no object types are allowed, in which case
    // _additionalPropertyTypes must also be undefined;
    private _objectProperties: PropertyMap | undefined = new Map();

    private _objectAttributes: TypeAttributes = emptyTypeAttributes;

    private _additionalPropertyTypes: Set<TypeTerm> | undefined = new Set();

    private readonly _objectCases = new Distribution<ObjectType>();

    private _lostTypeAttributes = false;

    private updatePrimitiveTypes(members: Iterable<Type>): void {
        const types = setFilter(members, (t) => isPrimitiveTypeKind(t.kind));
        const attributes = attributesForTypes<PrimitiveTypeKind>(types);
        mapMergeWithInto(
            this._primitiveAttributes,
            (a, b) => combineTypeAttributes("intersect", a, b),
            attributes,
        );

        const kinds = setMap(
            types,
            (t) => t.kind,
        ) as ReadonlySet<PrimitiveTypeKind>;
        if (this._primitiveTypes === undefined) {
            this._primitiveTypes = new Set(kinds);
            return;
        }

        const haveNumber =
            iterableFind(this._primitiveTypes, isNumberTypeKind) !==
                undefined &&
            iterableFind(kinds, isNumberTypeKind) !== undefined;
        this._primitiveTypes = setIntersect(this._primitiveTypes, kinds);
        if (
            haveNumber &&
            iterableFind(this._primitiveTypes, isNumberTypeKind) === undefined
        ) {
            // One set has integer, the other has double.  The intersection
            // of that is integer.
            this._primitiveTypes = this._primitiveTypes.add("integer");
        }
    }

    // A union only has more than one array type if it keeps them apart, see
    // `distinctArrayGroups`.  Intersections unify them, like `unifyTypes`
    // would, unless they distribute over the union, see `distributeArrays`:
    // the items must be of one of their item types.
    private updateArrayItemTypes(members: Iterable<Type>): void {
        const maybeTuple = iterableFind(
            members,
            (t) => t instanceof TupleType,
        ) as TupleType | undefined;
        if (maybeTuple !== undefined) {
            this._arrayAttributes = combineTypeAttributes(
                "intersect",
                this._arrayAttributes,
                maybeTuple.getAttributes(),
            );
            if (this._arrayItemTypes === undefined) {
                this._arrayItemTypes = new Set();
            }

            if (this._arrayItemTypes !== false) {
                this._tuples.push(maybeTuple);
            }

            return;
        }

        const arrays = Array.from(members).filter(
            (t): t is ArrayType => t instanceof ArrayType,
        );
        this._arrayCases.add(arrays);
        if (arrays.length === 0) {
            this._arrayItemTypes = false;
            return;
        }

        this._arrayAttributes = combineTypeAttributes(
            "intersect",
            this._arrayAttributes,
            arrays.length === 1
                ? arrays[0].getAttributes()
                : increaseTypeAttributesDistance(
                      unionTypeAttributes(arrays.map((a) => a.getAttributes())),
                  ),
        );

        const items = typeTerm(new Set(arrays.map((a) => a.items)));
        if (this._arrayItemTypes === undefined) {
            this._arrayItemTypes = new Set([items]);
        } else if (this._arrayItemTypes !== false) {
            this._arrayItemTypes.add(items);
        }
    }

    private updateObjectProperties(members: Iterable<Type>): void {
        const objects = Array.from(members).filter(
            (t): t is ObjectType => t instanceof ObjectType,
        );
        this._objectCases.add(objects);
        if (objects.length === 0) {
            this._objectProperties = undefined;
            this._additionalPropertyTypes = undefined;
            return;
        }

        const [objectProperties, objectAdditionalProperties, attributes] =
            unifyObjects(objects);
        this._objectAttributes = combineTypeAttributes(
            "intersect",
            this._objectAttributes,
            attributes,
        );

        if (this._objectProperties === undefined) {
            assert(this._additionalPropertyTypes === undefined);
            return;
        }

        const allPropertyNames = setUnionInto(
            new Set(this._objectProperties.keys()),
            objectProperties.keys(),
        );
        for (const name of allPropertyNames) {
            const existing = defined(this._objectProperties).get(name);
            const newProperty = objectProperties.get(name);

            // A property declared by any intersection member is known on
            // the merged object.  A member that doesn't allow additional
            // properties must not discard properties declared by others.
            if (existing !== undefined && newProperty !== undefined) {
                const cp = new GenericClassProperty(
                    existing.typeData.add(newProperty.typeData),
                    existing.isOptional && newProperty.isOptional,
                );
                defined(this._objectProperties).set(name, cp);
            } else if (
                existing !== undefined &&
                objectAdditionalProperties !== undefined
            ) {
                const cp = new GenericClassProperty(
                    existing.typeData.add(objectAdditionalProperties),
                    existing.isOptional,
                );
                defined(this._objectProperties).set(name, cp);
            } else if (newProperty !== undefined) {
                const types =
                    this._additionalPropertyTypes === undefined
                        ? new Set([newProperty.typeData])
                        : new Set(this._additionalPropertyTypes).add(
                              newProperty.typeData,
                          );
                defined(this._objectProperties).set(
                    name,
                    new GenericClassProperty(types, newProperty.isOptional),
                );
            } else if (existing === undefined) {
                mustNotHappen();
            }
        }

        if (
            this._additionalPropertyTypes !== undefined &&
            objectAdditionalProperties !== undefined
        ) {
            this._additionalPropertyTypes.add(objectAdditionalProperties);
        } else if (
            this._additionalPropertyTypes !== undefined ||
            objectAdditionalProperties !== undefined
        ) {
            this._additionalPropertyTypes = undefined;
            this._lostTypeAttributes = true;
        }
    }

    private addUnionSet(members: Iterable<Type>): void {
        this.updatePrimitiveTypes(members);
        this.updateArrayItemTypes(members);
        this.updateObjectProperties(members);
    }

    public addType(t: Type): TypeAttributes {
        let attributes = t.getAttributes();
        matchTypeExhaustive(
            t,
            (_noneType) => {
                return panic("There shouldn't be a none type");
            },
            (_anyType) => {
                return panic(
                    "The any type should have been filtered out in setOperationMembersRecursively",
                );
            },
            (nullType) => this.addUnionSet([nullType]),
            (boolType) => this.addUnionSet([boolType]),
            (integerType) => this.addUnionSet([integerType]),
            (doubleType) => this.addUnionSet([doubleType]),
            (stringType) => this.addUnionSet([stringType]),
            (arrayType) => this.addUnionSet([arrayType]),
            (_classType) =>
                panic("We should never see class types in intersections"),
            (_mapType) =>
                panic("We should never see map types in intersections"),
            (objectType) => this.addUnionSet([objectType]),
            (_enumType) =>
                panic("We should never see enum types in intersections"),
            (unionType) => {
                attributes = combineTypeAttributes(
                    "intersect",
                    [attributes].concat(
                        Array.from(unionType.members).map((m) =>
                            m.getAttributes(),
                        ),
                    ),
                );
                this.addUnionSet(unionType.members);
            },
            (transformedStringType) =>
                this.addUnionSet([transformedStringType]),
            (tupleType) => this.addUnionSet([tupleType]),
        );
        return makeTypeAttributesInferred(attributes);
    }

    public get arrayData(): ReadonlySet<TypeTerm> {
        if (
            this._arrayItemTypes === undefined ||
            this._arrayItemTypes === false
        ) {
            return panic(
                "This should not be called if the type can't be an array",
            );
        }

        return this._arrayItemTypes;
    }

    public get tupleData(): readonly TupleType[] {
        return this._tuples;
    }

    public get arrayGroups():
        | Array<[ReadonlySet<TypeTerm>, TypeAttributes]>
        | undefined {
        return distributeArrays(this._arrayCases.cases);
    }

    public get objectGroups(): Array<[ObjectData, TypeAttributes]> | undefined {
        return distributeObjects(this._objectCases.cases, (objects) => {
            const accumulator = new IntersectionAccumulator();
            for (const o of objects) {
                accumulator.updateObjectProperties([o]);
            }

            return [
                defined(accumulator._objectProperties),
                accumulator._additionalPropertyTypes,
                accumulator._objectAttributes,
            ];
        });
    }

    public get objectData(): ObjectData {
        if (this._objectProperties === undefined) {
            assert(this._additionalPropertyTypes === undefined);
            return undefined;
        }

        return [this._objectProperties, this._additionalPropertyTypes];
    }

    public get enumCases(): ReadonlySet<string> {
        return panic("We don't support enums in intersections");
    }

    public getMemberKinds(): TypeAttributeMap<TypeKind> {
        const kinds: TypeAttributeMap<TypeKind> = mapMap(
            defined(this._primitiveTypes).entries(),
            (k) => defined(this._primitiveAttributes.get(k)),
        );
        const maybeDoubleAttributes = this._primitiveAttributes.get("double");
        // If double was eliminated, add its attributes to integer
        if (
            maybeDoubleAttributes !== undefined &&
            !kinds.has("double") &&
            kinds.has("integer")
        ) {
            // FIXME: How can this ever happen???  Where do we "eliminate" double?
            mapUpdateInto(kinds, "integer", (a) => {
                return combineTypeAttributes(
                    "intersect",
                    defined(a),
                    maybeDoubleAttributes,
                );
            });
        }

        if (
            this._arrayItemTypes !== undefined &&
            this._arrayItemTypes !== false
        ) {
            kinds.set(
                this._tuples.length > 0 ? "tuple" : "array",
                this._arrayAttributes,
            );
        } else if (this._arrayAttributes.size > 0) {
            this._lostTypeAttributes = true;
        }

        if (this._objectProperties !== undefined) {
            kinds.set("object", this._objectAttributes);
        } else if (this._objectAttributes.size > 0) {
            this._lostTypeAttributes = true;
        }

        // Types without values in common, like a string and an integer,
        // intersect to none, as an empty union is, and as a `false` schema.
        if (kinds.size === 0) {
            kinds.set("none", emptyTypeAttributes);
        }

        return kinds;
    }

    public get lostTypeAttributes(): boolean {
        return this._lostTypeAttributes;
    }
}

class IntersectionUnionBuilder extends UnionBuilder<
    TypeBuilder & TypeLookerUp,
    ReadonlySet<TypeTerm>,
    ObjectData
> {
    private _createdNewIntersections = false;

    private makeIntersection(
        members: ReadonlySet<TypeTerm>,
        attributes: TypeAttributes,
    ): TypeRef {
        const reconstitutedMembers = setMap(members, (t) =>
            t instanceof Type
                ? this.typeBuilder.reconstituteTypeRef(t.typeRef)
                : this.typeBuilder.getUnionType(
                      emptyTypeAttributes,
                      setMap(t, (m) =>
                          this.typeBuilder.reconstituteTypeRef(m.typeRef),
                      ),
                  ),
        );

        const first = defined(iterableFirst(reconstitutedMembers));
        if (reconstitutedMembers.size === 1) {
            this.typeBuilder.addAttributes(first, attributes);
            return first;
        }

        this._createdNewIntersections = true;
        return this.typeBuilder.getUniqueIntersectionType(
            attributes,
            reconstitutedMembers,
        );
    }

    public get createdNewIntersections(): boolean {
        return this._createdNewIntersections;
    }

    protected makeObject(
        maybeData: ObjectData,
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef {
        if (maybeData === undefined) {
            return panic(
                "Either properties or additional properties must be given to make an object type",
            );
        }

        const [propertyTypes, maybeAdditionalProperties] = maybeData;
        const properties = mapMap(propertyTypes, (cp) =>
            this.typeBuilder.makeClassProperty(
                this.makeIntersection(cp.typeData, emptyTypeAttributes),
                cp.isOptional,
            ),
        );
        const additionalProperties =
            maybeAdditionalProperties === undefined
                ? undefined
                : this.makeIntersection(
                      maybeAdditionalProperties,
                      emptyTypeAttributes,
                  );
        return this.typeBuilder.getUniqueObjectType(
            typeAttributes,
            properties,
            additionalProperties,
            forwardingRef,
        );
    }

    protected makeArray(
        arrays: ReadonlySet<TypeTerm>,
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef {
        // FIXME: attributes
        const itemsType = this.makeIntersection(arrays, emptyTypeAttributes);
        const tref = this.typeBuilder.getArrayType(
            typeAttributes,
            itemsType,
            forwardingRef,
        );
        return tref;
    }

    protected makeTuple(
        typeProvider: UnionTypeProvider<ReadonlySet<TypeTerm>, ObjectData>,
        allTuples: readonly TupleType[],
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef {
        const first = defined(allTuples[0]);
        // Tuples of another shape than the first can't be intersected
        // position by position; they are left out.
        const tuples = allTuples.filter(
            (t) =>
                t.items.length === first.items.length &&
                t.minItems === first.minItems &&
                (t.rest === undefined) === (first.rest === undefined),
        );
        if (tuples.length !== allTuples.length) {
            this.typeBuilder.setLostTypeAttributes();
        }

        const arrayItems = Array.from(typeProvider.arrayData);
        const items = first.items.map((_, i) =>
            this.makeIntersection(
                new Set([...tuples.map((t) => t.items[i]), ...arrayItems]),
                emptyTypeAttributes,
            ),
        );
        const rest =
            first.rest === undefined
                ? undefined
                : this.makeIntersection(
                      new Set([
                          ...tuples.map((t) => defined(t.rest)),
                          ...arrayItems,
                      ]),
                      emptyTypeAttributes,
                  );
        return this.typeBuilder.getTupleType(
            typeAttributes,
            items,
            first.minItems,
            rest,
            forwardingRef,
        );
    }
}

export function resolveIntersections(
    graph: TypeGraph,
    stringTypeMapping: StringTypeMapping,
    debugPrintReconstitution: boolean,
): [TypeGraph, boolean] {
    let needsRepeat = false;

    function replace(
        types: ReadonlySet<Type>,
        builder: GraphRewriteBuilder<Type>,
        forwardingRef: TypeRef,
    ): TypeRef {
        const intersections = setFilter(
            types,
            (t) => t instanceof IntersectionType,
        ) as Set<IntersectionType>;
        const [allMembers, setOperationAttributes] =
            setOperationMembersRecursively(
                Array.from(intersections),
                "intersect",
            );
        const [members, absorbedAttributes] = withoutAbsorbedUnions(allMembers);
        const intersectionAttributes = combineTypeAttributes(
            "intersect",
            setOperationAttributes,
            absorbedAttributes,
        );
        if (members.size === 0) {
            const t = builder.getPrimitiveType(
                "any",
                intersectionAttributes,
                forwardingRef,
            );
            return t;
        }

        const noneType = iterableFind(members, (t) => t.kind === "none");
        if (noneType !== undefined) {
            return builder.reconstituteType(
                noneType,
                intersectionAttributes,
                forwardingRef,
            );
        }

        if (members.size === 1) {
            return builder.reconstituteType(
                defined(iterableFirst(members)),
                intersectionAttributes,
                forwardingRef,
            );
        }

        const accumulator = new IntersectionAccumulator();
        const extraAttributes = makeTypeAttributesInferred(
            combineTypeAttributes(
                "intersect",
                Array.from(members).map((t) => accumulator.addType(t)),
            ),
        );
        const attributes = combineTypeAttributes(
            "intersect",
            intersectionAttributes,
            extraAttributes,
        );

        const unionBuilder = new IntersectionUnionBuilder(builder);
        const tref = unionBuilder.buildUnion(
            accumulator,
            true,
            attributes,
            forwardingRef,
        );
        if (unionBuilder.createdNewIntersections) {
            needsRepeat = true;
        }

        return tref;
    }

    // FIXME: We need to handle intersections that resolve to the same set of types.
    // See for example the intersections-nested.schema example.
    const allIntersections = setFilter(
        graph.allTypesUnordered(),
        (t) => t instanceof IntersectionType,
    ) as Set<IntersectionType>;
    const resolvableIntersections = setFilter(allIntersections, canResolve);
    const groups = makeGroupsToFlatten(resolvableIntersections, undefined);
    graph = graph.rewrite(
        "resolve intersections",
        stringTypeMapping,
        false,
        groups,
        debugPrintReconstitution,
        replace,
    );

    // console.log(`resolved ${resolvableIntersections.size} of ${intersections.size} intersections`);
    return [
        graph,
        !needsRepeat && allIntersections.size === resolvableIntersections.size,
    ];
}
