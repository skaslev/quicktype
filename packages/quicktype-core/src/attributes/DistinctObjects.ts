import { setUnionManyInto } from "collection-utils";

import type { TypeKind } from "../Type/TransformedStringType.js";

import { TypeAttributeKind, type TypeAttributes } from "./TypeAttributes.js";

// Distinct object types are the object types that unions keep apart instead
// of unifying them into one, for targets that support unions with several
// classes.  JSON Schema input makes one for each object schema that forbids
// additional properties.  This attribute holds the object schemas, by
// number, that a distinct object type was made from: intersections collect
// the schemas of the object types they intersect, and unions keep object
// types made from different schemas apart, see `distinctObjectGroups`.
class DistinctObjectTypeAttributeKind extends TypeAttributeKind<
    ReadonlySet<number>
> {
    public constructor() {
        super("distinctObject");
    }

    public appliesToTypeKind(kind: TypeKind): boolean {
        return kind === "object" || kind === "class" || kind === "map";
    }

    public combine(arr: Array<ReadonlySet<number>>): ReadonlySet<number> {
        return setUnionManyInto(new Set(), arr);
    }

    public makeInferred(_: ReadonlySet<number>): undefined {
        return undefined;
    }

    public stringify(schemas: ReadonlySet<number>): string {
        return keyForSchemas(schemas);
    }
}

function keyForSchemas(schemas: ReadonlySet<number>): string {
    return Array.from(schemas)
        .sort((a, b) => a - b)
        .join(",");
}

export const distinctObjectTypeAttributeKind: TypeAttributeKind<
    ReadonlySet<number>
> = new DistinctObjectTypeAttributeKind();

let nextObjectSchema = 0;

/** The attributes of a distinct object type made from a new schema. */
export function makeDistinctObjectAttributes(): TypeAttributes {
    const attributes = distinctObjectTypeAttributeKind.makeAttributes(
        new Set([nextObjectSchema]),
    );
    nextObjectSchema += 1;
    return attributes;
}

export function isDistinctObject(attributes: TypeAttributes): boolean {
    return (
        distinctObjectTypeAttributeKind.tryGetInAttributes(attributes) !==
        undefined
    );
}

/**
 * The object types of a union, given by their attributes, that the union
 * keeps apart, as groups of indexes, one for each object member of the
 * union.  Object types made from the same schemas make one member.  Returns
 * `undefined` if the union unifies all of them into one, which it does if
 * any of them isn't a distinct object type.
 */
export function distinctObjectGroups(
    attributes: readonly TypeAttributes[],
): number[][] | undefined {
    if (attributes.length < 2) return undefined;

    const groups = new Map<string, number[]>();
    for (let i = 0; i < attributes.length; i++) {
        const schemas = distinctObjectTypeAttributeKind.tryGetInAttributes(
            attributes[i],
        );
        if (schemas === undefined) return undefined;

        const key = keyForSchemas(schemas);
        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, [i]);
        } else {
            group.push(i);
        }
    }

    if (groups.size < 2) return undefined;
    return Array.from(groups.values());
}
