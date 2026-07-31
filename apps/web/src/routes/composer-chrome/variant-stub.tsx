// Thin placeholder for reserved gallery tabs (compact 1–5, motion/glass 6–10).
// Shows the full scenario matrix with production ChatComposer; chrome redesign TBD.
import { useMemo } from "react";

import { idleComposer } from "@/dev/composer-chrome-fixtures";

import { ScenarioMatrixPanel } from "./scenario-matrix";
import type { VariantMeta } from "./variant-meta";
import { tabLabel } from "./variant-meta";

const DEFAULT_NOTE =
  "Radical variants were discarded. Next pass should restyle chrome above the composer only: much more compact vertically, super clean/sleek, very informative, nice hover effects, easy access to user actions — not theatrical / CRT / sonar / stacked-instrument theater. ChatComposer and QueueSurface stay production.";

export function VariantStub({ meta, note = DEFAULT_NOTE }: { meta: VariantMeta; note?: string }) {
  const composer = useMemo(() => idleComposer(), []);

  return (
    <ScenarioMatrixPanel
      composer={composer}
      intro={
        <div className="rounded-xl border border-dashed border-border bg-surface-2/40 px-4 py-5">
          <p className="text-sm font-medium text-fg">{tabLabel(meta)} — awaiting next iteration</p>
          <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{note}</p>
        </div>
      }
    />
  );
}
