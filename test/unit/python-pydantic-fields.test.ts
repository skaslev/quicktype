// The fields of pydantic models (`--pydantic-base-model`).

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: "python",
        rendererOptions,
    });
    return result.lines.join("\n");
}

const pydantic = { "pydantic-base-model": true };

describe("from_dict", () => {
    const plain = {
        type: "object",
        properties: {
            name: { type: "string" },
            child: {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
            },
            count: { type: "integer" },
        },
        required: ["name", "child"],
    };

    // BaseModel.__init__ takes no positional arguments.
    test("constructs pydantic models with keyword arguments", async () => {
        const output = await renderSchema(plain, pydantic);
        expect(output).toContain("return Child(label=label)");
        expect(output).toContain(
            "return TopLevel(child=child, name=name, count=count)",
        );
    });

    test("constructs other classes with positional arguments", async () => {
        const output = await renderSchema(plain);
        expect(output).toContain("return Child(label)");
        expect(output).toContain("return TopLevel(child, name, count)");
    });
});

describe("aliases", () => {
    const renamed = {
        type: "object",
        properties: {
            "first-entry": { type: "integer" },
            lastName: { type: "string" },
            plain: { type: "boolean" },
            "count-str": { type: "integer" },
            class: { type: "string" },
        },
        required: ["first-entry", "lastName"],
    };

    // pydantic validates a field under its name unless it has an alias.
    test("pydantic fields take their JSON names as aliases", async () => {
        const output = await renderSchema(renamed, {
            ...pydantic,
            "just-types": true,
        });
        expect(output).toContain("from pydantic import BaseModel, Field");
        expect(output).toContain(
            'first_entry: int = Field(alias="first-entry")',
        );
        expect(output).toContain('last_name: str = Field(alias="lastName")');
        expect(output).toContain(
            'count_str: int | None = Field(default=None, alias="count-str")',
        );
        expect(output).toContain(
            'top_level_class: str | None = Field(default=None, alias="class")',
        );
        expect(output).toContain("plain: bool | None = None");
    });

    test("Python 3.7 pydantic fields take aliases", async () => {
        const output = await renderSchema(renamed, {
            ...pydantic,
            "just-types": true,
            "python-version": "3.7",
        });
        expect(output).toContain(
            'count_str: Optional[int] = Field(default=None, alias="count-str")',
        );
    });

    test("no Field without aliases", async () => {
        const output = await renderSchema(
            { type: "object", properties: { plain: { type: "boolean" } } },
            { ...pydantic, "just-types": true },
        );
        expect(output).not.toContain("Field");
    });

    test("dataclasses take no aliases", async () => {
        const output = await renderSchema(renamed, { "just-types": true });
        expect(output).not.toContain("Field");
        expect(output).toContain("first_entry: int");
    });

    // Type checkers take a field's alias as the name of its constructor
    // parameter (dataclass_transform), so from_dict passes the aliases,
    // those that can't be keywords through a `Dict[str, Any]`.
    test("from_dict constructs pydantic models with the aliases", async () => {
        const output = await renderSchema(renamed, pydantic);
        expect(output).toContain(
            'return TopLevel(lastName=last_name, plain=plain, **cast(dict[str, Any], {"first-entry": first_entry, "class": top_level_class, "count-str": count_str}))',
        );
    });

    // from_dict's locals are the properties.
    test("no property shadows cast in from_dict", async () => {
        const output = await renderSchema(
            {
                type: "object",
                properties: {
                    cast: { type: "string" },
                    "first-entry": { type: "integer" },
                },
            },
            pydantic,
        );
        expect(output).not.toMatch(/^ {8}cast = /m);
        expect(output).toContain('**cast(dict[str, Any], {"first-entry"');
    });

    test("Python 3.7 from_dict casts to Dict", async () => {
        const output = await renderSchema(renamed, {
            ...pydantic,
            "python-version": "3.7",
        });
        expect(output).toContain('**cast(Dict[str, Any], {"first-entry"');
        expect(output).toMatch(/from typing import [^\n]*\bDict\b/);
    });
});

describe("pydantic's names", () => {
    // A class named BaseModel or Field shadows the import.
    test("classes don't take the names imported from pydantic", async () => {
        const output = await renderSchema(
            {
                type: "object",
                properties: {
                    baseModel: { $ref: "#/definitions/BaseModel" },
                    field: { $ref: "#/definitions/Field" },
                },
                definitions: {
                    BaseModel: {
                        type: "object",
                        properties: { a: { type: "integer" } },
                    },
                    Field: {
                        type: "object",
                        properties: { b: { type: "integer" } },
                    },
                },
            },
            { ...pydantic, "just-types": true },
        );
        expect(output).not.toMatch(/^class (BaseModel|Field)\(/m);
        expect(output).toContain("class BaseModelClass(BaseModel):");
        expect(output).toContain("class FieldClass(BaseModel):");
    });

    // `Field: Optional[int] = None` would bind `Field` in the class body.
    test("fields aren't named Field", async () => {
        const output = await renderSchema(
            {
                type: "object",
                properties: {
                    Field: { type: "integer" },
                    "first-entry": { type: "integer" },
                },
            },
            {
                ...pydantic,
                "just-types": true,
                "nice-property-names": false,
            },
        );
        expect(output).not.toMatch(/^ {4}Field\b/m);
        expect(output).toContain('Field(default=None, alias="Field")');
    });
});

describe("BaseModel attributes", () => {
    const shadowing = {
        type: "object",
        properties: {
            $schema: { type: "string" },
            copy: { type: "string" },
            json: { type: "integer" },
            model_config: { type: "integer" },
            register: { type: "integer" },
            fields: { type: "integer" },
        },
        required: ["copy"],
    };

    // pydantic 1 rejects a field that shadows a BaseModel attribute, and
    // pydantic 2 warns (or rejects `model_config`).
    test("pydantic fields don't shadow BaseModel attributes", async () => {
        const output = await renderSchema(shadowing, {
            ...pydantic,
            "just-types": true,
        });
        expect(output).toContain('top_level_copy: str = Field(alias="copy")');
        expect(output).toContain(
            'top_level_schema: str | None = Field(default=None, alias="$schema")',
        );
        expect(output).toContain(
            'top_level_json: int | None = Field(default=None, alias="json")',
        );
        expect(output).toContain(
            'top_level_model_config: int | None = Field(default=None, alias="model_config")',
        );
        expect(output).toContain(
            'top_level_register: int | None = Field(default=None, alias="register")',
        );
        expect(output).toContain("fields: int | None = None");
    });

    test("from_dict passes them under their aliases", async () => {
        const output = await renderSchema(shadowing, pydantic);
        expect(output).toContain(
            'return TopLevel(copy=top_level_copy, fields=fields, json=top_level_json, model_config=top_level_model_config, register=top_level_register, **cast(dict[str, Any], {"$schema": top_level_schema}))',
        );
    });

    test("other classes keep those names", async () => {
        const output = await renderSchema(shadowing, { "just-types": true });
        expect(output).toContain("copy: str");
        expect(output).toContain("schema: str | None = None");
    });
});
