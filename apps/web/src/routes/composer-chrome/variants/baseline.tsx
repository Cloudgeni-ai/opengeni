// 0 · Baseline — faithful production chrome (existing harness).
import { useMemo } from "react";

import { idleComposer } from "@/dev/composer-chrome-fixtures";

import { ScenarioMatrixPanel } from "../scenario-matrix";
import type { VariantMeta } from "../variant-meta";

export const variantMeta: VariantMeta = {
  id: 0,
  name: "Baseline",
};

export function BaselineVariant() {
  const composer = useMemo(() => idleComposer(), []);

  return (
    <ScenarioMatrixPanel
      composer={composer}
      intro={
        <p className="text-sm text-fg-muted">
          Faithful reproduction of the stack above the composer using the real production components
          and mocked props. No redesign. All scenarios shown below; filter is optional.
        </p>
      }
    />
  );
}
