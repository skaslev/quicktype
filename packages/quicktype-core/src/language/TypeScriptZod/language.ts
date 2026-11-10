import type { RenderContext } from "../../Renderer.js";
import { BooleanOption, getOptionValues } from "../../RendererOptions/index.js";
import {
    JS_SAFE_INTEGER_RANGE,
    type IntegerRange,
} from "../../support/IntegerRange.js";
import { TargetLanguage } from "../../TargetLanguage.js";
import type { TupleSupport } from "../../Type/Type.js";
import type { StringTypeMapping } from "../../Type/TypeBuilderUtils.js";
import type {
    PrimitiveStringTypeKind,
    TransformedStringTypeKind,
} from "../../Type/index.js";
import type { LanguageName, RendererOptions } from "../../types.js";

import { TypeScriptZodRenderer } from "./TypeScriptZodRenderer.js";

export const typeScriptZodOptions = {
    justSchema: new BooleanOption("just-schema", "Schema only", false),
};

export const typeScriptZodLanguageConfig = {
    displayName: "TypeScript Zod",
    names: ["typescript-zod"],
    extension: "ts",
} as const;

export class TypeScriptZodTargetLanguage extends TargetLanguage<
    typeof typeScriptZodLanguageConfig
> {
    public getSupportedIntegerRange(): IntegerRange | null {
        return JS_SAFE_INTEGER_RANGE;
    }

    public constructor() {
        super(typeScriptZodLanguageConfig);
    }

    public getOptions(): typeof typeScriptZodOptions {
        return typeScriptZodOptions;
    }

    public get stringTypeMapping(): StringTypeMapping {
        const mapping: Map<TransformedStringTypeKind, PrimitiveStringTypeKind> =
            new Map();
        const dateTimeType = "date-time";
        mapping.set("date-time", dateTimeType);
        mapping.set("uuid", "uuid");
        mapping.set("bool-string", "bool-string");
        mapping.set("integer-string", "integer-string");
        return mapping;
    }

    public get supportsOptionalClassProperties(): boolean {
        return true;
    }

    // z.tuple() with .rest() covers fixed items and a rest.  zod 3 requires
    // every item, so a tuple with optional items is a union of tuples.
    public get tupleSupport(): TupleSupport {
        return "full";
    }

    protected makeRenderer<Lang extends LanguageName = "typescript-zod">(
        renderContext: RenderContext,
        untypedOptionValues: RendererOptions<Lang>,
    ): TypeScriptZodRenderer {
        return new TypeScriptZodRenderer(
            this,
            renderContext,
            getOptionValues(typeScriptZodOptions, untypedOptionValues),
        );
    }
}
