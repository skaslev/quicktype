import type { RenderContext } from "../../Renderer.js";
import {
    BooleanOption,
    EnumOption,
    StringOption,
    getOptionValues,
} from "../../RendererOptions/index.js";
import { TargetLanguage } from "../../TargetLanguage.js";
import type { TupleSupport } from "../../Type/Type.js";
import type { LanguageName, RendererOptions } from "../../types.js";

import { HaskellRenderer } from "./HaskellRenderer.js";

export const haskellOptions = {
    justTypes: new BooleanOption("just-types", "Plain types only", false),
    useList: new EnumOption(
        "array-type",
        "Use Array or List",
        {
            array: false,
            list: true,
        } as const,
        "list",
    ),
    moduleName: new StringOption(
        "module",
        "Generated module name",
        "NAME",
        "QuickType",
    ),
};

export const haskellLanguageConfig = {
    displayName: "Haskell",
    names: ["haskell"],
    extension: "haskell",
} as const;

export class HaskellTargetLanguage extends TargetLanguage<
    typeof haskellLanguageConfig
> {
    public constructor() {
        super(haskellLanguageConfig);
    }

    public getOptions(): typeof haskellOptions {
        return haskellOptions;
    }

    public get supportsOptionalClassProperties(): boolean {
        return true;
    }

    public get supportsUnionsWithBothNumberTypes(): boolean {
        return true;
    }

    // aeson (de)serializes tuples as arrays of exactly their length;
    // tuples with optional items or a rest are data types with instances of
    // their own.
    public get tupleSupport(): TupleSupport {
        return "full";
    }

    protected makeRenderer<Lang extends LanguageName = "haskell">(
        renderContext: RenderContext,
        untypedOptionValues: RendererOptions<Lang>,
    ): HaskellRenderer {
        return new HaskellRenderer(
            this,
            renderContext,
            getOptionValues(haskellOptions, untypedOptionValues),
        );
    }
}
