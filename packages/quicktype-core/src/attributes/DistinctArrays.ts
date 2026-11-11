import { setIntersect, setUnionInto } from "collection-utils";

import { followTargetType } from "../Transformers.js";
import {
    type TypeKind,
    isPrimitiveStringTypeKind,
    targetTypeKindForTransformedStringTypeKind,
} from "../Type/TransformedStringType.js";
import type { ArrayType, SetOperationType, Type } from "../Type/Type.js";

import { distinctObjectGroups } from "./DistinctObjects.js";
import { TypeAttributeKind, type TypeAttributes } from "./TypeAttributes.js";

// Distinct array types are the array types that unions can keep apart
// instead of unifying them into one, for targets that support unions with
// several arrays.  JSON Schema input makes every array type distinct; arrays
// from other inputs, such as JSON samples, aren't.  A union keeps two
// distinct arrays apart if a union of their item types would keep the
// members of each apart from those of the other: then a target that can
// tell those apart can tell the arrays apart by their elements.  See
// `distinctArrayGroups`.
class DistinctArrayTypeAttributeKind extends TypeAttributeKind<true> {
    public constructor() {
        super("distinctArray");
    }

    public appliesToTypeKind(kind: TypeKind): boolean {
        return kind === "array";
    }

    public combine(_: true[]): true {
        return true;
    }

    public makeInferred(_: true): undefined {
        return undefined;
    }

    public stringify(_: true): string {
        return "distinct";
    }
}

export const distinctArrayTypeAttributeKind: TypeAttributeKind<true> =
    new DistinctArrayTypeAttributeKind();

export const distinctArrayAttributes: TypeAttributes =
    distinctArrayTypeAttributeKind.makeAttributes(true);

export function isDistinctArray(attributes: TypeAttributes): boolean {
    return (
        distinctArrayTypeAttributeKind.tryGetInAttributes(attributes) !==
        undefined
    );
}

// The members of a union that share a key are unified into one.  This is
// coarser than what unions do: they keep the two number types apart for some
// targets, and the transformed string types.  An integer or a bool string is
// a string in JSON, but decodes into an integer or a bool, and a union with
// integers or bools makes it one member with them, so it has both keys.
function keysOfKind(kind: TypeKind): string[] {
    if (kind === "integer" || kind === "double") return ["number"];
    if (kind === "enum") return ["string"];
    if (isPrimitiveStringTypeKind(kind)) {
        const target = targetTypeKindForTransformedStringTypeKind(kind);
        if (target === undefined) return ["string"];
        return ["string", ...keysOfKind(target)];
    }

    if (kind === "class" || kind === "map" || kind === "object") {
        return ["object"];
    }

    return [kind];
}

// The non-union types making up `t`.  A transformed type, which
// MakeTransformations makes, is taken for the type it decodes into.
function unionMembers(t: Type, members: Set<Type>, seen: Set<Type>): Set<Type> {
    t = followTargetType(t);
    if (seen.has(t)) return members;
    seen.add(t);

    if (t.kind === "union") {
        for (const m of (t as SetOperationType).members) {
            unionMembers(m, members, seen);
        }
    } else {
        members.add(t);
    }

    return members;
}

// The keys of the members of `t`, which may be an intersection that hasn't
// been resolved yet, or `undefined` if it can be of any key.
function possibleKeys(
    t: Type,
    seen: Set<Type>,
): ReadonlySet<string> | undefined {
    if (t.kind === "any" || t.kind === "none" || seen.has(t)) {
        return undefined;
    }

    if (t.kind !== "union" && t.kind !== "intersection") {
        return new Set(keysOfKind(t.kind));
    }

    seen.add(t);
    let keys: Set<string> | undefined;
    for (const m of (t as SetOperationType).members) {
        const memberKeys = possibleKeys(m, seen);
        if (t.kind === "union") {
            if (memberKeys === undefined) return undefined;
            keys = setUnionInto(keys ?? new Set(), memberKeys);
        } else if (memberKeys !== undefined) {
            keys =
                keys === undefined
                    ? new Set(memberKeys)
                    : setIntersect(keys, memberKeys);
        }
    }

    seen.delete(t);
    return keys;
}

// Whether a union with values of `a` and of `b` would unify them into one
// member.  Values of `any` can't be told apart from any others, and neither
// can values of `none`, of which there aren't any: an array of `none` is
// the empty array, which an array of any other items is, too.
function membersConflict(a: Type, b: Type, seen: Set<string>): boolean {
    if (a.kind === "intersection" || b.kind === "intersection") {
        // An intersection that hasn't been resolved yet conflicts with
        // anything of a key it can resolve to.  Once resolved, it can only
        // be of fewer keys, but object and array types of its keys may
        // still conflict.
        const aKeys = possibleKeys(a, new Set());
        const bKeys = possibleKeys(b, new Set());
        if (aKeys === undefined || bKeys === undefined) return true;
        if (aKeys.size === 0 || bKeys.size === 0) return true;
        return setIntersect(aKeys, bKeys).size > 0;
    }

    if (a.kind === "any" || a.kind === "none") return true;
    if (b.kind === "any" || b.kind === "none") return true;

    // Objects and arrays have only their key.
    const bKeys = keysOfKind(b.kind);
    const key = keysOfKind(a.kind).find((k) => bKeys.includes(k));
    if (key === undefined) return false;
    switch (key) {
        case "object":
            return (
                distinctObjectGroups([a.getAttributes(), b.getAttributes()]) ===
                undefined
            );
        case "array":
            return arraysConflict(a as ArrayType, b as ArrayType, seen);
        default:
            return true;
    }
}

// Whether a union with two array types would unify them into one, if it
// can't tell all their values apart: if their item types can't be.
function arraysConflict(
    a: ArrayType,
    b: ArrayType,
    seen: Set<string>,
): boolean {
    if (
        !isDistinctArray(a.getAttributes()) ||
        !isDistinctArray(b.getAttributes())
    ) {
        return true;
    }

    return itemsConflict(a.items, b.items, seen);
}

function itemsConflict(a: Type, b: Type, seen: Set<string>): boolean {
    // Array types that contain themselves conflict only if something else
    // in them does.
    const pair = `${a.index},${b.index}`;
    if (seen.has(pair)) return false;
    seen.add(pair);

    const aMembers = Array.from(unionMembers(a, new Set(), new Set()));
    const bMembers = Array.from(unionMembers(b, new Set(), new Set()));
    return aMembers.some((x) =>
        bMembers.some((y) => membersConflict(x, y, seen)),
    );
}

/**
 * The array types of a union, with their attributes in the union, that the
 * union keeps apart, as groups of indexes, one for each array member of the
 * union.  Arrays whose items can't be told apart make one member.  Returns
 * `undefined` if the union unifies all of them into one, which it does if
 * any of them isn't a distinct array type.
 */
export function distinctArrayGroups(
    arrays: readonly ArrayType[],
    attributes: readonly TypeAttributes[],
): number[][] | undefined {
    if (arrays.length < 2 || !attributes.every(isDistinctArray)) {
        return undefined;
    }

    // Union-find over the arrays whose items conflict.
    const parents = arrays.map((_, i) => i);
    const find = (i: number): number => {
        while (parents[i] !== i) i = parents[i];
        return i;
    };
    for (let i = 0; i < arrays.length; i++) {
        for (let j = i + 1; j < arrays.length; j++) {
            if (find(i) === find(j)) continue;
            if (itemsConflict(arrays[i].items, arrays[j].items, new Set())) {
                parents[find(j)] = find(i);
            }
        }
    }

    const groups = new Map<number, number[]>();
    for (let i = 0; i < arrays.length; i++) {
        const root = find(i);
        const group = groups.get(root);
        if (group === undefined) {
            groups.set(root, [i]);
        } else {
            group.push(i);
        }
    }

    if (groups.size < 2) return undefined;
    return Array.from(groups.values());
}
