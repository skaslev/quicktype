import { iterableFirst } from "collection-utils";

import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation.js";
import {
    minMaxItemsForType,
    minMaxLengthForType,
    minMaxValueForType,
    patternForType,
} from "../../attributes/Constraints.js";
import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer.js";
import { DependencyName, type Name, type Namer } from "../../Naming.js";
import type { RenderContext } from "../../Renderer.js";
import type { OptionValues } from "../../RendererOptions/index.js";
import { type Sourcelike, maybeAnnotated, modifySource } from "../../Source.js";
import { decapitalize, snakeCase } from "../../support/Strings.js";
import { assert, defined } from "../../support/Support.js";
import type { TargetLanguage } from "../../TargetLanguage.js";
import {
    type ClassProperty,
    type ClassType,
    EnumType,
    TupleType,
    type Type,
    UnionType,
} from "../../Type/index.js";
import {
    directlyReachableTypes,
    isNamedType,
    matchType,
    nullableFromUnion,
} from "../../Type/TypeUtils.js";

import { keywords } from "./constants.js";
import type { dartOptions } from "./language.js";
import {
    enumCaseNamingFunction,
    propertyNamingFunction,
    stringEscape,
    typeNamingFunction,
} from "./utils.js";

interface TopLevelDependents {
    decoder: Name;
    encoder: Name;
}

export class DartRenderer extends ConvenienceRenderer {
    private readonly _gettersAndSettersForPropertyName = new Map<
        Name,
        [Name, Name]
    >();

    private _needEnumValues = false;

    private _needPresent = false;

    private classCounter = 0;

    private classPropertyCounter = 0;

    private readonly _topLevelDependents = new Map<Name, TopLevelDependents>();

    private readonly _enumValues = new Map<EnumType, Name>();

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof dartOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        // `Present` holds optional tuple items that can be null.
        const needsPresent = Array.from(
            this.typeGraph.allTypesUnordered(),
        ).some((t) => t instanceof TupleType && this.tupleNeedsPresent(t));
        return needsPresent ? [...keywords, "Present"] : keywords;
    }

    protected forbiddenForObjectProperties(
        _c: ClassType,
        _className: Name,
    ): ForbiddenWordsInfo {
        return {
            names: [
                "hashCode",
                "runtimeType",
                "toString",
                "noSuchMethod",
                ...(this._options.generateCopyWith ? ["copyWith"] : []),
            ],
            includeGlobalForbidden: true,
        };
    }

    protected makeNamedTypeNamer(): Namer {
        return typeNamingFunction;
    }

    protected namerForObjectProperty(): Namer {
        return propertyNamingFunction;
    }

    protected makeUnionMemberNamer(): Namer {
        return propertyNamingFunction;
    }

    protected makeEnumCaseNamer(): Namer {
        return enumCaseNamingFunction;
    }

    protected unionNeedsName(u: UnionType): boolean {
        return nullableFromUnion(u) === null;
    }

    // Every tuple is a class with a field per item.  Dart 3's records would
    // need a newer SDK than the Dart 2 this output supports, and couldn't
    // read themselves from JSON anyway.
    protected tupleNeedsName(_t: TupleType): boolean {
        return true;
    }

    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        if (this._options.justTypes) {
            // Only classes, enums and tuples are declared under the
            // top-level name; everything else (including unions, which Dart
            // doesn't render) gets a typedef, so e.g. a nullable class
            // top-level becomes `typedef TopLevel = Class?;` rather than
            // naming the class.
            return (isNamedType(type) && !(type instanceof UnionType)) ||
                type instanceof TupleType
                ? type
                : undefined;
        }

        // If the top-level type doesn't contain any classes or unions
        // we have to define a class just for the `FromJson` method, in
        // emitFromJsonForTopLevel.  Tuples are classes, too: the named
        // types in their items aren't reachable directly.
        const definedTypes = directlyReachableTypes(type, (t) => {
            const isDefined =
                t instanceof UnionType
                    ? nullableFromUnion(t) === null
                    : t instanceof TupleType || isNamedType(t);
            return isDefined ? new Set([t]) : null;
        });
        assert(
            definedTypes.size <= 1,
            "Cannot have more than one defined type per top-level",
        );
        return iterableFirst(definedTypes);
    }

    protected get toJson(): string {
        return `to${this._options.methodNamesWithMap ? "Map" : "Json"}`;
    }

    protected get fromJson(): string {
        return `from${this._options.methodNamesWithMap ? "Map" : "Json"}`;
    }

    protected makeTopLevelDependencyNames(
        _t: Type,
        name: Name,
    ): DependencyName[] {
        const encoder = new DependencyName(
            propertyNamingFunction,
            name.order,
            (lookup) => `${lookup(name)}_toJson`,
        );
        const decoder = new DependencyName(
            propertyNamingFunction,
            name.order,
            (lookup) => `${lookup(name)}_fromJson`,
        );
        this._topLevelDependents.set(name, { encoder, decoder });
        return [encoder, decoder];
    }

    protected makeNamesForPropertyGetterAndSetter(
        _c: ClassType,
        _className: Name,
        _p: ClassProperty,
        _jsonName: string,
        name: Name,
    ): [Name, Name] {
        const getterName = new DependencyName(
            propertyNamingFunction,
            name.order,
            (lookup) => `get_${lookup(name)}`,
        );
        const setterName = new DependencyName(
            propertyNamingFunction,
            name.order,
            (lookup) => `set_${lookup(name)}`,
        );
        return [getterName, setterName];
    }

    protected makePropertyDependencyNames(
        c: ClassType,
        className: Name,
        p: ClassProperty,
        jsonName: string,
        name: Name,
    ): Name[] {
        const getterAndSetterNames = this.makeNamesForPropertyGetterAndSetter(
            c,
            className,
            p,
            jsonName,
            name,
        );
        this._gettersAndSettersForPropertyName.set(name, getterAndSetterNames);
        return getterAndSetterNames;
    }

    protected makeNamedTypeDependencyNames(
        t: Type,
        name: Name,
    ): DependencyName[] {
        if (!(t instanceof EnumType)) return [];
        const enumValue = new DependencyName(
            propertyNamingFunction,
            name.order,
            (lookup) => `${lookup(name)}_values`,
        );
        this._enumValues.set(t, enumValue);
        return [enumValue];
    }

    protected emitFileHeader(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
        }

        if (this._options.justTypes) return;

        if (!this._options.codersInClass) {
            this.emitLine("// To parse this JSON data, do");
            this.emitLine("//");
            this.forEachTopLevel("none", (_t, name) => {
                const { decoder } = defined(this._topLevelDependents.get(name));
                this.emitLine(
                    "//     final ",
                    modifySource(decapitalize, name),
                    " = ",
                    decoder,
                    "(jsonString);",
                );
            });
        }

        this.ensureBlankLine();

        if (this._options.useFreezed) {
            this.emitLine(
                "import 'package:freezed_annotation/freezed_annotation.dart';",
            );
        }

        if (this._options.useHive) {
            this.emitLine("import 'package:hive/hive.dart';");
        }

        if (this._options.useJsonAnnotation && !this._options.useFreezed) {
            // The freezed annotatation import already provides the import for json_annotation
            this.emitLine(
                "import 'package:json_annotation/json_annotation.dart';",
            );
        }

        this.emitLine("import 'dart:convert';");
        // build_runner only writes the parts it generates code for: freezed
        // the freezed classes, json_serializable (`.g.dart`) the coders of
        // the classes, freezed's too, and hive_generator (`.g.dart` as well)
        // the adapters of the classes and enums.  A part without its file
        // doesn't compile.
        const haveClasses =
            this.typeGraph.allNamedTypesSeparated().objects.size > 0;
        const freezedPart = this._options.useFreezed && haveClasses;
        const generatedPart =
            ((this._options.useFreezed || this._options.useJsonAnnotation) &&
                haveClasses) ||
            (this._options.useHive && (haveClasses || this.haveEnums));
        if (freezedPart || generatedPart) {
            this.ensureBlankLine();
            const optionNameIsEmpty = this._options.partName.length === 0;
            // FIXME: This should use a `Name`, not `modifySource`
            const name = modifySource(
                snakeCase,
                optionNameIsEmpty
                    ? [...this.topLevels.keys()][0]
                    : this._options.partName,
            );
            if (freezedPart) {
                this.emitLine("part '", name, ".freezed.dart';");
            }

            if (generatedPart && !this._options.justTypes) {
                this.emitLine("part '", name, ".g.dart';");
            }
        }
    }

    protected emitDescriptionBlock(lines: Sourcelike[]): void {
        this.emitCommentLines(lines, { lineStart: "///", beforeComment: "" });
    }

    protected emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("}");
    }

    protected dartType(
        t: Type,
        withIssues = false,
        forceNullable = false,
    ): Sourcelike {
        const nullable =
            forceNullable ||
            (t.isNullable && !this._options.requiredProperties);
        const withNullable = (s: Sourcelike): Sourcelike =>
            nullable ? [s, "?"] : s;
        return matchType<Sourcelike>(
            t,
            (_anyType) =>
                maybeAnnotated(withIssues, anyTypeIssueAnnotation, "dynamic"),
            (_nullType) =>
                maybeAnnotated(withIssues, nullTypeIssueAnnotation, "dynamic"),
            (_boolType) => withNullable("bool"),
            (_integerType) => withNullable("int"),
            (_doubleType) => withNullable("double"),
            (_stringType) => withNullable("String"),
            (arrayType) =>
                withNullable([
                    "List<",
                    this.dartType(arrayType.items, withIssues),
                    ">",
                ]),
            (classType) => withNullable(this.nameForNamedType(classType)),
            (mapType) =>
                withNullable([
                    "Map<String, ",
                    this.dartType(mapType.values, withIssues),
                    ">",
                ]),
            (enumType) => withNullable(this.nameForNamedType(enumType)),
            (unionType) => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return "dynamic";
                }

                return withNullable(this.dartType(maybeNullable, withIssues));
            },
            (transformedStringType) => {
                switch (transformedStringType.kind) {
                    case "date-time":
                    case "date":
                        return withNullable("DateTime");
                    default:
                        return withNullable("String");
                }
            },
            (tupleType) => withNullable(this.nameForNamedType(tupleType)),
        );
    }

    // biome-ignore format: keep the constraint wrapper compact
    protected mapList(
        isNullable: boolean,
        itemType: Sourcelike,
        list: Sourcelike,
        mapper: Sourcelike,
        constrained?: Type,
    ): Sourcelike {
        const [min, max] = constrained === undefined ? [undefined, undefined] : (minMaxItemsForType(constrained) ?? []);
        // The list is the closure's argument, not a local of its body: the
        // list expression can refer to an `x` of the enclosing scope, the
        // item of an outer list (arrays of constrained arrays).
        const checked = (value: Sourcelike): Sourcelike =>
            min === undefined && max === undefined ? value : [
                "((List<", itemType, "> x) { if (",
                [min !== undefined && `x.length < ${min}`, max !== undefined && `x.length > ${max}`].filter(Boolean).join(" || "),
                ") throw FormatException('Invalid array length'); return x; })(", value, ")",
            ];
        if (isNullable && !this._options.requiredProperties) {
            return [
                list,
                " == null ? null : ",
                checked(["List<", itemType, ">.from(", list, "!.map((x) => ", mapper, "))"]),
            ];
        }

        return checked(["List<", itemType, ">.from(", list, ".map((x) => ", mapper, "))"]);
    }

    protected mapMap(
        isNullable: boolean,
        valueType: Sourcelike,
        map: Sourcelike,
        valueMapper: Sourcelike,
    ): Sourcelike {
        if (isNullable && !this._options.requiredProperties) {
            return [
                map,
                " == null ? null : ",
                "Map.from(",
                map,
                "!).map((k, v) => MapEntry<String, ",
                valueType,
                ">(k, ",
                valueMapper,
                "))",
            ];
        }

        return [
            "Map.from(",
            map,
            ").map((k, v) => MapEntry<String, ",
            valueType,
            ">(k, ",
            valueMapper,
            "))",
        ];
    }

    protected mapClass(
        isNullable: boolean,
        classType: ClassType | TupleType,
        dynamic: Sourcelike,
    ): Sourcelike {
        if (isNullable && !this._options.requiredProperties) {
            return [
                dynamic,
                " == null ? null : ",
                this.nameForNamedType(classType),
                ".",
                this.fromJson,
                "(",
                dynamic,
                ")",
            ];
        }

        return [
            this.nameForNamedType(classType),
            ".",
            this.fromJson,
            "(",
            dynamic,
            ")",
        ];
    }

    // FIXME: refactor this
    // If the first time is the unionType type, after nullableFromUnion conversion,
    // the isNullable property will become false, which is obviously wrong,
    // so add isNullable property
    protected fromDynamicExpression(
        // biome-ignore lint/style/useDefaultParameterLast: part of the exported DartRenderer API; removing the default would break downstream subclasses
        isNullable = false,
        t: Type,
        ...dynamic: Sourcelike[]
    ): Sourcelike {
        const validateString = (type: Type, value: Sourcelike): Sourcelike => {
            const [min, max] = minMaxLengthForType(type) ?? [];
            if (min === undefined && max === undefined) return value;
            return [
                isNullable ? [value, " == null ? null : "] : [],
                "((x) => ",
                min === undefined ? "true" : `x.runes.length >= ${min}`,
                " && ",
                max === undefined ? "true" : `x.runes.length <= ${max}`,
                ' ? x : throw FormatException("Expected bounded string"))(',
                value,
                ")",
            ];
        };
        const validatePattern = (type: Type, value: Sourcelike): Sourcelike => {
            const pattern = patternForType(type);
            if (pattern === undefined) return value;
            const checked: Sourcelike = [
                '((x) => RegExp("',
                stringEscape(pattern),
                '").hasMatch(x) ? x : throw FormatException("Expected matching string"))(',
                value,
                ")",
            ];
            return isNullable
                ? [value, " == null ? null : ", checked]
                : checked;
        };
        const validateNumber = (type: Type, value: Sourcelike): Sourcelike => {
            const [min, max] = minMaxValueForType(type) ?? [];
            if (min === undefined && max === undefined) return value;
            return [
                isNullable ? [value, " == null ? null : "] : [],
                "((x) => ",
                min === undefined ? "true" : `x >= ${min}`,
                " && ",
                max === undefined ? "true" : `x <= ${max}`,
                ' ? x : throw FormatException("Expected bounded number"))(',
                value,
                ")",
            ];
        };
        return matchType<Sourcelike>(
            t,
            (_anyType) => dynamic,
            (_nullType) => dynamic, // FIXME: check null
            (_boolType) => dynamic,
            (integerType) => validateNumber(integerType, dynamic),
            (doubleType) =>
                validateNumber(doubleType, [dynamic, "?.toDouble()"]),
            (stringType) =>
                validatePattern(
                    stringType,
                    validateString(stringType, dynamic),
                ),
            (arrayType) =>
                this.mapList(
                    isNullable || arrayType.isNullable,
                    this.dartType(arrayType.items),
                    dynamic,
                    this.fromDynamicExpression(
                        arrayType.items.isNullable,
                        arrayType.items,
                        "x",
                    ),
                    arrayType,
                ),
            (classType) =>
                this.mapClass(
                    isNullable || classType.isNullable,
                    classType,
                    dynamic,
                ),
            (mapType) =>
                this.mapMap(
                    mapType.isNullable || isNullable,
                    this.dartType(mapType.values),
                    dynamic,
                    this.fromDynamicExpression(
                        mapType.values.isNullable,
                        mapType.values,
                        "v",
                    ),
                ),
            (enumType) => {
                const value: Sourcelike = [
                    defined(this._enumValues.get(enumType)),
                    ".map[",
                    dynamic,
                    "]!",
                ];
                return isNullable && !this._options.requiredProperties
                    ? [dynamic, " == null ? null : ", value]
                    : value;
            },
            (unionType) => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return dynamic;
                }

                return this.fromDynamicExpression(
                    unionType.isNullable,
                    maybeNullable,
                    dynamic,
                );
            },
            (transformedStringType) => {
                switch (transformedStringType.kind) {
                    case "uuid":
                        return [
                            isNullable ? [dynamic, " == null ? null : "] : [],
                            "((String x) => RegExp(r'^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$').hasMatch(x)",
                            " ? x : throw FormatException('Invalid UUID'))(",
                            dynamic,
                            ")",
                        ];
                    case "date-time":
                    case "date":
                        if (
                            (transformedStringType.isNullable || isNullable) &&
                            !this._options.requiredProperties
                        ) {
                            return [
                                dynamic,
                                " == null ? null : ",
                                "DateTime.parse(",
                                dynamic,
                                ")",
                            ];
                        }

                        return ["DateTime.parse(", dynamic, ")"];
                    default:
                        return dynamic;
                }
            },
            (tupleType) => this.mapClass(isNullable, tupleType, dynamic),
        );
    }

    // FIXME: refactor this
    // If the first time is the unionType type, after nullableFromUnion conversion,
    // the isNullable property will become false, which is obviously wrong,
    // so add isNullable property
    protected toDynamicExpression(
        // biome-ignore lint/style/useDefaultParameterLast: part of the exported DartRenderer API; removing the default would break downstream subclasses
        isNullable = false,
        t: Type,
        ...dynamic: Sourcelike[]
    ): Sourcelike {
        return matchType<Sourcelike>(
            t,
            (_anyType) => dynamic,
            (_nullType) => dynamic,
            (_boolType) => dynamic,
            (_integerType) => dynamic,
            (_doubleType) => dynamic,
            (_stringType) => dynamic,
            (arrayType) =>
                this.mapList(
                    arrayType.isNullable || isNullable,
                    "dynamic",
                    dynamic,
                    this.toDynamicExpression(
                        arrayType.items.isNullable,
                        arrayType.items,
                        "x",
                    ),
                ),
            (classType) => this.toJsonOfClass(isNullable, classType, dynamic),
            (mapType) =>
                this.mapMap(
                    mapType.isNullable || isNullable,
                    "dynamic",
                    dynamic,
                    this.toDynamicExpression(
                        mapType.values.isNullable,
                        mapType.values,
                        "v",
                    ),
                ),
            (enumType) => {
                return [
                    defined(this._enumValues.get(enumType)),
                    ".reverse[",
                    dynamic,
                    "]",
                ];
            },
            (unionType) => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return dynamic;
                }

                return this.toDynamicExpression(
                    unionType.isNullable,
                    maybeNullable,
                    dynamic,
                );
            },
            (transformedStringType) => {
                switch (transformedStringType.kind) {
                    case "date-time":
                        if (
                            !this._options.requiredProperties &&
                            (transformedStringType.isNullable || isNullable)
                        ) {
                            return [dynamic, "?.toIso8601String()"];
                        }

                        return [dynamic, ".toIso8601String()"];
                    case "date":
                        if (
                            !this._options.requiredProperties &&
                            (transformedStringType.isNullable || isNullable)
                        ) {
                            return [
                                dynamic,
                                ' == null ? null : "${',
                                dynamic,
                                "!.year.toString().padLeft(4, '0')",
                                "}-${",
                                dynamic,
                                "!.month.toString().padLeft(2, '0')}-${",
                                dynamic,
                                "!.day.toString().padLeft(2, '0')}\"",
                            ];
                        }

                        return [
                            '"${',
                            dynamic,
                            ".year.toString().padLeft(4, '0')",
                            "}-${",
                            dynamic,
                            ".month.toString().padLeft(2, '0')}-${",
                            dynamic,
                            ".day.toString().padLeft(2, '0')}\"",
                        ];
                    default:
                        return dynamic;
                }
            },
            (tupleType) => this.toJsonOfClass(isNullable, tupleType, dynamic),
        );
    }

    private toJsonOfClass(
        isNullable: boolean,
        t: ClassType | TupleType,
        dynamic: Sourcelike,
    ): Sourcelike {
        if ((t.isNullable || isNullable) && !this._options.requiredProperties) {
            return [dynamic, "?.", this.toJson, "()"];
        }

        return [dynamic, ".", this.toJson, "()"];
    }

    private _emitEmptyConstructor(className: Name): void {
        this.emitLine(className, "();");
    }

    private _emitConstructor(c: ClassType, className: Name): void {
        this.emitLine(className, "({");
        this.indent(() => {
            this.forEachClassProperty(c, "none", (name, _, prop) => {
                const required =
                    this._options.requiredProperties ||
                    !prop.type.isNullable ||
                    !prop.isOptional;
                this.emitLine(required ? "required " : "", "this.", name, ",");
            });
        });
        this.emitLine("});");
        this.ensureBlankLine();
    }

    private _emitVariables(c: ClassType): void {
        this.forEachClassProperty(c, "none", (name, jsonName, p) => {
            const description = this.descriptionForClassProperty(c, jsonName);
            if (description !== undefined) {
                this.emitDescription(description);
            }

            if (this._options.useHive) {
                this.classPropertyCounter++;
                this.emitLine(`@HiveField(${this.classPropertyCounter})`);
            }

            if (this._options.useJsonAnnotation) {
                this.classPropertyCounter++;
                this.emitLine(`@JsonKey(name: "${stringEscape(jsonName)}")`);
            }

            this.emitLine(
                this._options.finalProperties ? "final " : "",
                this.dartType(p.type, true),
                " ",
                name,
                ";",
            );
        });
    }

    private _emitCopyConstructor(c: ClassType, className: Name): void {
        this.ensureBlankLine();
        this.emitLine(className, " copyWith({");
        this.indent(() => {
            this.forEachClassProperty(c, "none", (name, _, _p) => {
                this.emitLine(
                    this.dartType(_p.type, true, true),
                    " ",
                    name,
                    ",",
                );
            });
        });
        this.emitLine("}) => ");
        this.indent(() => {
            this.emitLine(className, "(");
            this.indent(() => {
                this.forEachClassProperty(c, "none", (name, _, _p) => {
                    this.emitLine(name, ": ", name, " ?? ", "this.", name, ",");
                });
            });
            this.emitLine(");");
        });
    }

    private _emitStringJsonEncoderDecoder(className: Name): void {
        this.ensureBlankLine();
        this.emitLine(
            "factory ",
            className,
            ".from",
            this._options.methodNamesWithMap ? "Json" : "RawJson",
            "(String str) => ",
            className,
            ".",
            this.fromJson,
            "(json.decode(str));",
        );

        this.ensureBlankLine();
        this.emitLine(
            "String ",
            this._options.methodNamesWithMap
                ? "toJson() => "
                : "toRawJson() => ",
            "json.encode(",
            this.toJson,
            "());",
        );
    }

    private _emitMapEncoderDecoder(c: ClassType, className: Name): void {
        this.ensureBlankLine();
        this.emitLine(
            "factory ",
            className,
            ".",
            this.fromJson,
            "(Map<String, dynamic> json) => ",
            className,
            "(",
        );
        this.indent(() => {
            this.forEachClassProperty(c, "none", (name, jsonName, property) => {
                const key = stringEscape(jsonName);
                const value = `json["${key}"]`;
                const input =
                    !property.isOptional && property.type.isNullable
                        ? `(json.containsKey("${key}") ? ${value} : throw FormatException('Missing required property'))`
                        : value;
                this.emitLine(
                    name,
                    ": ",
                    this.fromDynamicExpression(
                        property.type.isNullable,
                        property.type,
                        input,
                    ),
                    ",",
                );
            });
        });
        this.emitLine(");");

        this.ensureBlankLine();

        this.emitLine("Map<String, dynamic> ", this.toJson, "() => {");
        this.indent(() => {
            this.forEachClassProperty(c, "none", (name, jsonName, property) => {
                this.emitLine(
                    '"',
                    stringEscape(jsonName),
                    '": ',
                    this.toDynamicExpression(
                        property.type.isNullable,
                        property.type,
                        name,
                    ),
                    ",",
                );
            });
        });
        this.emitLine("};");
    }

    protected emitClassDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        if (this._options.useHive) {
            this.classCounter++;
            this.emitLine(`@HiveType(typeId: ${this.classCounter})`);
            this.classPropertyCounter = 0;
        }

        if (this._options.useJsonAnnotation) {
            this.emitLine("@JsonSerializable()");
        }

        this.emitBlock(["class ", className], () => {
            if (c.getProperties().size === 0) {
                this._emitEmptyConstructor(className);
            } else {
                this._emitVariables(c);
                this.ensureBlankLine();
                this._emitConstructor(c, className);
            }

            if (this._options.generateCopyWith) {
                this._emitCopyConstructor(c, className);
            }

            if (this._options.useJsonAnnotation) {
                this.ensureBlankLine();
                this.emitLine(
                    // factory PublicAnswer.fromJson(Map<String, dynamic> json) => _$PublicAnswerFromJson(json);
                    "factory ",
                    className,
                    ".fromJson(Map<String, dynamic> json) => ",
                    "_$",
                    className,
                    "FromJson(json);",
                );

                this.ensureBlankLine();
                this.emitLine(
                    // Map<String, dynamic> toJson() => _$PublicAnswerToJson(this);
                    "Map<String, dynamic> toJson() => ",
                    "_$",
                    className,
                    "ToJson(this);",
                );
            } else {
                if (this._options.justTypes) return;

                if (this._options.codersInClass) {
                    this._emitStringJsonEncoderDecoder(className);
                }

                this._emitMapEncoderDecoder(c, className);
            }
        });
    }

    protected emitFreezedClassDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));

        this.emitLine("@freezed");
        this.emitBlock(
            ["abstract class ", className, " with _$", className],
            () => {
                if (c.getProperties().size === 0) {
                    this.emitLine(
                        "const factory ",
                        className,
                        "() = _",
                        className,
                        ";",
                    );
                } else {
                    this.emitLine("const factory ", className, "({");
                    this.indent(() => {
                        this.forEachClassProperty(
                            c,
                            "none",
                            (name, jsonName, prop) => {
                                const description =
                                    this.descriptionForClassProperty(
                                        c,
                                        jsonName,
                                    );
                                if (description !== undefined) {
                                    this.emitDescription(description);
                                }

                                const required =
                                    this._options.requiredProperties ||
                                    !prop.type.isNullable ||
                                    !prop.isOptional;
                                this.classPropertyCounter++;
                                this.emitLine(
                                    `@JsonKey(name: "${stringEscape(jsonName)}")`,
                                );

                                this.emitLine(
                                    required ? "required " : "",
                                    this.dartType(prop.type, true),
                                    " ",
                                    name,
                                    ",",
                                );
                            },
                        );
                    });
                    this.emitLine("}) = _", className, ";");
                }

                if (this._options.justTypes) return;

                this.ensureBlankLine();
                this.emitLine(
                    // factory PublicAnswer.fromJson(Map<String, dynamic> json) => _$PublicAnswerFromJson(json);
                    "factory ",
                    className,
                    ".fromJson(Map<String, dynamic> json) => ",
                    "_$",
                    className,
                    "FromJson(json);",
                );
            },
        );
    }

    /**
     * Whether an optional item of a tuple can be null.  Such an item is a
     * `Present`, which keeps a missing item (null) apart from a null one
     * (`Present(null)`).
     */
    private tupleItemNeedsPresent(t: TupleType, i: number): boolean {
        return i >= t.minItems && t.items[i].isNullable;
    }

    private tupleNeedsPresent(t: TupleType): boolean {
        return t.items.some((_, i) => this.tupleItemNeedsPresent(t, i));
    }

    /**
     * A field `itemN` per tuple item, and `rest` for the rest.  An optional
     * item is null if it's missing.
     */
    private tupleFields(
        t: TupleType,
    ): Array<{ name: string; type: Sourcelike; required: boolean }> {
        const fields = t.items.map((item, i) => {
            const name = `item${i}`;
            if (i < t.minItems) {
                return {
                    name,
                    type: this.dartType(item, true),
                    required: true,
                };
            }

            const type = this.tupleItemNeedsPresent(t, i)
                ? ["Present<", this.dartType(item, true), ">?"]
                : this.dartType(item, true, true);
            return { name, type, required: false };
        });
        if (t.rest !== undefined) {
            fields.push({
                name: "rest",
                type: ["List<", this.dartType(t.rest, true), ">"],
                required: true,
            });
        }

        return fields;
    }

    /** The bounds of a tuple's length; `max` is undefined with a rest. */
    private tupleLengthBounds(t: TupleType): [number, number | undefined] {
        const [minConstraint, maxConstraint] = minMaxItemsForType(t) ?? [];
        const min = Math.max(t.minItems, minConstraint ?? 0);
        if (t.rest === undefined) return [min, t.items.length];
        return [min, maxConstraint];
    }

    private emitTupleFromJson(t: TupleType, tupleName: Name): void {
        const [min, max] = this.tupleLengthBounds(t);
        const conditions: string[] = [];
        if (min === max) {
            conditions.push(`json.length != ${min}`);
        } else {
            if (min > 0) conditions.push(`json.length < ${min}`);
            if (max !== undefined) conditions.push(`json.length > ${max}`);
        }
        const count =
            max === undefined
                ? `at least ${min}`
                : min === max
                  ? `${min}`
                  : `${min} to ${max}`;
        const elements =
            min === 1 && (max === undefined || max === 1)
                ? "element"
                : "elements";

        this.emitBlock(
            ["factory ", tupleName, ".", this.fromJson, "(List<dynamic> json)"],
            () => {
                if (conditions.length > 0) {
                    this.emitBlock(["if (", conditions.join(" || "), ")"], () =>
                        this.emitLine(
                            'throw FormatException("Expected ',
                            count,
                            " ",
                            elements,
                            " for ",
                            tupleName,
                            '");',
                        ),
                    );
                }

                this.emitLine("return ", tupleName, "(");
                this.indent(() => {
                    t.items.forEach((item, i) => {
                        const element = `json[${i}]`;
                        if (i < t.minItems) {
                            this.emitLine(
                                `item${i}: `,
                                this.fromDynamicExpression(
                                    item.isNullable,
                                    item,
                                    element,
                                ),
                                ",",
                            );
                        } else if (this.tupleItemNeedsPresent(t, i)) {
                            this.emitLine(
                                `item${i}: json.length > ${i} ? Present<`,
                                this.dartType(item),
                                ">(",
                                this.fromDynamicExpression(true, item, element),
                                ") : null,",
                            );
                        } else {
                            // The item is null if it's missing, so a null
                            // element must not get there.
                            const nonNull = [
                                "(",
                                element,
                                ` ?? (throw FormatException("Item ${i} of `,
                                tupleName,
                                ` can't be null"))`,
                                ")",
                            ];
                            this.emitLine(
                                `item${i}: json.length > ${i} ? `,
                                this.fromDynamicExpression(
                                    false,
                                    item,
                                    nonNull,
                                ),
                                " : null,",
                            );
                        }
                    });
                    const rest = t.rest;
                    if (rest !== undefined) {
                        this.emitLine(
                            "rest: List<",
                            this.dartType(rest),
                            `>.from(json.skip(${t.items.length}).map((x) => `,
                            this.fromDynamicExpression(
                                rest.isNullable,
                                rest,
                                "x",
                            ),
                            ")),",
                        );
                    }
                });
                this.emitLine(");");
            },
        );
    }

    /**
     * An item may only follow an optional item that is present: a JSON
     * array can't leave a gap.
     */
    private tupleGapCondition(t: TupleType): string | undefined {
        const conditions: string[] = [];
        for (let i = t.minItems + 1; i < t.items.length; i++) {
            conditions.push(`item${i - 1} == null && item${i} != null`);
        }

        if (t.rest !== undefined && t.minItems < t.items.length) {
            conditions.push(
                `item${t.items.length - 1} == null && rest.isNotEmpty`,
            );
        }

        if (conditions.length <= 1) return conditions[0];
        return conditions.map((c) => `(${c})`).join(" || ");
    }

    /**
     * Writes the required items, the optional ones that are present, then
     * the rest.
     */
    private emitTupleToJson(t: TupleType, tupleName: Name): void {
        const emitElements = (): void => {
            this.indent(() => {
                t.items.forEach((item, i) => {
                    if (i < t.minItems) {
                        this.emitLine(
                            this.toDynamicExpression(
                                item.isNullable,
                                item,
                                `item${i}`,
                            ),
                            ",",
                        );
                        return;
                    }

                    const value = this.tupleItemNeedsPresent(t, i)
                        ? this.toDynamicExpression(
                              true,
                              item,
                              `item${i}!.value`,
                          )
                        : this.toDynamicExpression(false, item, `item${i}!`);
                    this.emitLine(`if (item${i} != null) `, value, ",");
                });
                const rest = t.rest;
                if (rest !== undefined) {
                    const value = this.toDynamicExpression(
                        rest.isNullable,
                        rest,
                        "x",
                    );
                    this.emitLine(
                        this.sourcelikeToString(value) === "x"
                            ? "...rest"
                            : ["...rest.map((x) => ", value, ")"],
                        ",",
                    );
                }
            });
        };

        const gap = this.tupleGapCondition(t);
        if (gap === undefined) {
            this.emitLine("List<dynamic> ", this.toJson, "() => [");
            emitElements();
            this.emitLine("];");
            return;
        }

        this.emitBlock(["List<dynamic> ", this.toJson, "()"], () => {
            this.emitBlock(["if (", gap, ")"], () =>
                this.emitLine(
                    'throw StateError("An item of ',
                    tupleName,
                    ' follows a missing optional item");',
                ),
            );
            this.emitLine("return [");
            emitElements();
            this.emitLine("];");
        });
    }

    /**
     * A tuple is a class with a field per item (see `tupleFields`), which
     * reads itself from a JSON array and writes itself back.  It's a plain
     * class also with `--use-freezed` and `--use-json-annotation`, whose
     * generated code reads JSON objects only; theirs calls the tuple's
     * `fromJson` and `toJson`.
     */
    protected emitTupleDefinition(t: TupleType, tupleName: Name): void {
        this.emitDescription(this.descriptionForType(t));
        if (this._options.useHive) {
            this.classCounter++;
            this.emitLine(`@HiveType(typeId: ${this.classCounter})`);
            this.classPropertyCounter = 0;
        }

        if (this.tupleNeedsPresent(t)) {
            this._needPresent = true;
        }

        const fields = this.tupleFields(t);
        this.emitBlock(["class ", tupleName], () => {
            for (const { name, type } of fields) {
                if (this._options.useHive) {
                    this.classPropertyCounter++;
                    this.emitLine(`@HiveField(${this.classPropertyCounter})`);
                }

                this.emitLine(
                    this._options.finalProperties ? "final " : "",
                    type,
                    " ",
                    name,
                    ";",
                );
            }

            this.ensureBlankLine();
            this.emitLine(tupleName, "({");
            this.indent(() => {
                for (const { name, required } of fields) {
                    this.emitLine(
                        required || this._options.requiredProperties
                            ? "required "
                            : "",
                        "this.",
                        name,
                        ",",
                    );
                }
            });
            this.emitLine("});");

            if (this._options.generateCopyWith) {
                this.ensureBlankLine();
                this.emitLine(tupleName, " copyWith({");
                this.indent(() => {
                    t.items.forEach((item, i) => {
                        const type = this.tupleItemNeedsPresent(t, i)
                            ? fields[i].type
                            : this.dartType(item, true, true);
                        this.emitLine(type, " ", fields[i].name, ",");
                    });
                    if (t.rest !== undefined) {
                        this.emitLine(
                            "List<",
                            this.dartType(t.rest, true),
                            ">? rest,",
                        );
                    }
                });
                this.emitLine("}) => ");
                this.indent(() => {
                    this.emitLine(tupleName, "(");
                    this.indent(() => {
                        for (const { name } of fields) {
                            this.emitLine(
                                name,
                                ": ",
                                name,
                                " ?? this.",
                                name,
                                ",",
                            );
                        }
                    });
                    this.emitLine(");");
                });
            }

            if (this._options.justTypes) return;

            if (this._options.codersInClass) {
                this._emitStringJsonEncoderDecoder(tupleName);
            }

            this.ensureBlankLine();
            this.emitTupleFromJson(t, tupleName);
            this.ensureBlankLine();
            this.emitTupleToJson(t, tupleName);
        });
    }

    protected emitPresent(): void {
        this.ensureBlankLine();
        this.emitMultiline(`/// An optional tuple item that is there, even if it's null.  A missing
/// item is null.
class Present<T> {
    final T value;

    const Present(this.value);
}`);
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        // Hive can only store the classes' enum properties with an adapter
        // for the enum, too.
        if (this._options.useHive) {
            this.classCounter++;
            this.emitLine(`@HiveType(typeId: ${this.classCounter})`);
            this.classPropertyCounter = 0;
        }

        this.emitLine("enum ", enumName, " {");
        this.indent(() => {
            this.forEachEnumCase(e, "none", (name, jsonName, pos) => {
                const comma = pos === "first" || pos === "middle" ? "," : [];
                if (this._options.useHive) {
                    this.classPropertyCounter++;
                    this.emitLine(`@HiveField(${this.classPropertyCounter})`);
                }

                if (this._options.useJsonAnnotation) {
                    this.emitLine('@JsonValue("', stringEscape(jsonName), '")');
                }

                this.emitLine(name, comma);
            });
        });
        this.emitLine("}");

        if (this._options.justTypes) return;

        this.ensureBlankLine();
        this.emitLine(
            "final ",
            defined(this._enumValues.get(e)),
            " = EnumValues({",
        );
        this.indent(() => {
            this.forEachEnumCase(e, "none", (name, jsonName, pos) => {
                const comma = pos === "first" || pos === "middle" ? "," : [];
                this.emitLine(
                    '"',
                    stringEscape(jsonName),
                    '": ',
                    enumName,
                    ".",
                    name,
                    comma,
                );
            });
        });
        this.emitLine("});");

        this._needEnumValues = true;
    }

    protected emitEnumValues(): void {
        this.ensureBlankLine();
        this.emitMultiline(`class EnumValues<T> {
	Map<String, T> map;
	late Map<T, String> reverseMap;

	EnumValues(this.map);

	Map<T, String> get reverse {
			reverseMap = map.map((k, v) => MapEntry(v, k));
			return reverseMap;
	}
}`);
    }

    private _emitTopLvlEncoderDecoder(): void {
        this.forEachTopLevel("leading-and-interposing", (t, name) => {
            const { encoder, decoder } = defined(
                this._topLevelDependents.get(name),
            );

            this.emitLine(
                this.dartType(t),
                " ",
                decoder,
                "(String str) => ",
                this.fromDynamicExpression(t.isNullable, t, "json.decode(str)"),
                ";",
            );

            this.ensureBlankLine();

            this.emitLine(
                "String ",
                encoder,
                "(",
                this.dartType(t),
                " data) => json.encode(",
                this.toDynamicExpression(t.isNullable, t, "data"),
                ");",
            );

            // this.emitBlock(["String ", encoder, "(", this.dartType(t), " data)"], () => {
            //     this.emitJsonEncoderBlock(t);
            // });
        });
    }

    protected emitSourceStructure(): void {
        this.emitFileHeader();

        if (!this._options.justTypes && !this._options.codersInClass) {
            this._emitTopLvlEncoderDecoder();
        }

        // Aliases for top-levels whose name isn't taken by a class or enum.
        this.forEachTopLevel(
            "leading-and-interposing",
            (t, name) =>
                this.emitLine("typedef ", name, " = ", this.dartType(t), ";"),
            (t) => this.namedTypeToNameForTopLevel(t) === undefined,
        );

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) =>
                this._options.useFreezed
                    ? this.emitFreezedClassDefinition(c, n)
                    : this.emitClassDefinition(c, n),
            (e, n) => this.emitEnumDefinition(e, n),
            (_e, _n) => {
                // We don't support this yet.
            },
            (t, n) => this.emitTupleDefinition(t, n),
        );

        if (this._needEnumValues) {
            this.emitEnumValues();
        }

        if (this._needPresent) {
            this.emitPresent();
        }
    }
}
