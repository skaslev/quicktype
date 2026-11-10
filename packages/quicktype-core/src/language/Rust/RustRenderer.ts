/* eslint-disable @typescript-eslint/naming-convention */
import { arrayIntercalate, iterableSome, mapFirst } from "collection-utils";

import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import { minMaxValueForType } from "../../attributes/Constraints.js";
import { isDistinctObject } from "../../attributes/DistinctObjects.js";
import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer.js";
import type { Name, Namer } from "../../Naming.js";
import type { RenderContext } from "../../Renderer.js";
import type { OptionValues } from "../../RendererOptions/index.js";
import { type Sourcelike, maybeAnnotated } from "../../Source.js";
import { defined } from "../../support/Support.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    ClassType,
    type EnumType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import {
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";

import { keywords, preludeTypeNames } from "./constants.js";
import { IntegerType, type rustOptions } from "./language.js";
import {
    Density,
    type NamingStyleKey,
    Visibility,
    camelNamingFunction,
    getPreferredNamingStyle,
    listMatchingNamingStyles,
    nameWithNamingStyle,
    namingStyles,
    rustStringEscape,
    snakeNamingFunction,
} from "./utils.js";

function elements(n: number): string {
    return n === 1 ? "1 element" : `${n} elements`;
}

// What a tuple with optional items or a rest expects, for error messages.
function expectedTupleLength(t: TupleType): string {
    const min = t.minItems;
    const max = t.items.length;
    if (t.rest !== undefined) {
        return min === 0 ? "an array" : `an array of at least ${elements(min)}`;
    }

    return min === 0
        ? `an array of at most ${elements(max)}`
        : `an array of ${min} to ${max} elements`;
}

export class RustRenderer extends ConvenienceRenderer {
    private _strictClasses: ReadonlySet<Type> | undefined;

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof rustOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

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
        return [...keywords, ...preludeTypeNames];
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
        return { names: [...keywords], includeGlobalForbidden: false };
    }

    protected forbiddenForEnumCases(
        _e: EnumType,
        _enumName: Name,
    ): ForbiddenWordsInfo {
        return { names: [...keywords], includeGlobalForbidden: false };
    }

    protected get commentLineStart(): string {
        return "/// ";
    }

    private getIntegerType(integerType: Type): string {
        switch (this._options.integerType) {
            case IntegerType.ForceI32:
                return "i32";
            case IntegerType.ForceI64:
                return "i64";
            default: {
                // Conservative: use i32 only when the schema bounds the
                // integer on *both* sides and both bounds fit in i32.  A
                // one-sided bound (e.g. only `"minimum": 0`) leaves the
                // other side unbounded, so it must stay i64.
                const minMax = minMaxValueForType(integerType);
                if (minMax === undefined) return "i64";
                const [min, max] = minMax;
                if (min === undefined || max === undefined) return "i64";
                const i32Min = -2147483648;
                const i32Max = 2147483647;
                return min >= i32Min && max <= i32Max ? "i32" : "i64";
            }
        }
    }

    private nullableRustType(t: Type, withIssues: boolean): Sourcelike {
        return ["Option<", this.breakCycle(t, withIssues), ">"];
    }

    protected isImplicitCycleBreaker(t: Type): boolean {
        const kind = t.kind;
        return kind === "array" || kind === "map";
    }

    private rustType(t: Type, withIssues = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            (_anyType) =>
                maybeAnnotated(
                    withIssues,
                    anyTypeIssueAnnotation,
                    "Option<serde_json::Value>",
                ),
            (_nullType) =>
                maybeAnnotated(
                    withIssues,
                    nullTypeIssueAnnotation,
                    "Option<serde_json::Value>",
                ),
            (_boolType) => "bool",
            (integerType) => this.getIntegerType(integerType),
            (_doubleType) => "f64",
            (_stringType) => "String",
            (arrayType) => [
                "Vec<",
                this.rustType(arrayType.items, withIssues),
                ">",
            ],
            (classType) => this.nameForNamedType(classType),
            (mapType) => [
                "HashMap<String, ",
                this.rustType(mapType.values, withIssues),
                ">",
            ],
            (enumType) => this.nameForNamedType(enumType),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);

                if (nullable !== null)
                    return this.nullableRustType(nullable, withIssues);

                const [hasNull] = removeNullFromUnion(unionType);

                const isCycleBreaker = this.isCycleBreakerType(unionType);

                const name = isCycleBreaker
                    ? ["Box<", this.nameForNamedType(unionType), ">"]
                    : this.nameForNamedType(unionType);

                return hasNull !== null
                    ? (["Option<", name, ">"] as Sourcelike)
                    : name;
            },
            undefined,
            (tupleType) => {
                if (this.tupleNeedsName(tupleType)) {
                    return this.nameForNamedType(tupleType);
                }

                // A tuple with one element needs a trailing comma.
                const items = tupleType.items.map((item) =>
                    this.breakCycle(item, withIssues),
                );
                const source: Sourcelike[] = ["("];
                items.forEach((item, i) => {
                    if (i > 0) source.push(", ");
                    source.push(item);
                });
                source.push(items.length === 1 ? ",)" : ")");
                return source;
            },
        );
    }

    // Tuples are spelled out as `(A, B)` unless they have optional items or
    // a rest, the schema names them, or they contain themselves.  Named
    // tuples become tuple structs, since a type alias can't refer to itself.
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

    // serde (de)serializes tuple structs as arrays of exactly their length,
    // so a tuple with optional items or a rest gets its own impls.  The
    // optional items are `Option` fields and the rest a final `Vec`:
    // `[A, B?, ...C[]]` is `(pub A, pub Option<B>, pub Vec<C>)`.
    protected emitTupleStruct(t: TupleType, tupleName: Name): void {
        const derives = [
            this._options.deriveDebug ? "Debug" : undefined,
            this._options.deriveClone ? "Clone" : undefined,
            this._options.derivePartialEq ? "PartialEq" : undefined,
            ...(t.isFixedLength ? ["Serialize", "Deserialize"] : []),
        ].filter((d) => d !== undefined);
        const fields = t.items.map((item, i): Sourcelike => {
            const rustType = this.breakCycle(item, true);
            return i < t.minItems ? rustType : ["Option<", rustType, ">"];
        });
        if (t.rest !== undefined) {
            fields.push(["Vec<", this.rustType(t.rest, true), ">"]);
        }

        this.emitDescription(this.descriptionForType(t));
        if (derives.length > 0) {
            this.emitLine("#[derive(", derives.join(", "), ")]");
        }

        this.emitLine(
            "pub struct ",
            tupleName,
            "(",
            arrayIntercalate<Sourcelike>(
                ", ",
                fields.map((field) => [this.visibility, field]),
            ),
            ");",
        );
        if (!t.isFixedLength) {
            this.ensureBlankLine();
            this.emitTupleSerialize(t, tupleName);
            this.ensureBlankLine();
            this.emitTupleDeserialize(t, tupleName);
        }
    }

    // The required items, the optional ones that are present, then the
    // rest.  An item can't follow a missing one in JSON, so such a value is
    // an error rather than written with the later items moved into the gap,
    // or with nulls in it (which the item type may not allow, and which
    // would come back as different values).
    private emitTupleSerialize(t: TupleType, tupleName: Name): void {
        const restIndex = t.items.length;
        const present = t.items
            .map((_, i) => i)
            .filter((i) => i >= t.minItems)
            .map((i) => `self.${i}.is_some()`);
        if (t.rest !== undefined) {
            present.push(`!self.${restIndex}.is_empty()`);
        }

        const body = (): void => {
            this.emitLine("use serde::ser::SerializeSeq;");
            this.ensureBlankLine();
            if (present.length > 1) {
                this.emitLine("let present = [", present.join(", "), "];");
                this.emitBlock(
                    "if present.windows(2).any(|pair| pair == [false, true])",
                    () =>
                        this.emitLine(
                            'return Err(serde::ser::Error::custom("',
                            tupleName,
                            ': an item follows a missing optional item"));',
                        ),
                );
                this.ensureBlankLine();
            }

            this.emitLine("let mut seq = serializer.serialize_seq(None)?;");
            t.items.forEach((_, i) => {
                if (i < t.minItems) {
                    this.emitLine(`seq.serialize_element(&self.${i})?;`);
                } else {
                    this.emitBlock(`if let Some(item) = &self.${i}`, () =>
                        this.emitLine("seq.serialize_element(item)?;"),
                    );
                }
            });
            if (t.rest !== undefined) {
                this.emitBlock(`for item in &self.${restIndex}`, () =>
                    this.emitLine("seq.serialize_element(item)?;"),
                );
            }

            this.emitLine("seq.end()");
        };

        this.emitBlock(["impl Serialize for ", tupleName], () =>
            this.emitBlock(
                "fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error>",
                body,
            ),
        );
    }

    // The required items must be there, the optional ones are read while
    // there are elements, and the rest takes the remaining ones.  Reading
    // past the end again yields `None`, which serde's derived
    // `#[serde(default)]` fields rely on, too.  Like serde's own tuple
    // impls, this leaves rejecting elements beyond the last item of a tuple
    // without a rest to the format.
    private emitTupleDeserialize(t: TupleType, tupleName: Name): void {
        const visitorName: Sourcelike = [tupleName, "Visitor"];
        const fields = t.items.map((_, i) => `item${i}`);
        if (t.rest !== undefined) fields.push("rest");

        const visitSeq = (): void => {
            t.items.forEach((_, i) => {
                if (i < t.minItems) {
                    this.emitLine(
                        `let Some(${fields[i]}) = seq.next_element()? else {`,
                    );
                    this.indent(() =>
                        this.emitLine(
                            `return Err(serde::de::Error::invalid_length(${i}, &self));`,
                        ),
                    );
                    this.emitLine("};");
                } else {
                    this.emitLine(`let ${fields[i]} = seq.next_element()?;`);
                }
            });
            if (t.rest !== undefined) {
                this.emitLine("let mut rest = Vec::new();");
                this.emitBlock(
                    "while let Some(item) = seq.next_element()?",
                    () => this.emitLine("rest.push(item);"),
                );
            }

            this.emitLine("Ok(", tupleName, "(", fields.join(", "), "))");
        };

        const visitor = (): void => {
            this.emitLine("type Value = ", tupleName, ";");
            this.ensureBlankLine();
            this.emitBlock(
                "fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result",
                () =>
                    this.emitLine(
                        'formatter.write_str("',
                        expectedTupleLength(t),
                        '")',
                    ),
            );
            this.ensureBlankLine();
            this.emitBlock(
                "fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error>",
                visitSeq,
            );
        };

        this.emitBlock(["impl<'de> Deserialize<'de> for ", tupleName], () =>
            this.emitBlock(
                "fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error>",
                () => {
                    this.emitLine("struct ", visitorName, ";");
                    this.ensureBlankLine();
                    this.emitBlock(
                        ["impl<'de> serde::de::Visitor<'de> for ", visitorName],
                        visitor,
                    );
                    this.ensureBlankLine();
                    this.emitLine(
                        "deserializer.deserialize_seq(",
                        visitorName,
                        ")",
                    );
                },
            ),
        );
    }

    private breakCycle(t: Type, withIssues: boolean): Sourcelike {
        const rustType = this.rustType(t, withIssues);
        const isCycleBreaker = this.isCycleBreakerType(t);

        if (isCycleBreaker && t instanceof UnionType) {
            const nullable = nullableFromUnion(t);
            if (nullable === null || this.isCycleBreakerType(nullable)) {
                return rustType;
            }
        }

        return isCycleBreaker ? ["Box<", rustType, ">"] : rustType;
    }

    private emitRenameAttribute(
        propName: Name,
        jsonName: string,
        defaultNamingStyle: NamingStyleKey,
        preferedNamingStyle: NamingStyleKey,
    ): void {
        const escapedName = rustStringEscape(jsonName);
        const name = namingStyles[defaultNamingStyle].fromParts(
            this.sourcelikeToString(propName).split(" "),
        );
        const styledName = nameWithNamingStyle(name, preferedNamingStyle);
        const namesDiffer = escapedName !== styledName;
        if (namesDiffer) {
            this.emitLine('#[serde(rename = "', escapedName, '")]');
        }
    }

    private emitSkipSerializeNone(t: Type): void {
        if (t instanceof UnionType) {
            const nullable = nullableFromUnion(t);
            if (nullable !== null)
                this.emitLine(
                    '#[serde(skip_serializing_if = "Option::is_none")]',
                );
        }
    }

    private get visibility(): string {
        if (this._options.visibility === Visibility.Crate) {
            return "pub(crate) ";
        }
        if (this._options.visibility === Visibility.Public) {
            return "pub ";
        }

        return "";
    }

    // Whether the struct of `c` rejects unknown fields: if `c` is one of
    // several classes of a union, or a class that one of them contains
    // whose schema doesn't allow additional properties either.  serde
    // tries the variants of an untagged enum in turn, and a struct ignores
    // unknown fields by default, so it would take the values of the other
    // structs, too, if it doesn't require any of their fields, or if the
    // structs it contains take the values of theirs.  A union only has
    // several classes if they don't allow additional properties, so their
    // structs reject unknown fields, and so do the structs they contain
    // that don't allow them, at any depth: every variant only takes values
    // of its own.  The classes they contain that allow additional
    // properties take any of them, as their schemas say.
    private rejectsUnknownFields(c: ClassType): boolean {
        if (this._strictClasses === undefined) {
            const strictClasses = new Set<Type>();
            for (const t of this.typeGraph.allTypesUnordered()) {
                if (!(t instanceof UnionType)) continue;
                const classes = Array.from(t.members).filter(
                    (m) => m instanceof ClassType,
                );
                if (classes.length < 2) continue;
                for (const m of classes) strictClasses.add(m);
            }

            const seen = new Set<Type>();
            const work = Array.from(strictClasses);
            for (let t = work.pop(); t !== undefined; t = work.pop()) {
                if (seen.has(t)) continue;
                seen.add(t);
                if (
                    t instanceof ClassType &&
                    isDistinctObject(t.getAttributes())
                ) {
                    strictClasses.add(t);
                }

                work.push(...t.getNonAttributeChildren());
            }

            this._strictClasses = strictClasses;
        }

        return this._strictClasses.has(c);
    }

    protected emitStructDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            "Serialize, Deserialize)]",
        );

        // List the possible naming styles for every class property
        const propertiesNamingStyles: { [key: string]: string[] } = {};
        this.forEachClassProperty(c, "none", (_name, jsonName, _prop) => {
            propertiesNamingStyles[jsonName] =
                listMatchingNamingStyles(jsonName);
        });

        // Set the default naming style on the struct
        const defaultStyle = "snake_case";
        const preferedNamingStyle = getPreferredNamingStyle(
            Object.values(propertiesNamingStyles).flat(),
            defaultStyle,
        );
        if (preferedNamingStyle !== defaultStyle) {
            this.emitLine(`#[serde(rename_all = "${preferedNamingStyle}")]`);
        }

        if (this.rejectsUnknownFields(c)) {
            this.emitLine("#[serde(deny_unknown_fields)]");
        }

        const blankLines =
            this._options.density === Density.Dense ? "none" : "interposing";
        const structBody = (): void =>
            this.forEachClassProperty(c, blankLines, (name, jsonName, prop) => {
                this.emitDescription(
                    this.descriptionForClassProperty(c, jsonName),
                );
                this.emitRenameAttribute(
                    name,
                    jsonName,
                    defaultStyle,
                    preferedNamingStyle,
                );
                if (this._options.skipSerializingNone) {
                    this.emitSkipSerializeNone(prop.type);
                }

                this.emitLine(
                    this.visibility,
                    name,
                    ": ",
                    this.breakCycle(prop.type, true),
                    ",",
                );
            });

        this.emitBlock(["pub struct ", className], structBody);
    }

    protected emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("}");
    }

    protected emitUnion(u: UnionType, unionName: Name): void {
        const isMaybeWithSingleType = nullableFromUnion(u);

        if (isMaybeWithSingleType !== null) {
            return;
        }

        this.emitDescription(this.descriptionForType(u));
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            "Serialize, Deserialize)]",
        );
        this.emitLine("#[serde(untagged)]");

        const [, nonNulls] = removeNullFromUnion(u);

        // serde takes the first variant of an untagged enum that
        // deserializes, and a struct also deserializes from an array of its
        // fields' values, so the array and tuple variants go before a struct
        // variant, which would take the arrays of as many elements of its
        // fields' types.
        const isSequence = (t: Type): boolean =>
            t.kind === "array" || t.kind === "tuple";
        const sortOrder = iterableSome(nonNulls, (t) => t.kind === "class")
            ? (n: Name, t: Type): string =>
                  `${isSequence(t) ? 0 : 1}${defined(this.names.get(n))}`
            : null;

        const blankLines =
            this._options.density === Density.Dense ? "none" : "interposing";
        this.emitBlock(["pub enum ", unionName], () =>
            this.forEachUnionMember(
                u,
                nonNulls,
                blankLines,
                sortOrder,
                (fieldName, t) => {
                    const rustType = this.breakCycle(t, true);
                    this.emitLine([fieldName, "(", rustType, "),"]);
                },
            ),
        );
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            "Serialize, Deserialize)]",
        );

        // List the possible naming styles for every enum case
        const enumCasesNamingStyles: { [key: string]: string[] } = {};
        this.forEachEnumCase(e, "none", (_name, jsonName) => {
            enumCasesNamingStyles[jsonName] =
                listMatchingNamingStyles(jsonName);
        });

        // Set the default naming style on the enum
        const defaultStyle = "PascalCase";
        const preferedNamingStyle = getPreferredNamingStyle(
            Object.values(enumCasesNamingStyles).flat(),
            defaultStyle,
        );
        if (preferedNamingStyle !== defaultStyle) {
            this.emitLine(`#[serde(rename_all = "${preferedNamingStyle}")]`);
        }

        const blankLines =
            this._options.density === Density.Dense ? "none" : "interposing";
        this.emitBlock(["pub enum ", enumName], () =>
            this.forEachEnumCase(e, blankLines, (name, jsonName) => {
                this.emitRenameAttribute(
                    name,
                    jsonName,
                    defaultStyle,
                    preferedNamingStyle,
                );
                this.emitLine([name, ","]);
            }),
        );
    }

    protected get unionDeclarationsOmitNull(): boolean {
        return true;
    }

    protected emitTopLevelAlias(t: Type, name: Name): void {
        this.emitLine("pub type ", name, " = ", this.rustType(t), ";");
    }

    protected emitLeadingComments(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
            return;
        }

        const topLevel = mapFirst(this.topLevels);
        if (topLevel === undefined) return;

        const topLevelName = topLevel.getCombinedName();
        this.emitMultiline(
            `// Example code that deserializes and serializes the model.
// extern crate serde;
// #[macro_use]
// extern crate serde_derive;
// extern crate serde_json;
//
// use generated_module::${topLevelName};
//
// fn main() {
//     let json = r#"{"answer": 42}"#;
//     let model: ${topLevelName} = serde_json::from_str(&json).unwrap();
// }`,
        );
    }

    protected emitSourceStructure(): void {
        if (this._options.leadingComments) {
            this.emitLeadingComments();
        }

        this.ensureBlankLine();
        // Only declared types derive Serialize/Deserialize; aliases don't.
        if (this.haveNamedTypes) {
            this.emitLine("use serde::{Serialize, Deserialize};");
        }

        if (this.haveMaps) {
            this.emitLine("use std::collections::HashMap;");
        }

        this.forEachTopLevel(
            "leading",
            (t, name) => this.emitTopLevelAlias(t, name),
            (t) => this.namedTypeToNameForTopLevel(t) === undefined,
        );

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, name: Name) => this.emitStructDefinition(c, name),
            (e, name) => this.emitEnumDefinition(e, name),
            (u, name) => this.emitUnion(u, name),
            (t, name) => this.emitTupleStruct(t, name),
        );
    }
}
