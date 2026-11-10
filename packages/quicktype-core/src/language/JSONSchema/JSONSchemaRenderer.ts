import { iterableFirst, mapFirst } from "collection-utils";

import { minMaxItemsForType } from "../../attributes/Constraints.js";
import { addDescriptionToSchema } from "../../attributes/Description.js";
import { ConvenienceRenderer } from "../../ConvenienceRenderer.js";
import type { Name, Namer } from "../../Naming.js";
import { defined, panic } from "../../support/Support.js";
import {
    type EnumType,
    type ObjectType,
    TupleType,
    type Type,
    UnionType,
    transformedStringTypeTargetTypeKindsMap,
} from "../../Type/index.js";
import { matchTypeExhaustive } from "../../Type/TypeUtils.js";

import { namingFunction } from "./utils.js";

interface Schema {
    // biome-ignore lint/suspicious/noExplicitAny: JSON Schema values are arbitrary JSON
    [name: string]: any;
}

export class JSONSchemaRenderer extends ConvenienceRenderer {
    protected makeNamedTypeNamer(): Namer {
        return namingFunction;
    }

    protected namerForObjectProperty(): null {
        return null;
    }

    protected makeUnionMemberNamer(): null {
        return null;
    }

    protected makeEnumCaseNamer(): null {
        return null;
    }

    // Tuples are spelled out, unless the schema names them or they contain
    // themselves other than through a definition: those are definitions
    // too.
    protected tupleNeedsName(t: TupleType): boolean {
        return (
            this.hasGivenName(t) ||
            this.isInCycleThrough(
                t,
                (c) =>
                    !["class", "object", "enum"].includes(c.kind) &&
                    !(c instanceof UnionType && this.unionNeedsName(c)) &&
                    !(c instanceof TupleType && this.hasGivenName(c)),
            )
        );
    }

    private nameForType(t: Type): string {
        return defined(this.names.get(this.nameForNamedType(t)));
    }

    private makeOneOf(types: ReadonlySet<Type>): Schema {
        const first = iterableFirst(types);
        if (first === undefined) {
            return panic("Must have at least one type for oneOf");
        }

        if (types.size === 1) {
            return this.schemaForType(first);
        }

        return {
            anyOf: Array.from(types).map((t: Type) => this.schemaForType(t)),
        };
    }

    private makeRef(t: Type): Schema {
        return { $ref: `#/definitions/${this.nameForType(t)}` };
    }

    private addAttributesToSchema(t: Type, schema: Schema): void {
        const attributes = this.typeGraph.attributeStore.attributesForType(t);
        for (const [kind, attr] of attributes) {
            kind.addToSchema(schema, t, attr);
        }
    }

    private schemaForType(t: Type): Schema {
        const schema = matchTypeExhaustive<Schema>(
            t,
            (_noneType) => {
                return panic("none type should have been replaced");
            },
            (_anyType) => ({}),
            (_nullType) => ({ type: "null" }),
            (_boolType) => ({ type: "boolean" }),
            (_integerType) => ({ type: "integer" }),
            (_doubleType) => ({ type: "number" }),
            (_stringType) => ({ type: "string" }),
            (arrayType) => ({
                type: "array",
                items: this.schemaForType(arrayType.items),
            }),
            (classType) => this.makeRef(classType),
            (mapType) => this.definitionForObject(mapType, undefined),
            (objectType) => this.makeRef(objectType),
            (enumType) => this.makeRef(enumType),
            (unionType) => {
                if (this.unionNeedsName(unionType)) {
                    return this.makeRef(unionType);
                }

                return this.definitionForUnion(unionType);
            },
            (transformedStringType) => {
                const target = transformedStringTypeTargetTypeKindsMap.get(
                    transformedStringType.kind,
                );
                if (target === undefined) {
                    return panic(
                        `Unknown transformed string type ${transformedStringType.kind}`,
                    );
                }

                return { type: "string", format: target.jsonSchema };
            },
            (tupleType) => {
                if (this.tupleNeedsName(tupleType)) {
                    return this.makeRef(tupleType);
                }

                return this.definitionForTuple(tupleType);
            },
        );
        if (schema.$ref === undefined) {
            this.addAttributesToSchema(t, schema);
        }

        return schema;
    }

    private definitionForObject(
        o: ObjectType,
        title: string | undefined,
    ): Schema {
        let properties: Schema | undefined;
        let required: string[] | undefined;
        if (o.getProperties().size === 0) {
            properties = undefined;
            required = undefined;
        } else {
            const props: Schema = {};
            const req: string[] = [];
            for (const [name, p] of o.getProperties()) {
                const prop = this.schemaForType(p.type);
                if (prop.description === undefined) {
                    addDescriptionToSchema(
                        prop,
                        this.descriptionForClassProperty(o, name),
                    );
                }

                props[name] = prop;
                if (!p.isOptional) {
                    req.push(name);
                }
            }

            properties = props;
            // biome-ignore lint/suspicious/useArraySortCompare: sorting strings; default UTF-16 order is intended
            required = req.sort();
        }

        const additional = o.getAdditionalProperties();
        const additionalProperties =
            additional !== undefined ? this.schemaForType(additional) : false;
        const schema = {
            type: "object",
            additionalProperties,
            properties,
            required,
            title,
        };
        this.addAttributesToSchema(o, schema);
        return schema;
    }

    // Draft-06 tuples: `items` is the items, `additionalItems` the rest, or
    // `false` if there is none.  `minItems` is given even if it's 0, since
    // without it all items are taken to be present.  Constraints from the
    // input that the shape doesn't capture, like the most elements of a
    // tuple with a rest, are kept.
    private definitionForTuple(t: TupleType, title?: string): Schema {
        const [minItems, maxItems] = minMaxItemsForType(t) ?? [];
        const rest = t.rest;
        const schema = {
            type: "array",
            items: t.items.map((item) => this.schemaForType(item)),
            additionalItems:
                rest === undefined ? false : this.schemaForType(rest),
            minItems: Math.max(t.minItems, minItems ?? 0),
            maxItems: rest === undefined ? t.items.length : maxItems,
            title,
        };
        this.addAttributesToSchema(t, schema);
        return schema;
    }

    private definitionForUnion(u: UnionType, title?: string): Schema {
        const oneOf = this.makeOneOf(u.sortedMembers);
        if (title !== undefined) {
            oneOf.title = title;
        }

        this.addAttributesToSchema(u, oneOf);
        return oneOf;
    }

    private definitionForEnum(e: EnumType, title: string): Schema {
        const schema = { type: "string", enum: Array.from(e.cases), title };
        this.addAttributesToSchema(e, schema);
        return schema;
    }

    protected emitSourceStructure(): void {
        // FIXME: Find a good way to do multiple top-levels.  Maybe multiple files?
        const topLevelType =
            this.topLevels.size === 1
                ? this.schemaForType(defined(mapFirst(this.topLevels)))
                : {};
        const schema: Schema = {
            $schema: "http://json-schema.org/draft-06/schema#",
            ...topLevelType,
        };
        const definitions: { [name: string]: Schema } = {};
        this.forEachObject("none", (o: ObjectType, name: Name) => {
            const title = defined(this.names.get(name));
            definitions[title] = this.definitionForObject(o, title);
        });
        this.forEachUnion("none", (u, name) => {
            if (!this.unionNeedsName(u)) return;
            const title = defined(this.names.get(name));
            definitions[title] = this.definitionForUnion(u, title);
        });
        this.forEachEnum("none", (e, name) => {
            const title = defined(this.names.get(name));
            definitions[title] = this.definitionForEnum(e, title);
        });
        const ignore = (): void => undefined;
        this.forEachNamedType("none", ignore, ignore, ignore, (t, name) => {
            const title = defined(this.names.get(name));
            definitions[title] = this.definitionForTuple(t, title);
        });
        schema.definitions = definitions;

        this.emitMultiline(JSON.stringify(schema, undefined, "    "));
    }
}
