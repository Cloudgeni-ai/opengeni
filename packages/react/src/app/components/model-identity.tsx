/**
 * How a model looks everywhere outside the Models settings page: its clean
 * display name and its maker's logo. The canonical pieces live in
 * `@opengeni/react` (`ModelName`, `ModelMark`, `modelDisplayName`); this module
 * adds the console's logo tile and payer hint so every page reuses one source.
 *
 * Never render a raw catalog id, routing prefix or connection scope next to a
 * model outside Models settings.
 */
import { ModelMark, modelHasMark } from "../../components/model-mark";
import { modelDisplayName, type ModelDisplayInput } from "@opengeni/sdk/model-display";

import { LogoTile, type LogoTileSize } from "../../ui/logo-tile";

export { ModelMark, ModelName, modelHasMark } from "../../components/model-mark";
export { modelDisplayName, modelVendor } from "@opengeni/sdk/model-display";
export type { ModelDisplayInput } from "@opengeni/sdk/model-display";
export { modelPayerHint } from "../lib/model-payer";

/** The maker's logo on the shared tile; a monogram when the maker has no logo. */
export function ModelTile({
  model,
  size,
}: {
  model: ModelDisplayInput;
  size?: LogoTileSize | undefined;
}) {
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
