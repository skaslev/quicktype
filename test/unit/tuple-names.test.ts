// A union has a member for each tuple shape.  Union members are named
// after their types; tuples that aren't declared under a name are all
// "tuple", so several in one union used to get adjectives (`PurpleTuple`,
// `FluffyTuple`).  Several of different lengths are named after their
// lengths instead.

import {
    ConvenienceRenderer,
    InputData,
    JSONSchemaInput,
    type Name,
    type Namer,
    type RenderContext,
    TargetLanguage,
    funPrefixNamer,
    quicktype,
} from "quicktype-core";
import { describe, expect, test } from "vitest";

function pascal(s: string): string {
    return s
        .split(/[^A-Za-z0-9]+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
}

// Lists the members of each union, as `Union: Member Member ...`.
class UnionMembersRenderer extends ConvenienceRenderer {
    protected makeNamedTypeNamer(): Namer {
        return funPrefixNamer("types", pascal);
    }

    protected namerForObjectProperty(): Namer {
        return funPrefixNamer("properties", pascal);
    }

    protected makeUnionMemberNamer(): Namer {
        return funPrefixNamer("members", pascal);
    }

    protected makeEnumCaseNamer(): Namer {
        return funPrefixNamer("cases", pascal);
    }

    protected emitSourceStructure(): void {
        this.forEachNamedType(
            "none",
            () => undefined,
            () => undefined,
            (u, unionName) => {
                const members: Name[] = [];
                this.forEachUnionMember(u, null, "none", null, (name) => {
                    members.push(name);
                });
                this.emitLine(
                    unionName,
                    ":",
                    ...members.flatMap((name) => [" ", name]),
                );
            },
        );
    }
}

class TupleTargetLanguage extends TargetLanguage {
    public constructor() {
        super({
            displayName: "Tuples",
            names: ["tuples"],
            extension: "txt",
        });
    }

    protected getOptions(): Record<string, never> {
        return {};
    }

    public get tupleSupport(): "full" {
        return "full";
    }

    protected makeRenderer(renderContext: RenderContext): UnionMembersRenderer {
        return new UnionMembersRenderer(this, renderContext);
    }
}

async function unionMembers(schema: object): Promise<string> {
    const schemaInput = new JSONSchemaInput(undefined);
    await schemaInput.addSource({
        name: "TopLevel",
        schema: JSON.stringify(schema),
    });
    const inputData = new InputData();
    inputData.addInput(schemaInput);

    const result = await quicktype({
        inputData,
        lang: new TupleTargetLanguage(),
    });
    return result.lines.join("\n").trim();
}

function tuple(...items: object[]): object {
    return {
        type: "array",
        items,
        minItems: items.length,
        maxItems: items.length,
    };
}

const string = { type: "string" };
const integer = { type: "integer" };

describe("the tuple members of a union", () => {
    test("are named after their lengths if those differ", async () => {
        const output = await unionMembers({
            oneOf: [
                tuple(string, integer),
                tuple(string, integer, integer),
                integer,
            ],
        });
        expect(output).toBe("TopLevel: Integer Tuple2 Tuple3");
    });

    test("are named tuple if there is one", async () => {
        const output = await unionMembers({
            oneOf: [tuple(string, integer), integer],
        });
        expect(output).toBe("TopLevel: Integer Tuple");
    });

    test("of the same length are named tuple", async () => {
        const output = await unionMembers({
            oneOf: [
                tuple(string, integer),
                { ...tuple(string, integer), minItems: 1 },
            ],
        });
        expect(output).toBe("TopLevel: FluffyTuple PurpleTuple");
    });

    test("in arrays are named tuple", async () => {
        const output = await unionMembers({
            oneOf: [
                { type: "array", items: tuple(string, integer) },
                tuple(string, integer, integer),
                integer,
            ],
        });
        expect(output).toBe("TopLevel: Integer Tuple TupleArray");
    });
});
