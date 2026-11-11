import { funPrefixNamer } from "../../Naming.js";
import {
    allUpperWordStyle,
    combineWords,
    firstUpperWordStyle,
    isLetterOrUnderscore,
    isLetterOrUnderscoreOrDigit,
    legalizeCharacters,
    splitIntoWords,
} from "../../support/Strings.js";
import type { ClassProperty, Type, TypeKind } from "../../Type/index.js";

export const namingFunction = funPrefixNamer("namer", goNameStyle);

const legalizeName = legalizeCharacters(isLetterOrUnderscoreOrDigit);

function goNameStyle(original: string): string {
    const words = splitIntoWords(original);
    return combineWords(
        words,
        legalizeName,
        firstUpperWordStyle,
        firstUpperWordStyle,
        allUpperWordStyle,
        allUpperWordStyle,
        "",
        isLetterOrUnderscore,
    );
}

export const primitiveValueTypeKinds: TypeKind[] = [
    "integer",
    "double",
    "bool",
    "string",
];
export const compoundTypeKinds: TypeKind[] = ["array", "class", "map", "enum"];

export function isValueType(t: Type): boolean {
    const kind = t.kind;
    return (
        primitiveValueTypeKinds.includes(kind) ||
        kind === "class" ||
        kind === "tuple" ||
        kind === "enum" ||
        kind === "date-time"
    );
}

// Go has a single nil for an optional property that is absent and one that
// is null, so nullable properties get no `omitempty`, which would drop their
// nulls; an absent one is written as null instead.  A union without null is
// a pointer to its struct (see `propertyGoType`), which is only nil if the
// property is absent.
function isNullableProperty(t: Type): boolean {
    if (t.kind === "union") return t.isNullable;
    return ["null", "any"].includes(t.kind);
}

export function canOmitEmpty(
    cp: ClassProperty,
    omitEmptyOption: boolean,
): boolean {
    if (!cp.isOptional) return false;
    if (omitEmptyOption) return !isNullableProperty(cp.type);
    const t = cp.type;
    return !isNullableProperty(t);
}
