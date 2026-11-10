import { arrayIntercalate } from "collection-utils";

import {
    minMaxItemsForType,
    minMaxLengthForType,
    minMaxValueForType,
    patternForType,
} from "../../attributes/Constraints.js";
import { ConvenienceRenderer } from "../../ConvenienceRenderer.js";
import { type Name, type Namer, funPrefixNamer } from "../../Naming.js";
import type { RenderContext } from "../../Renderer.js";
import type { OptionValues } from "../../RendererOptions/index.js";
import type { Sourcelike } from "../../Source.js";
import { AcronymStyleOptions, acronymStyle } from "../../support/Acronyms.js";
import {
    allLowerWordStyle,
    capitalize,
    combineWords,
    firstUpperWordStyle,
    isLetterOrUnderscore,
    splitIntoWords,
    stringEscape,
    utf16StringEscape,
} from "../../support/Strings.js";
import { panic } from "../../support/Support.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    ArrayType,
    type ClassProperty,
    ClassType,
    type EnumType,
    ObjectType,
    SetOperationType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import { matchType } from "../../Type/TypeUtils.js";
import { legalizeName } from "../JavaScript/utils.js";

import type { typeScriptZodOptions } from "./language.js";

export class TypeScriptZodRenderer extends ConvenienceRenderer {
    /** TypeRefs of object types and named tuples that participate in a
     * reference cycle.  These must be emitted as z.lazy() schemas with an
     * explicit type annotation, since zod cannot infer recursive types. */
    private _recursiveTypeRefs: Set<number> = new Set();

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        protected readonly _options: OptionValues<typeof typeScriptZodOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return ["Class", "Date", "Object", "String", "Array", "JSON", "Error"];
    }

    protected nameStyle(original: string, upper: boolean): string {
        const acronyms = acronymStyle(AcronymStyleOptions.Camel);
        const words = splitIntoWords(original);
        return combineWords(
            words,
            legalizeName,
            upper ? firstUpperWordStyle : allLowerWordStyle,
            firstUpperWordStyle,
            upper ? (s): string => capitalize(acronyms(s)) : allLowerWordStyle,
            acronyms,
            "",
            isLetterOrUnderscore,
        );
    }

    protected makeNamedTypeNamer(): Namer {
        return funPrefixNamer("types", (s) => this.nameStyle(s, true));
    }

    protected makeUnionMemberNamer(): Namer {
        return funPrefixNamer("properties", (s) => this.nameStyle(s, true));
    }

    protected namerForObjectProperty(): Namer {
        return funPrefixNamer("properties", (s) => this.nameStyle(s, true));
    }

    protected makeEnumCaseNamer(): Namer {
        return funPrefixNamer("enum-cases", (s) => this.nameStyle(s, false));
    }

    /** Tuples are spelled out, unless the schema names them or they contain
     * themselves other than through a named schema: such a tuple needs a
     * schema of its own to refer to. */
    protected tupleNeedsName(t: TupleType): boolean {
        return (
            this.hasGivenName(t) ||
            this.isInCycleThrough(
                t,
                (c) =>
                    !["class", "object", "enum"].includes(c.kind) &&
                    !(c instanceof TupleType && this.hasGivenName(c)),
            )
        );
    }

    private isNamedTuple(t: Type): t is TupleType {
        return t instanceof TupleType && this.tupleNeedsName(t);
    }

    protected importStatement(
        lhs: Sourcelike,
        moduleName: Sourcelike,
    ): Sourcelike {
        return ["import ", lhs, " from ", moduleName, ";"];
    }

    protected emitImports(): void {
        this.ensureBlankLine();
        this.emitLine(this.importStatement("* as z", '"zod"'));
    }

    protected typeMapTypeForProperty(p: ClassProperty): Sourcelike {
        const typeMap = this.typeMapTypeFor(p.type);
        return p.isOptional ? [typeMap, ".optional()"] : typeMap;
    }

    protected typeMapTypeFor(t: Type, required = true): Sourcelike {
        if (
            ["class", "object", "enum"].includes(t.kind) ||
            this.isNamedTuple(t)
        ) {
            return [this.nameForNamedType(t), "Schema"];
        }

        const stringType = (type: Type): Sourcelike => {
            const [min, max] = minMaxLengthForType(type) ?? [];
            const pattern = patternForType(type);
            return [
                "z.string()",
                pattern === undefined
                    ? ""
                    : [
                          '.regex(new RegExp("',
                          utf16StringEscape(pattern),
                          '"))',
                      ],
                min === undefined
                    ? ""
                    : `.refine(value => Array.from(value).length >= ${min})`,
                max === undefined
                    ? ""
                    : `.refine(value => Array.from(value).length <= ${max})`,
            ];
        };

        const numberType = (type: Type, integer: boolean): Sourcelike => {
            const [min, max] = minMaxValueForType(type) ?? [];
            return [
                "z.number()",
                integer ? ".int()" : "",
                min === undefined ? "" : [".min(", String(min), ")"],
                max === undefined ? "" : [".max(", String(max), ")"],
            ];
        };
        const match = matchType<Sourcelike>(
            t,
            (_anyType) => "z.any()",
            (_nullType) => "z.null()",
            (_boolType) => "z.boolean()",
            (integerType) => numberType(integerType, true),
            (doubleType) => numberType(doubleType, false),
            (string) => stringType(string),
            (arrayType) => {
                const [minItems, maxItems] =
                    minMaxItemsForType(arrayType) ?? [];

                const arraySource: Sourcelike[] = [
                    "z.array(",
                    this.typeMapTypeFor(arrayType.items, false),
                    ")",
                ];
                if (minItems !== undefined && minItems > 0) {
                    arraySource.push(".min(", minItems.toString(10), ")");
                }

                if (maxItems !== undefined) {
                    arraySource.push(".max(", maxItems.toString(10), ")");
                }

                return arraySource;
            },
            (_classType) => panic("Should already be handled."),
            (_mapType) => [
                "z.record(z.string(), ",
                this.typeMapTypeFor(_mapType.values, false),
                ")",
            ],
            (_enumType) => panic("Should already be handled."),
            (unionType) => {
                const children = Array.from(unionType.getChildren())
                    // Coercing schemas can accept null, so handle it first.
                    .sort((a, b) => {
                        const rank = (x: Type): number =>
                            x.kind === "null"
                                ? 0
                                : x.kind === "date-time"
                                  ? 2
                                  : 1;
                        return rank(a) - rank(b);
                    })
                    .map((type: Type) => {
                        const schema = this.typeMapTypeFor(type, false);
                        if (
                            type.kind === "bool-string" &&
                            unionType.findMember("bool") !== undefined
                        )
                            return [schema, '.transform(x => x === "true")'];
                        return type.kind === "integer-string" &&
                            unionType.findMember("integer") !== undefined
                            ? [schema, ".transform(Number)"]
                            : schema;
                    });
                return ["z.union([", ...arrayIntercalate(", ", children), "])"];
            },
            (_transformedStringType) => {
                if (_transformedStringType.kind === "date-time") {
                    return "z.string().pipe(z.coerce.date())";
                }
                if (_transformedStringType.kind === "uuid") {
                    return "z.string().uuid()";
                }
                if (_transformedStringType.kind === "bool-string") {
                    return 'z.enum(["true", "false"])';
                }
                if (_transformedStringType.kind === "integer-string") {
                    return "z.string().regex(/^-?\\d+$/)";
                }

                return "z.string()";
            },
            (tupleType) => this.tupleSchema(tupleType),
        );

        if (required) {
            return [match];
        }

        return match;
    }

    /** The tuples a tuple with optional items stands for, longest first:
     * one per number of items it can have, the longest with the rest.
     * zod 3's z.tuple() rejects arrays that lack an item, even an
     * optional one, so `[A, B?, ...R[]]` is `[A, B, ...R[]] | [A]`. */
    private tupleAlternatives(
        t: TupleType,
        sourceFor: (t: Type) => Sourcelike,
    ): Array<{ items: Sourcelike[]; rest: Sourcelike | undefined }> {
        const items = t.items.map(sourceFor);
        const rest = t.rest === undefined ? undefined : sourceFor(t.rest);
        const alternatives = [];
        for (let n = items.length; n >= t.minItems; n--) {
            alternatives.push({
                items: items.slice(0, n),
                rest: n === items.length ? rest : undefined,
            });
        }

        return alternatives;
    }

    private tupleSchema(t: TupleType): Sourcelike {
        const tuples = this.tupleAlternatives(t, (item) =>
            this.typeMapTypeFor(item, false),
        ).map(
            ({ items, rest }): Sourcelike => [
                "z.tuple([",
                ...arrayIntercalate(", ", items),
                "])",
                rest === undefined ? "" : [".rest(", rest, ")"],
            ],
        );
        if (tuples.length === 1) {
            return tuples[0];
        }

        return ["z.union([", ...arrayIntercalate(", ", tuples), "])"];
    }

    /** TypeScript type for `t`, used to annotate recursive schemas for
     * which zod cannot infer the type.
     *
     * This intentionally duplicates neither `typeMapTypeFor` above nor
     * `sourceFor` in the plain TypeScript renderer
     * (`TypeScriptFlowBaseRenderer`): it must mirror exactly what
     * `z.infer` would derive from the schemas emitted by
     * `typeMapTypeFor` (e.g. `z.coerce.date()` implies `Date`), while
     * `sourceFor` is shaped by ts/flow-specific options like
     * `preferConstValues` and `declareUnions` that don't exist here. */
    protected underlyingTypeFor(t: Type): Sourcelike {
        if (
            ["class", "object", "enum"].includes(t.kind) ||
            this.isNamedTuple(t)
        ) {
            return this.nameForNamedType(t);
        }

        return matchType<Sourcelike>(
            t,
            (_anyType) => "any",
            (_nullType) => "null",
            (_boolType) => "boolean",
            (_integerType) => "number",
            (_doubleType) => "number",
            (_stringType) => "string",
            (arrayType) => [
                "Array<",
                this.underlyingTypeFor(arrayType.items),
                ">",
            ],
            (_classType) => panic("Should already be handled."),
            (mapType) => [
                "Record<string, ",
                this.underlyingTypeFor(mapType.values),
                ">",
            ],
            (_enumType) => panic("Should already be handled."),
            (unionType) => {
                const children = Array.from(unionType.getChildren()).map(
                    (type: Type) => this.underlyingTypeFor(type),
                );
                return arrayIntercalate(" | ", children);
            },
            (_transformedStringType) => {
                if (_transformedStringType.kind === "date-time") {
                    return "Date";
                }

                return "string";
            },
            (tupleType) => this.underlyingTypeForTuple(tupleType),
        );
    }

    /** The rest is `...R[]`: TypeScript resolves `...Array<R>` eagerly,
     * which fails for a tuple that contains itself. */
    private underlyingTypeForTuple(t: TupleType): Sourcelike {
        // `[]` binds tighter than `|`.
        const restNeedsParens =
            t.rest instanceof UnionType ||
            (t.rest instanceof TupleType && !this.isNamedTuple(t.rest));
        const tuples = this.tupleAlternatives(t, (item) =>
            this.underlyingTypeFor(item),
        ).map(({ items, rest }): Sourcelike => {
            const elements = [...items];
            if (rest !== undefined) {
                elements.push(
                    restNeedsParens
                        ? ["...(", rest, ")[]"]
                        : ["...", rest, "[]"],
                );
            }

            return ["[", ...arrayIntercalate(", ", elements), "]"];
        });
        return arrayIntercalate(" | ", tuples);
    }

    protected isRecursive(t: Type): boolean {
        return this._recursiveTypeRefs.has(t.typeRef);
    }

    protected emitObject(name: Name, t: ObjectType): void {
        if (this.isRecursive(t)) {
            this.emitLazyObject(name, t);
            return;
        }

        this.ensureBlankLine();
        const hasOptionalConstructor =
            t.getProperties().get("constructor")?.isOptional === true;
        this.emitLine(
            "\nexport const ",
            name,
            "Schema = ",
            hasOptionalConstructor
                ? 'z.preprocess(value => typeof value === "object" && value !== null && !Array.isArray(value) ? Object.assign(Object.create(null), value) : value, z.object({'
                : "z.object({",
        );
        this.indent(() => {
            this.forEachClassProperty(t, "none", (_, jsonName, property) => {
                this.emitLine(
                    `"${utf16StringEscape(jsonName)}"`,
                    ": ",
                    this.typeMapTypeForProperty(property),
                    ",",
                );
            });
        });
        this.emitLine(hasOptionalConstructor ? "}));" : "});");
        if (!this._options.justSchema) {
            this.emitLine(
                "export type ",
                name,
                " = z.infer<typeof ",
                name,
                "Schema>;",
            );
        }
    }

    /** Emit a recursive object type. zod cannot infer recursive types, so
     * the type is declared explicitly and the schema is wrapped in
     * z.lazy() with a z.ZodType annotation. */
    protected emitLazyObject(name: Name, t: ObjectType): void {
        this.ensureBlankLine();
        if (this._options.justSchema) {
            this.emitLine(
                "\nexport const ",
                name,
                "Schema: z.ZodType<any> = z.lazy(() =>",
            );
        } else {
            this.emitLine("\nexport type ", name, " = {");
            this.indent(() => {
                this.forEachClassProperty(
                    t,
                    "none",
                    (_, jsonName, property) => {
                        this.emitLine(
                            `"${utf16StringEscape(jsonName)}"`,
                            property.isOptional ? "?" : "",
                            ": ",
                            this.underlyingTypeFor(property.type),
                            ";",
                        );
                    },
                );
            });
            this.emitLine("};");
            this.emitLine(
                "export const ",
                name,
                "Schema: z.ZodType<",
                name,
                "> = z.lazy(() =>",
            );
        }

        this.indent(() => {
            this.emitLine("z.object({");
            this.indent(() => {
                this.forEachClassProperty(
                    t,
                    "none",
                    (_, jsonName, property) => {
                        this.emitLine(
                            `"${utf16StringEscape(jsonName)}"`,
                            ": ",
                            this.typeMapTypeForProperty(property),
                            ",",
                        );
                    },
                );
            });
            this.emitLine("})");
        });
        this.emitLine(");");
    }

    /** Emit a tuple that has a name: one the schema names, or a recursive
     * one.  A recursive tuple is declared like a recursive object: its type
     * explicitly, its schema wrapped in z.lazy(). */
    protected emitTuple(name: Name, t: TupleType): void {
        this.ensureBlankLine();
        if (!this.isRecursive(t)) {
            this.emitLine(
                "\nexport const ",
                name,
                "Schema = ",
                this.tupleSchema(t),
                ";",
            );
            if (!this._options.justSchema) {
                this.emitLine(
                    "export type ",
                    name,
                    " = z.infer<typeof ",
                    name,
                    "Schema>;",
                );
            }

            return;
        }

        if (this._options.justSchema) {
            this.emitLine(
                "\nexport const ",
                name,
                "Schema: z.ZodType<any> = z.lazy(() => ",
                this.tupleSchema(t),
                ");",
            );
            return;
        }

        this.emitLine(
            "\nexport type ",
            name,
            " = ",
            this.underlyingTypeForTuple(t),
            ";",
        );
        this.emitLine(
            "export const ",
            name,
            "Schema: z.ZodType<",
            name,
            "> = z.lazy(() => ",
            this.tupleSchema(t),
            ");",
        );
    }

    protected emitEnum(e: EnumType, enumName: Name): void {
        this.ensureBlankLine();
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("\nexport const ", enumName, "Schema = ", "z.enum([");
        this.indent(() =>
            this.forEachEnumCase(e, "none", (_, jsonName) => {
                this.emitLine('"', stringEscape(jsonName), '",');
            }),
        );
        this.emitLine("]);");
        if (!this._options.justSchema) {
            this.emitLine(
                "export type ",
                enumName,
                " = z.infer<typeof ",
                enumName,
                "Schema>;",
            );
        }
    }

    /** Function that extracts underlying type refs for types that form part of the
     * definition of the passed type - used to ensure that these appear in generated source
     * before types that reference them.
     *
     * Primitive types don't need defining and enums are output before other types, hence,
     * these are ignored.
     */
    private extractUnderlyingTyperefs(type: Type): number[] {
        const typeRefs: number[] = [];
        // Ignore enums and primitives
        if (!type.isPrimitive() && type.kind !== "enum") {
            // need to extract constituent types for unions and intersections (which both extend SetOperationType)
            // and can ignore the union/intersection itself
            if (type instanceof SetOperationType) {
                (type as SetOperationType).members.forEach((member) => {
                    // recurse as the underlying type could itself be a union, instersection or array etc.
                    typeRefs.push(...this.extractUnderlyingTyperefs(member));
                });
            }

            // need to extract additional properties for object, class and map types (which all extend ObjectType)
            if (type instanceof ObjectType) {
                const addType = (type as ObjectType).getAdditionalProperties();
                if (addType) {
                    // recurse as the underlying type could itself be a union, instersection or array etc.
                    typeRefs.push(...this.extractUnderlyingTyperefs(addType));
                }
            }

            // need to extract items types for ArrayType
            if (type instanceof ArrayType) {
                const itemsType = (type as ArrayType).items;
                if (itemsType) {
                    // recurse as the underlying type could itself be a union, instersection or array etc.
                    typeRefs.push(...this.extractUnderlyingTyperefs(itemsType));
                }
            }

            // need to extract the items of tuples that are spelled out
            if (type instanceof TupleType && !this.tupleNeedsName(type)) {
                for (const child of type.getNonAttributeChildren()) {
                    typeRefs.push(...this.extractUnderlyingTyperefs(child));
                }
            }

            // Finally return the reference to a class or a named tuple as that will need to be defined (where objects, maps, unions, intersections, arrays and other tuples do not)
            if (type instanceof ClassType || this.isNamedTuple(type)) {
                typeRefs.push(type.typeRef);
            }
        }

        return typeRefs;
    }

    protected emitSchemas(): void {
        this.ensureBlankLine();

        this.forEachEnum(
            "leading-and-interposing",
            (u: EnumType, enumName: Name) => {
                this.emitEnum(u, enumName);
            },
        );

        // All children must be defined before this type to avoid forward references in generated code
        // Build a model that will tell us if a referenced type has been defined then make multiple
        // passes over the defined objects to put them into the correct order for output in the
        // generated sourcecode

        const order: number[] = [];
        const mapType: Array<ObjectType | TupleType> = [];
        const mapTypeRef: number[] = [];
        const mapName: Name[] = [];
        const mapChildTypeRefs: number[][] = [];

        const addType = (type: ObjectType | TupleType, name: Name): void => {
            mapType.push(type);
            mapTypeRef.push(type.typeRef);
            mapName.push(name);

            const children = type.getChildren();
            let childTypeRefs: number[] = [];

            children.forEach((child) => {
                childTypeRefs = childTypeRefs.concat(
                    this.extractUnderlyingTyperefs(child),
                );
            });
            mapChildTypeRefs.push(childTypeRefs);
        };

        this.forEachObject("none", addType);
        // Named tuples are ordered, and may be recursive, like objects.
        const ignore = (): void => undefined;
        this.forEachNamedType("none", ignore, ignore, ignore, addType);

        // Find types that participate in a reference cycle: types from
        // which we can get back to the same type by following child type
        // references. Those can never be topologically ordered.
        const indexForTypeRef = new Map<number, number>();
        mapTypeRef.forEach((typeRef, index) => {
            indexForTypeRef.set(typeRef, index);
        });
        this._recursiveTypeRefs = new Set();
        mapType.forEach((_, startIndex) => {
            const visited = new Set<number>();
            const stack = [...mapChildTypeRefs[startIndex]];
            while (stack.length > 0) {
                const childRef = stack.pop() as number;
                const childIndex = indexForTypeRef.get(childRef);
                if (childIndex === undefined) continue;
                if (childIndex === startIndex) {
                    this._recursiveTypeRefs.add(mapTypeRef[startIndex]);
                    break;
                }

                if (visited.has(childIndex)) continue;
                visited.add(childIndex);
                stack.push(...mapChildTypeRefs[childIndex]);
            }
        });

        // Items to process on this pass
        let indices: number[] = [];
        mapType.forEach((_, index) => {
            if (this._recursiveTypeRefs.has(mapTypeRef[index])) {
                // Recursive types are emitted first: they are wrapped in
                // z.lazy(), so all their references to other schemas are
                // deferred until parse time and don't constrain the
                // output order, while other schemas can reference them
                // directly.
                order.push(index);
            } else {
                indices.push(index);
            }
        });
        // items to process on the next pass
        let deferredIndices: number[] = [];

        // defensive: make sure we don't loop forever, even complex sets shouldn't require many passes
        const MAX_PASSES = 999;
        let passNum = 0;
        do {
            indices.forEach((index) => {
                // must be behind all these children
                const childTypeRefs = mapChildTypeRefs[index];
                let foundAllChildren = true;

                childTypeRefs.forEach((childRef) => {
                    // defensive: first check if there is a definition for the referenced type (there should be)
                    if (mapTypeRef.includes(childRef)) {
                        let found = false;
                        // find this childs's ordinal, if it has already been added
                        // faster to go through what we've defined so far than all definitions

                        for (const childIndex of order) {
                            if (mapTypeRef[childIndex] === childRef) {
                                found = true;
                                break;
                            }
                        }

                        foundAllChildren = foundAllChildren && found;
                    } else {
                        console.error(
                            "A child type reference was not found amongst all Object definitions! TypeRef: " +
                                childRef,
                        );
                    }
                });

                if (foundAllChildren) {
                    // insert index into order as we are safe to define this type
                    order.push(index);
                } else {
                    // defer to a subsequent pass as we need to define other types
                    deferredIndices.push(index);
                }
            });
            indices = deferredIndices;
            deferredIndices = [];
            passNum++;

            if (passNum > MAX_PASSES) {
                // giving up: emit the stuck items anyway rather than
                // silently dropping them
                order.push(...indices);
                console.warn(
                    "Exceeded maximum number of passes when determining output order, output may contain forward references",
                );
            }
        } while (indices.length > 0 && passNum <= MAX_PASSES);

        // now emit ordered source
        order.forEach((i) => {
            this.emitGatheredSource(
                this.gatherSource(() => {
                    const type = mapType[i];
                    if (type instanceof TupleType) {
                        this.emitTuple(mapName[i], type);
                    } else {
                        this.emitObject(mapName[i], type);
                    }
                }),
            );
        });

        this.forEachTopLevel("none", (type, name) => {
            // Named top levels were already emitted above with this name.
            if (
                ["class", "object", "enum"].includes(type.kind) ||
                this.isNamedTuple(type)
            )
                return;

            this.ensureBlankLine();
            this.emitLine(
                "export const ",
                name,
                "Schema = ",
                this.typeMapTypeFor(type),
                ";",
            );
            if (!this._options.justSchema) {
                this.emitLine(
                    "export type ",
                    name,
                    " = z.infer<typeof ",
                    name,
                    "Schema>;",
                );
            }
        });
    }

    protected emitSourceStructure(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        }

        this.emitImports();
        this.emitSchemas();
    }
}
