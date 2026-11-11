// JSON Schema tuples in Elm: fixed-length tuples of 2 or 3 items are Elm
// tuples, other tuples records with a field per item, `itemN`, and `rest`,
// and tuples that contain themselves (a type alias can't) custom types
// whose constructor takes the items.  Their decoders check the length of
// the JSON array and decode the items with `Jdec.index`; their encoders
// write a JSON array.

import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import { describe, expect, test } from "vitest";

async function renderSchema(
    schema: object,
    rendererOptions: Record<string, string | boolean> = {},
): Promise<string> {
    const input = new JSONSchemaInput(undefined);
    await input.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(input);
    const result = await quicktype({ inputData, lang: "elm", rendererOptions });
    return result.lines.join("\n");
}

const justTypes = { "just-types": true };

const lines = (...ls: string[]): string => ls.join("\n");

function inObject(properties: Record<string, object>): object {
    return {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
    };
}

// ZRANGE WITHSCORES: `[member, score]` pairs, and an unnamed pair.
const pairs = inObject({
    scores: {
        type: "array",
        items: {
            title: "MemberScore",
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
        },
    },
    pair: {
        type: "array",
        items: [{ type: "integer" }, { type: ["string", "null"] }],
    },
    triple: {
        type: "array",
        items: [{ type: "integer" }, { type: "boolean" }, { type: "string" }],
    },
});

// CLUSTER SLOTS: `[start, end, master, ...replicas]`.
const slotRanges = {
    type: "array",
    items: {
        title: "SlotRange",
        type: "array",
        minItems: 3,
        items: [
            { type: "integer" },
            { type: "integer" },
            { $ref: "#/$defs/node" },
        ],
        additionalItems: { $ref: "#/$defs/node" },
    },
    $defs: {
        node: {
            title: "SlotNode",
            type: "array",
            items: [{ type: ["string", "null"] }, { type: "integer" }],
        },
    },
};

// A string, then an optional number and an optional nullable string.
const optionals = inObject({
    opt: {
        title: "Opt",
        type: "array",
        minItems: 1,
        items: [
            { type: "string" },
            { type: "number" },
            { type: ["string", "null"] },
        ],
    },
});

// COMMAND INFO: a command's subcommands are commands.
const commands = {
    type: "array",
    items: { $ref: "#/$defs/command" },
    $defs: {
        command: {
            title: "Command",
            type: "array",
            items: [
                { type: "string" },
                { type: "integer" },
                { type: "array", items: { $ref: "#/$defs/command" } },
            ],
        },
    },
};

describe("tuple types", () => {
    test("of 2 or 3 items are Elm tuples", async () => {
        const output = await renderSchema(pairs, justTypes);
        expect(output).toContain(
            lines(
                "type alias TopLevel =",
                "    { pair : ( Int, Maybe String )",
                "    , scores : List MemberScore",
                "    , triple : ( Int, Bool, String )",
                "    }",
            ),
        );
        // Named by the schema.
        expect(output).toContain("type alias MemberScore = ( String, Float )");
        expect(output).not.toContain("type alias Pair");
    });

    test("with a rest are records", async () => {
        const output = await renderSchema(slotRanges, justTypes);
        expect(output).toContain(
            lines(
                "type alias SlotRange =",
                "    { item0 : Int",
                "    , item1 : Int",
                "    , item2 : SlotNode",
                "    , rest : List SlotNode",
                "    }",
            ),
        );
    });

    test("with optional items are records with Maybe fields", async () => {
        const output = await renderSchema(optionals, justTypes);
        expect(output).toContain(
            lines(
                "type alias Opt =",
                "    { item0 : String",
                "    , item1 : Maybe Float",
                "    , item2 : Maybe (Maybe String)",
                "    }",
            ),
        );
    });

    test("that contain themselves are custom types", async () => {
        const output = await renderSchema(commands, justTypes);
        expect(output).toContain("type alias TopLevel = List Command");
        expect(output).toContain(
            lines("type Command", "    = Command String Int (List Command)"),
        );
    });

    test("of other lengths are records", async () => {
        const output = await renderSchema(
            inObject({
                one: { type: "array", items: [{ type: "string" }] },
                four: {
                    type: "array",
                    items: [
                        { type: "string" },
                        { type: "string" },
                        { type: "string" },
                        { type: "string" },
                    ],
                },
            }),
            justTypes,
        );
        expect(output).toContain(
            lines("type alias One =", "    { item0 : String", "    }"),
        );
        expect(output).toContain("    , item3 : String");
    });
});

describe("tuple decoders and encoders", () => {
    test("read and write Elm tuples", async () => {
        const output = await renderSchema(pairs);
        expect(output).toContain(
            lines(
                "memberScore : Jdec.Decoder MemberScore",
                "memberScore =",
                "    tupleOfLength 2 (Just 2) (\\_ ->",
                "        Jdec.map2 Tuple.pair",
                "            (Jdec.index 0 Jdec.string)",
                "            (Jdec.index 1 Jdec.float))",
                "",
                "encodeMemberScore : MemberScore -> Jenc.Value",
                "encodeMemberScore ( x, y ) =",
                "    Jenc.list identity [ Jenc.string x, Jenc.float y ]",
            ),
        );
        expect(output).toContain("        Jdec.map3 (\\x y r -> ( x, y, r ))");
        expect(output).toContain(
            '        |> Jpipe.required "scores" (Jdec.list memberScore )',
        );
        expect(output).toContain("tupleOfLength : Int -> Maybe Int ->");
        // Helpers for optional items and rests aren't needed here.
        expect(output).not.toContain("optionalTupleItem");
        expect(output).not.toContain("tupleRestItems");
    });

    test("read and write a rest", async () => {
        const output = await renderSchema(slotRanges);
        expect(output).toContain(
            lines(
                "    tupleOfLength 3 Nothing (\\m ->",
                "        Jdec.succeed SlotRange",
                "            |> Jpipe.custom (Jdec.index 0 Jdec.int)",
                "            |> Jpipe.custom (Jdec.index 1 Jdec.int)",
                "            |> Jpipe.custom (Jdec.index 2 slotNode)",
                "            |> Jpipe.custom (tupleRestItems m 3 slotNode))",
            ),
        );
        expect(output).toContain(
            lines(
                "encodeSlotRange x =",
                "    Jenc.list identity (",
                "        [ Jenc.int x.item0",
                "        , Jenc.int x.item1",
                "        , encodeSlotNode x.item2",
                "        ] ++ List.map encodeSlotNode x.rest)",
            ),
        );
        expect(output).toContain(
            "tupleRestItems : Int -> Int -> Jdec.Decoder a -> Jdec.Decoder (List a)",
        );
    });

    test("read the optional items that are there", async () => {
        const output = await renderSchema(optionals);
        expect(output).toContain(
            lines(
                "    tupleOfLength 1 (Just 3) (\\m ->",
                "        Jdec.succeed Opt",
                "            |> Jpipe.custom (Jdec.index 0 Jdec.string)",
                "            |> Jpipe.custom (optionalTupleItem m 1 Jdec.float)",
                "            |> Jpipe.custom (optionalTupleItem m 2 (Jdec.nullable Jdec.string)))",
            ),
        );
        // The array ends at the first missing item.
        expect(output).toContain(
            lines(
                "    Jenc.list identity (presentTupleItems",
                "        [ Just (Jenc.string x.item0)",
                "        , Maybe.map Jenc.float x.item1",
                "        , Maybe.map (makeNullableEncoder Jenc.string) x.item2",
                "        ])",
            ),
        );
    });

    test("of custom types match the constructor", async () => {
        const output = await renderSchema(commands);
        expect(output).toContain(
            lines(
                "command =",
                "    tupleOfLength 3 (Just 3) (\\_ ->",
                "        Jdec.succeed Command",
            ),
        );
        expect(output).toContain(
            lines(
                "encodeCommand (Command x0 x1 x2) =",
                "    Jenc.list identity",
                "        [ Jenc.string x0",
                "        , Jenc.int x1",
                "        , Jenc.list encodeCommand x2",
                "        ]",
            ),
        );
        expect(output).toContain("    , Command(..)");
    });

    test("keep their variables apart from top-level names", async () => {
        const output = await renderSchema({
            ...inObject({
                x0: {
                    title: "X0",
                    type: "object",
                    properties: { a: { type: "integer" } },
                },
                commands: { type: "array", items: { $ref: "#/$defs/command" } },
            }),
            $defs: (commands as { $defs: object }).$defs,
        });
        expect(output).toContain("encodeCommand (Command x0 x1 x2) =");
        expect(output).not.toContain("\nx0 : Jdec.Decoder");
    });

    test("are tried before arrays in unions", async () => {
        const output = await renderSchema({
            oneOf: [
                { type: "array", items: { type: "string" } },
                {
                    title: "Pair",
                    type: "array",
                    items: [{ type: "string" }, { type: "string" }],
                },
            ],
        });
        expect(output).toContain(
            lines(
                "    Jdec.oneOf",
                "        [ Jdec.map PairInTopLevel pair",
                "        , Jdec.map StringArrayInTopLevel (Jdec.list Jdec.string )",
                "        ]",
            ),
        );
    });

    test("use Array for the rest with --array-type array", async () => {
        const output = await renderSchema(slotRanges, {
            "array-type": "array",
        });
        expect(output).toContain("    , rest : Array SlotNode");
        expect(output).toContain(
            "|> Jpipe.custom (Jdec.map Array.fromList (tupleRestItems m 3 slotNode)))",
        );
        expect(output).toContain(
            "] ++ List.map encodeSlotNode (Array.toList x.rest))",
        );
    });
});
