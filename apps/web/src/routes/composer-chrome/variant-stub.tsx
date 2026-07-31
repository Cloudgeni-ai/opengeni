// Thin placeholder for reserved gallery tabs (compact 2–5).
// Intentionally reuses production ScenarioMatrix / Baseline chrome until a compact redesign lands.
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
        <div
          role="status"
          className="rounded-xl border-2 border-amber-500/50 bg-amber-500/10 px-4 py-4 sm:px-5"
        >
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
            Placeholder · not a failed variant
          </p>
          <p className="mt-1.5 text-sm font-semibold text-fg">
            {tabLabel(meta)} — awaiting compact iteration
          </p>
          <p className="mt-1 text-sm leading-relaxed text-fg">
            Same chrome as Baseline for now. Scenarios below are production chrome reused as a
            reserved slot until a real Compact design lands.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-fg-muted">{note}</p>
        </div>
      }
    />
  );
}
