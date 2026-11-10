import { arrayIntercalate, setUnion, setUnionInto } from "collection-utils";

import {
    minMaxItemsForType,
    minMaxLengthForType,
    minMaxValueForType,
    patternForType,
} from "../../attributes/Constraints.js";
import { ConvenienceRenderer } from "../../ConvenienceRenderer.js";
import {
    DependencyName,
    type Name,
    type Namer,
    funPrefixNamer,
} from "../../Naming.js";
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
import { defined, panic } from "../../support/Support.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import type {
    ClassProperty,
    EnumType,
    ObjectType,
    Type,
} from "../../Type/index.js";
import {
    directlyReachableTypes,
    matchType,
    removeNullFromUnion,
} from "../../Type/TypeUtils.js";
import { legalizeName } from "../JavaScript/utils.js";

import type { typeScriptEffectSchemaOptions } from "./language.js";

function isClass(t: Type): t is ObjectType {
    return t.kind === "class" || t.kind === "object";
}

// The classes a class's properties refer to, through arrays, maps and unions.
function referencedClasses(t: Type): ReadonlySet<Type> {
    if (!isClass(t)) return new Set();
    return setUnion(
        ...Array.from(t.getProperties().values(), (p) =>
            directlyReachableTypes(p.type, (u) =>
                isClass(u) ? new Set([u]) : null,
            ),
        ),
    );
}

// S.Union lists classes last.
function unionMemberRank(t: Type): number {
    return isClass(t) ? 1 : 0;
}

export class TypeScriptEffectSchemaRenderer extends ConvenienceRenderer {
    private readonly emittedObjects = new Set<Name>();

    private _cyclicClasses: ReadonlySet<Type> | undefined;

    // The `<Class>Encoded` interfaces of the classes in cycles.
    private readonly encodedNames = new Map<Type, Name>();

    private readonly encodedNamer = this.makeNamedTypeNamer();

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<
            typeof typeScriptEffectSchemaOptions
        >,
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return [
            "S",
            "Class",
            "Date",
            "Object",
            "String",
            "Array",
            "JSON",
            "Error",
            "RegExp",
        ];
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

    // The classes that refer to themselves, directly or through other
    // classes.
    private get cyclicClasses(): ReadonlySet<Type> {
        if (this._cyclicClasses === undefined) {
            const cyclic = new Set<Type>();
            const components = this.typeGraph
                .makeGraph(false, referencedClasses)
                .stronglyConnectedComponents().nodes;
            for (const component of components) {
                const [first] = component;
                if (component.size > 1 || referencedClasses(first).has(first)) {
                    setUnionInto(cyclic, component);
                }
            }

            this._cyclicClasses = cyclic;
        }

        return this._cyclicClasses;
    }

    protected makeNamedTypeDependencyNames(
        t: Type,
        name: Name,
    ): DependencyName[] {
        if (!this.cyclicClasses.has(t)) return [];
        const encodedName = new DependencyName(
            this.encodedNamer,
            name.order,
            (lookup) => `${lookup(name)}_encoded`,
        );
        this.encodedNames.set(t, encodedName);
        return [encodedName];
    }

    private importStatement(
        lhs: Sourcelike,
        moduleName: Sourcelike,
    ): Sourcelike {
        return ["import ", lhs, " from ", moduleName, ";"];
    }

    protected emitImports(): void {
        this.ensureBlankLine();
        this.emitLine(this.importStatement("* as S", '"effect/Schema"'));
    }

    private typeMapTypeForProperty(p: ClassProperty): Sourcelike {
        if (!p.isOptional) {
            return this.typeMapTypeFor(p.type);
        }

        return ["S.optional(", this.typeMapTypeFor(p.type), ")"];
    }

    private typeMapTypeFor(
        t: Type,
        required = true,
        coerceStrings = false,
    ): Sourcelike {
        if (t.kind === "class" || t.kind === "object" || t.kind === "enum") {
            const name = this.nameForNamedType(t);
            if (this.emittedObjects.has(name)) {
                return [name];
            }

            // TypeScript infers the type of a forward reference, unless the
            // reference is recursive (TS2506).  Then it's annotated, with the
            // encoded side declared by the class's encoded interface.
            const encodedName = this.encodedNames.get(t);
            if (encodedName === undefined) {
                return ["S.suspend(() => ", name, ")"];
            }

            return [
                "S.suspend((): S.Schema<",
                name,
                ", ",
                encodedName,
                "> => ",
                name,
                ")",
            ];
        }

        const match = matchType<Sourcelike>(
            t,
            (_anyType) => "S.Any",
            (_nullType) => "S.Null",
            (_boolType) => "S.Boolean",
            (integerType) => this.numberSchema(integerType, "S.Int"),
            (doubleType) => this.numberSchema(doubleType, "S.Number"),
            (stringType) => this.stringSchema(stringType),
            (arrayType) => {
                const [minItems, maxItems] =
                    minMaxItemsForType(arrayType) ?? [];
                const schema: Sourcelike[] = [
                    "S.Array(",
                    this.typeMapTypeFor(arrayType.items, false),
                    ")",
                ];
                if (minItems !== undefined && minItems > 0) {
                    schema.push(".pipe(S.minItems(", minItems.toString(), "))");
                }
                if (maxItems !== undefined) {
                    schema.push(".pipe(S.maxItems(", maxItems.toString(), "))");
                }
                return schema;
            },
            (_classType) => panic("Should already be handled."),
            (_mapType) => [
                "S.Record({ key: S.String, value: ",
                this.typeMapTypeFor(_mapType.values, false),
                "})",
            ],
            (_enumType) => panic("Should already be handled."),
            (unionType) => {
                const types = Array.from(unionType.getChildren());
                const coerce = types.some(
                    (type) => type.kind === "bool" || type.kind === "integer",
                );
                types.sort((a, b) => unionMemberRank(a) - unionMemberRank(b));
                const children: Sourcelike[] = [];
                let nullable = false;
                for (const type of types) {
                    if (type.kind === "null") {
                        nullable = true;
                    } else {
                        children.push(this.typeMapTypeFor(type, false, coerce));
                    }
                }

                if (nullable && children.length === 1) {
                    return ["S.NullOr(", children[0], ")"];
                }

                return [
                    "S.Union(",
                    ...arrayIntercalate(", ", children),
                    nullable ? ", S.Null)" : ")",
                ];
            },
            (_transformedStringType) => {
                if (_transformedStringType.kind === "uuid") return "S.UUID";
                if (_transformedStringType.kind === "bool-string")
                    return coerceStrings
                        ? 'S.transform(S.Literal("true", "false"), S.Boolean, { strict: true, decode: (value) => value === "true", encode: (value) => value ? "true" : "false" })'
                        : 'S.Literal("true", "false")';
                if (_transformedStringType.kind === "date")
                    return "S.String.pipe(S.pattern(/^\\d{4}-\\d{2}-\\d{2}$/))";
                if (_transformedStringType.kind === "time")
                    return "S.String.pipe(S.pattern(/^\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$/))";
                if (_transformedStringType.kind === "date-time")
                    return "S.String.pipe(S.pattern(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$/))";
                if (_transformedStringType.kind === "integer-string")
                    return coerceStrings
                        ? "S.NumberFromString.pipe(S.int())"
                        : "S.String.pipe(S.pattern(/^-?\\d+$/))";
                return "S.String";
            },
        );

        if (required) {
            return [match];
        }

        return match;
    }

    // The encoded type of the schema typeMapTypeFor renders for `t`.
    private encodedTypeFor(t: Type): Sourcelike {
        if (t.kind === "class" || t.kind === "object" || t.kind === "enum") {
            const encodedName = this.encodedNames.get(t);
            if (encodedName !== undefined) {
                return encodedName;
            }

            return ["S.Schema.Encoded<typeof ", this.nameForNamedType(t), ">"];
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
                "ReadonlyArray<",
                this.encodedTypeFor(arrayType.items),
                ">",
            ],
            (_classType) => panic("Should already be handled."),
            (mapType) => [
                "{ readonly [key: string]: ",
                this.encodedTypeFor(mapType.values),
                " }",
            ],
            (_enumType) => panic("Should already be handled."),
            (unionType) => {
                const [nullType, members] = removeNullFromUnion(
                    unionType,
                    true,
                );
                const types = Array.from(members).sort(
                    (a, b) => unionMemberRank(a) - unionMemberRank(b),
                );
                const encoded = types.map((type) => this.encodedTypeFor(type));
                if (nullType !== null) {
                    encoded.push("null");
                }

                return arrayIntercalate(" | ", encoded);
            },
            // Both the plain and the coercing schemas encode strings.
            (transformedStringType) =>
                transformedStringType.kind === "bool-string"
                    ? '"true" | "false"'
                    : "string",
        );
    }

    // What the class's schema encodes to: `S.Schema.Encoded<typeof X>`, which
    // can't be used inside X's own definition.
    private emitEncodedInterface(encodedName: Name, t: ObjectType): void {
        this.emitLine("\nexport interface ", encodedName, " {");
        this.indent(() => {
            this.forEachClassProperty(t, "none", (_, jsonName, property) => {
                const optional = property.isOptional;
                this.emitLine(
                    `readonly "${utf16StringEscape(jsonName)}"`,
                    optional ? "?: " : ": ",
                    this.encodedTypeFor(property.type),
                    optional ? " | undefined" : "",
                    ";",
                );
            });
        });
        this.emitLine("}");
    }

    private stringSchema(t: Type): Sourcelike {
        const [min, max] = minMaxLengthForType(t) ?? [];
        const pattern = patternForType(t);
        const schema: Sourcelike[] = ["S.String"];
        if (min !== undefined)
            schema.push(
                `.pipe(S.filter(value => Array.from(value).length >= ${min}))`,
            );
        if (max !== undefined)
            schema.push(
                `.pipe(S.filter(value => Array.from(value).length <= ${max}))`,
            );
        if (pattern !== undefined)
            schema.push(
                `.pipe(S.pattern(new RegExp(${JSON.stringify(pattern)})))`,
            );
        return schema;
    }

    private numberSchema(t: Type, base: string): Sourcelike {
        const [min, max] = minMaxValueForType(t) ?? [];
        const schema: Sourcelike[] = [base];
        if (min !== undefined)
            schema.push(".pipe(S.greaterThanOrEqualTo(", min.toString(), "))");
        if (max !== undefined)
            schema.push(".pipe(S.lessThanOrEqualTo(", max.toString(), "))");
        return schema;
    }

    private emitObject(name: Name, t: ObjectType): void {
        this.ensureBlankLine();
        const encodedName = this.encodedNames.get(t);
        if (encodedName !== undefined) {
            this.emitEncodedInterface(encodedName, t);
        }

        this.emitLine(
            "\nexport class ",
            name,
            " extends S.Class<",
            name,
            '>("',
            name,
            t.getProperties().size === 0
                ? '")(S.Struct({}).pipe(S.filter(value => typeof value === "object" && value !== null && !Array.isArray(value)))'
                : '")({',
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
        this.emitLine(t.getProperties().size === 0 ? ") {}" : "}) {}");
        if (t.getProperties().has("toString")) {
            this.emitLine(
                "Object.defineProperty(",
                name,
                '.prototype, "toString", { writable: true });',
            );
        }
        this.emittedObjects.add(name);
    }

    private emitEnum(e: EnumType, enumName: Name): void {
        this.emittedObjects.add(enumName);
        this.ensureBlankLine();
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("\nexport const ", enumName, " = ", "S.Literal(");
        this.indent(() =>
            this.forEachEnumCase(e, "none", (_, jsonName) => {
                this.emitLine('"', stringEscape(jsonName), '",');
            }),
        );
        this.emitLine(");");
        if (!this._options.justSchema) {
            this.emitLine(
                "export type ",
                enumName,
                " = S.Schema.Type<typeof ",
                enumName,
                ">;",
            );
        }
    }

    // The classes that `types` are or refer to, through arrays, maps and
    // unions.
    private referencedObjects(types: Iterable<Type>): ObjectType[] {
        const objects: ObjectType[] = [];
        const visited = new Set<Type>();
        const recurse = (type: Type): void => {
            if (visited.has(type)) return;
            visited.add(type);
            if (type.kind === "object" || type.kind === "class") {
                objects.push(type as ObjectType);
                return;
            }

            for (const child of type.getNonAttributeChildren()) {
                recurse(child);
            }
        };

        for (const type of types) {
            recurse(type);
        }

        return objects;
    }

    protected emitSchemas(): void {
        this.ensureBlankLine();

        this.forEachEnum(
            "leading-and-interposing",
            (u: EnumType, enumName: Name) => {
                this.emitEnum(u, enumName);
            },
        );

        // Each class comes after the classes it refers to, so only the
        // references around a cycle are forward references, which need
        // `S.suspend`.
        const names = new Map<ObjectType, Name>();
        this.forEachObject("none", (type: ObjectType, name: Name) => {
            names.set(type, name);
        });
        const order: ObjectType[] = [];
        const visited = new Set<ObjectType>();
        const visit = (type: ObjectType): void => {
            if (visited.has(type) || !names.has(type)) return;
            visited.add(type);
            const propertyTypes: Type[] = [];
            this.forEachClassProperty(type, "none", (_, __, prop) => {
                propertyTypes.push(prop.type);
            });
            for (const referenced of this.referencedObjects(propertyTypes)) {
                visit(referenced);
            }

            order.push(type);
        };
        // Starting from the top-levels puts them after the classes they
        // refer to even in a cycle.
        for (const type of this.referencedObjects(this.topLevels.values())) {
            visit(type);
        }

        for (const type of names.keys()) {
            visit(type);
        }

        for (const type of order) {
            this.emitGatheredSource(
                this.gatherSource(() => {
                    this.emitObject(defined(names.get(type)), type);
                }),
            );
        }

        this.forEachTopLevel("none", (type, name) => {
            if (["class", "object", "enum"].includes(type.kind)) return;

            this.ensureBlankLine();
            const schema = this.typeMapTypeFor(type);
            this.emitLine(["export const ", name, " = ", schema, ";"]);
            if (!this._options.justSchema) {
                const typeOf = " = S.Schema.Type<typeof ";
                this.emitLine(["export type ", name, typeOf, name, ">;"]);
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
