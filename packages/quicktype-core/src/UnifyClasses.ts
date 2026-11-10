import { iterableFirst, mapFilter, setUnionInto } from "collection-utils";

import { minMaxItemsTypeAttributeKind } from "./attributes/Constraints.js";
import {
    type TypeAttributes,
    combineTypeAttributes,
    emptyTypeAttributes,
    unionTypeAttributes,
} from "./attributes/TypeAttributes.js";
import type {
    BaseGraphRewriteBuilder,
    GraphRewriteBuilder,
    TypeLookerUp,
} from "./GraphRewriting.js";
import { assert, defined, panic } from "./support/Support.js";
import {
    type ClassProperty,
    type ObjectType,
    type TupleType,
    type Type,
    UnionType,
} from "./Type/Type.js";
import type { TypeBuilder } from "./Type/TypeBuilder.js";
import { type TypeRef, derefTypeRef } from "./Type/TypeRef.js";
import { assertIsObject } from "./Type/TypeUtils.js";
import {
    TypeRefUnionAccumulator,
    UnionBuilder,
    type UnionTypeProvider,
} from "./UnionBuilder.js";

function getCliqueProperties(
    clique: ObjectType[],
    builder: TypeBuilder,
    makePropertyType: (types: ReadonlySet<Type>) => TypeRef,
): [ReadonlyMap<string, ClassProperty>, TypeRef | undefined, boolean] {
    const lostTypeAttributes = false;
    const propertyNames = new Set<string>();
    for (const o of clique) {
        setUnionInto(propertyNames, o.getProperties().keys());
    }

    const properties = Array.from(propertyNames).map(
        (name) => [name, new Set(), false] as [string, Set<Type>, boolean],
    );
    let additionalProperties: Set<Type> | undefined;
    for (const o of clique) {
        const additional = o.getAdditionalProperties();
        if (additional !== undefined) {
            if (additionalProperties === undefined) {
                additionalProperties = new Set();
            }

            if (additional !== undefined) {
                additionalProperties.add(additional);
            }
        }

        for (const property of properties) {
            let [name, types, isOptional] = property;
            const maybeProperty = o.getProperties().get(name);
            if (maybeProperty === undefined) {
                isOptional = true;
                if (additional !== undefined && additional.kind !== "any") {
                    types.add(additional);
                }
            } else {
                if (maybeProperty.isOptional) {
                    isOptional = true;
                }

                types.add(maybeProperty.type);
            }

            property[2] = isOptional;
        }
    }

    const unifiedAdditionalProperties =
        additionalProperties === undefined
            ? undefined
            : makePropertyType(additionalProperties);

    const unifiedPropertiesArray = properties.map(
        ([name, types, isOptional]) => {
            return [
                name,
                builder.makeClassProperty(makePropertyType(types), isOptional),
            ] as [string, ClassProperty];
        },
    );
    const unifiedProperties = new Map(unifiedPropertiesArray);

    return [unifiedProperties, unifiedAdditionalProperties, lostTypeAttributes];
}

function countProperties(clique: ObjectType[]): {
    hasAdditionalProperties: boolean;
    hasNonAnyAdditionalProperties: boolean;
    hasProperties: boolean;
} {
    let hasProperties = false;
    let hasAdditionalProperties = false;
    let hasNonAnyAdditionalProperties = false;
    for (const o of clique) {
        if (o.getProperties().size > 0) {
            hasProperties = true;
        }

        const additional = o.getAdditionalProperties();
        if (additional !== undefined) {
            hasAdditionalProperties = true;
            if (additional.kind !== "any") {
                hasNonAnyAdditionalProperties = true;
            }
        }
    }

    return {
        hasProperties,
        hasAdditionalProperties,
        hasNonAnyAdditionalProperties,
    };
}

export class UnifyUnionBuilder extends UnionBuilder<
    BaseGraphRewriteBuilder,
    TypeRef[],
    TypeRef[]
> {
    public constructor(
        typeBuilder: BaseGraphRewriteBuilder,
        private readonly _makeObjectTypes: boolean,
        private readonly _makeClassesFixed: boolean,
        private readonly _unifyTypes: (typesToUnify: TypeRef[]) => TypeRef,
    ) {
        super(typeBuilder);
    }

    protected makeObject(
        objectRefs: TypeRef[],
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef {
        const maybeTypeRef = this.typeBuilder.lookupTypeRefs(
            objectRefs,
            forwardingRef,
        );
        if (maybeTypeRef !== undefined) {
            assert(
                forwardingRef === undefined || maybeTypeRef === forwardingRef,
                "The forwarding ref must be consumed",
            );
            this.typeBuilder.addAttributes(maybeTypeRef, typeAttributes);
            return maybeTypeRef;
        }

        if (objectRefs.length === 1) {
            return this.typeBuilder.reconstituteTypeRef(
                objectRefs[0],
                typeAttributes,
                forwardingRef,
            );
        }

        const objectTypes = objectRefs.map((r) =>
            assertIsObject(derefTypeRef(r, this.typeBuilder)),
        );
        const {
            hasProperties,
            hasAdditionalProperties,
            hasNonAnyAdditionalProperties,
        } = countProperties(objectTypes);

        if (
            !this._makeObjectTypes &&
            (hasNonAnyAdditionalProperties ||
                (!hasProperties && hasAdditionalProperties))
        ) {
            const propertyTypes = new Set<TypeRef>();
            for (const o of objectTypes) {
                setUnionInto(
                    propertyTypes,
                    Array.from(o.getProperties().values()).map(
                        (cp) => cp.typeRef,
                    ),
                );
            }

            const additionalPropertyTypes = new Set(
                objectTypes
                    .filter((o) => o.getAdditionalProperties() !== undefined)
                    .map((o) => defined(o.getAdditionalProperties()).typeRef),
            );
            setUnionInto(propertyTypes, additionalPropertyTypes);
            return this.typeBuilder.getMapType(
                typeAttributes,
                this._unifyTypes(Array.from(propertyTypes)),
                forwardingRef,
            );
        } else {
            const [properties, additionalProperties, lostTypeAttributes] =
                getCliqueProperties(objectTypes, this.typeBuilder, (types) => {
                    assert(types.size > 0, "Property has no type");
                    return this._unifyTypes(
                        Array.from(types).map((t) => t.typeRef),
                    );
                });
            if (lostTypeAttributes) {
                this.typeBuilder.setLostTypeAttributes();
            }

            if (this._makeObjectTypes) {
                return this.typeBuilder.getUniqueObjectType(
                    typeAttributes,
                    properties,
                    additionalProperties,
                    forwardingRef,
                );
            } else {
                assert(
                    additionalProperties === undefined,
                    "We have additional properties but want to make a class",
                );
                return this.typeBuilder.getUniqueClassType(
                    typeAttributes,
                    this._makeClassesFixed,
                    properties,
                    forwardingRef,
                );
            }
        }
    }

    protected makeArray(
        arrays: TypeRef[],
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef {
        const ref = this.typeBuilder.getArrayType(
            typeAttributes,
            this._unifyTypes(arrays),
            forwardingRef,
        );
        return ref;
    }

    // The tuples have the same shape, so they are unified item by item.
    protected makeTuple(
        _typeProvider: UnionTypeProvider<TypeRef[], TypeRef[]>,
        tuples: readonly TupleType[],
        typeAttributes: TypeAttributes,
        forwardingRef: TypeRef | undefined,
    ): TypeRef {
        const first = defined(tuples[0]);
        // A single tuple is reconstituted, like a single object, so that
        // it keeps its own attributes, such as a given name.  The union's
        // attributes for it can include `minItems`/`maxItems`, which a tuple
        // has in its shape instead; added to a tuple that was already
        // rebuilt elsewhere, they would conflict with its identity.
        if (tuples.length === 1) {
            const tupleAttributes = mapFilter(
                typeAttributes,
                (_, k) => k !== minMaxItemsTypeAttributeKind,
            );
            const maybeTypeRef = this.typeBuilder.lookupTypeRefs(
                [first.typeRef],
                forwardingRef,
            );
            if (maybeTypeRef !== undefined) {
                this.typeBuilder.addAttributes(maybeTypeRef, tupleAttributes);
                return maybeTypeRef;
            }

            return this.typeBuilder.reconstituteTypeRef(
                first.typeRef,
                tupleAttributes,
                forwardingRef,
            );
        }

        const items = first.items.map((_, i) =>
            this._unifyTypes(tuples.map((t) => t.items[i].typeRef)),
        );
        const rest =
            first.rest === undefined
                ? undefined
                : this._unifyTypes(tuples.map((t) => defined(t.rest).typeRef));
        return this.typeBuilder.getTupleType(
            combineTypeAttributes(
                "union",
                typeAttributes,
                unionTypeAttributes(tuples.map((t) => t.getAttributes())),
            ),
            items,
            first.minItems,
            rest,
            forwardingRef,
        );
    }
}

export function unionBuilderForUnification<T extends Type>(
    typeBuilder: GraphRewriteBuilder<T>,
    makeObjectTypes: boolean,
    makeClassesFixed: boolean,
    conflateNumbers: boolean,
): UnionBuilder<TypeBuilder & TypeLookerUp, TypeRef[], TypeRef[]> {
    return new UnifyUnionBuilder(
        typeBuilder,
        makeObjectTypes,
        makeClassesFixed,
        (trefs) =>
            unifyTypes(
                new Set(trefs.map((tref) => derefTypeRef(tref, typeBuilder))),
                emptyTypeAttributes,
                typeBuilder,
                unionBuilderForUnification(
                    typeBuilder,
                    makeObjectTypes,
                    makeClassesFixed,
                    conflateNumbers,
                ),
                conflateNumbers,
            ),
    );
}

// typeAttributes must not be reconstituted yet.
// FIXME: The UnionBuilder might end up not being used.
export function unifyTypes<T extends Type>(
    types: ReadonlySet<Type>,
    typeAttributes: TypeAttributes,
    typeBuilder: GraphRewriteBuilder<T>,
    unionBuilder: UnionBuilder<
        TypeBuilder & TypeLookerUp,
        TypeRef[],
        TypeRef[]
    >,
    conflateNumbers: boolean,
    maybeForwardingRef?: TypeRef,
): TypeRef {
    typeAttributes = typeBuilder.reconstituteTypeAttributes(typeAttributes);
    if (types.size === 0) {
        return panic("Cannot unify empty set of types");
    } else if (types.size === 1) {
        const first = defined(iterableFirst(types));
        if (!(first instanceof UnionType)) {
            return typeBuilder.reconstituteTypeRef(
                first.typeRef,
                typeAttributes,
                maybeForwardingRef,
            );
        }
    }

    const typeRefs = Array.from(types).map((t) => t.typeRef);
    const maybeTypeRef = typeBuilder.lookupTypeRefs(
        typeRefs,
        maybeForwardingRef,
    );
    if (maybeTypeRef !== undefined) {
        typeBuilder.addAttributes(maybeTypeRef, typeAttributes);
        return maybeTypeRef;
    }

    const accumulator = new TypeRefUnionAccumulator(conflateNumbers);
    const nestedAttributes = typeBuilder.reconstituteTypeAttributes(
        accumulator.addTypes(types),
    );
    typeAttributes = combineTypeAttributes(
        "union",
        typeAttributes,
        nestedAttributes,
    );

    return typeBuilder.withForwardingRef(
        maybeForwardingRef,
        (forwardingRef) => {
            typeBuilder.registerUnion(typeRefs, forwardingRef);
            return unionBuilder.buildUnion(
                accumulator,
                false,
                typeAttributes,
                forwardingRef,
            );
        },
    );
}
