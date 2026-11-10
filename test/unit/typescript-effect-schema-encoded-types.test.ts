// A recursive Effect Schema reference must be annotated with its type,
// S.Schema<Type, Encoded>, and the encoded side declared as an interface, or
// the schema's encoded type is lost (`any`).

import {
    InputData,
    JSONSchemaInput,
    type LanguageName,
    quicktype,
} from "quicktype-core";
import { expect, test } from "vitest";

async function renderSchema(
    lang: LanguageName,
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

    const result = await quicktype({ inputData, lang, rendererOptions });
    return result.lines.join("\n");
}

function render(schema: object): Promise<string> {
    return renderSchema("typescript-effect-schema", schema);
}

const recursiveSchema = {
    $ref: "#/definitions/Node",
    definitions: {
        Node: {
            type: "object",
            properties: {
                name: { type: "string" },
                children: {
                    type: "array",
                    items: { $ref: "#/definitions/Node" },
                },
            },
            required: ["name"],
            additionalProperties: false,
        },
    },
};

test("declares the encoded type of a recursive class", async () => {
    const output = await render(recursiveSchema);
    expect(output).toContain(
        [
            "export interface TopLevelEncoded {",
            '    readonly "children"?: ReadonlyArray<TopLevelEncoded> | undefined;',
            '    readonly "name": string;',
            "}",
        ].join("\n"),
    );
    expect(output).toContain(
        "S.suspend((): S.Schema<TopLevel, TopLevelEncoded> => TopLevel)",
    );
    expect(output).not.toMatch(/\bany\b/);
});

// The class keys its fields by JSON name, so the encoded interface does too.
// Each member's encoded type is what its schema encodes to.
const recordSchema = {
    $ref: "#/definitions/Record",
    definitions: {
        Record: {
            type: "object",
            properties: {
                "first-name": { type: "string" },
                parent_record: {
                    oneOf: [{ $ref: "#/definitions/Record" }, { type: "null" }],
                },
                nickname: { type: ["string", "null"] },
                "child-records": {
                    type: "array",
                    items: { $ref: "#/definitions/Record" },
                },
                "by-key": {
                    type: "object",
                    additionalProperties: { $ref: "#/definitions/Record" },
                },
                "created-at": { type: "string", format: "date-time" },
                count: {
                    oneOf: [
                        { type: "integer" },
                        { type: "string", format: "integer" },
                    ],
                },
                enabled: { type: "string", format: "boolean" },
                kind: { enum: ["leaf", "branch"] },
                id: { type: "string", format: "uuid" },
            },
            required: ["first-name", "parent_record", "count"],
            additionalProperties: false,
        },
    },
};

test("declares the encoded type of each member by its JSON name", async () => {
    const output = await render(recordSchema);
    expect(output).toContain(
        [
            "export interface TopLevelEncoded {",
            '    readonly "by-key"?: { readonly [key: string]: TopLevelEncoded } | undefined;',
            '    readonly "child-records"?: ReadonlyArray<TopLevelEncoded> | undefined;',
            '    readonly "count": number | string;',
            '    readonly "created-at"?: string | undefined;',
            '    readonly "enabled"?: "true" | "false" | undefined;',
            '    readonly "first-name": string;',
            '    readonly "id"?: string | undefined;',
            '    readonly "kind"?: S.Schema.Encoded<typeof Kind> | undefined;',
            '    readonly "nickname"?: string | null | undefined;',
            '    readonly "parent_record": TopLevelEncoded | null;',
            "}",
        ].join("\n"),
    );
    expect(output).toContain(
        '"parent_record": S.NullOr(S.suspend((): S.Schema<TopLevel, TopLevelEncoded> => TopLevel)),',
    );
    expect(output).toContain(
        '"count": S.Union(S.Int, S.NumberFromString.pipe(S.int())),',
    );
});

const mutualSchema = {
    $ref: "#/definitions/Tree",
    definitions: {
        Tree: {
            type: "object",
            properties: {
                label: { type: "string" },
                forest: { $ref: "#/definitions/Forest" },
            },
            required: ["label"],
            additionalProperties: false,
        },
        Forest: {
            type: "object",
            properties: {
                trees: {
                    type: "array",
                    items: { $ref: "#/definitions/Tree" },
                },
            },
            required: ["trees"],
            additionalProperties: false,
        },
    },
};

test("declares the encoded types of mutually recursive classes", async () => {
    const output = await render(mutualSchema);
    expect(output).toContain(
        [
            "export interface ForestEncoded {",
            '    readonly "trees": ReadonlyArray<TopLevelEncoded>;',
            "}",
            "",
            'export class Forest extends S.Class<Forest>("Forest")({',
            '    "trees": S.Array(S.suspend((): S.Schema<TopLevel, TopLevelEncoded> => TopLevel)),',
            "}) {}",
            "",
            "export interface TopLevelEncoded {",
            '    readonly "forest"?: ForestEncoded | undefined;',
            '    readonly "label": string;',
            "}",
            "",
            'export class TopLevel extends S.Class<TopLevel>("TopLevel")({',
            '    "forest": S.optional(Forest),',
            '    "label": S.String,',
            "}) {}",
        ].join("\n"),
    );
});

// Zeta refers to Alpha, which doesn't recurse: Alpha is emitted first, and
// Zeta refers to it directly.
const forwardReferenceSchema = {
    type: "object",
    properties: {
        alpha: { $ref: "#/definitions/Alpha" },
        beta: { $ref: "#/definitions/Beta" },
        gamma: { $ref: "#/definitions/Gamma" },
        zeta: { $ref: "#/definitions/Zeta" },
    },
    required: ["alpha", "beta", "gamma", "zeta"],
    additionalProperties: false,
    definitions: {
        Alpha: {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
            additionalProperties: false,
        },
        Beta: {
            type: "object",
            properties: { y: { type: "string" } },
            required: ["y"],
            additionalProperties: false,
        },
        Gamma: {
            type: "object",
            properties: { z: { type: "string" } },
            required: ["z"],
            additionalProperties: false,
        },
        Zeta: {
            type: "object",
            properties: { alpha: { $ref: "#/definitions/Alpha" } },
            required: ["alpha"],
            additionalProperties: false,
        },
    },
};

test("doesn't suspend references outside cycles", async () => {
    const output = await render(forwardReferenceSchema);
    expect(output).toContain('"alpha": Alpha,');
    expect(output).not.toContain("S.suspend");
    expect(output).not.toContain("interface");
    expect(output).not.toMatch(/\bany\b/);
});

const collidingSchema = {
    type: "object",
    properties: {
        node: { $ref: "#/definitions/Node" },
        other: { $ref: "#/definitions/NodeEncoded" },
    },
    additionalProperties: false,
    definitions: {
        Node: {
            type: "object",
            properties: { next: { $ref: "#/definitions/Node" } },
            additionalProperties: false,
        },
        NodeEncoded: {
            type: "object",
            properties: { x: { type: "string" } },
            additionalProperties: false,
        },
    },
};

test("names the encoded interface apart from the classes", async () => {
    const output = await render(collidingSchema);
    expect(output).toContain(
        'export class NodeEncoded extends S.Class<NodeEncoded>("NodeEncoded")({',
    );
    expect(output).toContain(
        [
            "export interface PurpleNodeEncoded {",
            '    readonly "next"?: PurpleNodeEncoded | undefined;',
            "}",
        ].join("\n"),
    );
    expect(output).toContain(
        "S.suspend((): S.Schema<Node, PurpleNodeEncoded> => Node)",
    );
});
