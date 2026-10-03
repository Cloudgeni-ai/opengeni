/**
 * How a model looks everywhere outside the Models settings page: its clean
 * display name and its maker's logo. The canonical pieces live in
 * `@opengeni/react` (`ModelName`, `ModelMark`, `modelDisplayName`); this module
 * adds the console's logo tile and payer hint so every page reuses one source.
 *
 * Never render a raw catalog id, routing prefix or connection scope next to a
 * model outside Models settings.
 */
import { ModelMark, modelDisplayName, modelHasMark, type ModelDisplayInput } from "@opengeni/react";

import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";

export { ModelMark, ModelName, modelDisplayName, modelHasMark, modelVendor } from "@opengeni/react";
export type { ModelDisplayInput } from "@opengeni/react";
export { modelPayerHint } from "@/lib/model-payer";

/** The maker's logo on the shared tile; a monogram when the maker has no logo. */
export function ModelTile({ model, size }: { model: ModelDisplayInput; size?: LogoTileSize }) {
  return (
    <LogoTile
      size={size}
      name={modelDisplayName(model)}
      icon={
        modelHasMark(model) ? <ModelMark model={model} className="size-full text-fg" /> : undefined
      }
    />
  );
}
