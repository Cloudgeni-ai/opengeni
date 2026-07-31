// DEV-only Session composer chrome gallery (tabbed).
// Open: http://127.0.0.1:3000/dev/composer-chrome
import { useMemo, useState } from "react";

import type { VariantId } from "./variant-meta";
import { tabLabel } from "./variant-meta";
import { BaselineVariant, variantMeta as baselineMeta } from "./variants/baseline";
import { Variant as V1, variantMeta as v1Meta } from "./variants/v1";
import { Variant as V2, variantMeta as v2Meta } from "./variants/v2";
import { Variant as V3, variantMeta as v3Meta } from "./variants/v3";
import { Variant as V4, variantMeta as v4Meta } from "./variants/v4";
import { Variant as V5, variantMeta as v5Meta } from "./variants/v5";
import { Variant as V6, variantMeta as v6Meta } from "./variants/v6";
import { Variant as V7, variantMeta as v7Meta } from "./variants/v7";
import { Variant as V8, variantMeta as v8Meta } from "./variants/v8";
import { Variant as V9, variantMeta as v9Meta } from "./variants/v9";
import { Variant as V10, variantMeta as v10Meta } from "./variants/v10";

const TABS = [
  { meta: baselineMeta, render: () => <BaselineVariant /> },
  { meta: v1Meta, render: () => <V1 /> },
  { meta: v2Meta, render: () => <V2 /> },
  { meta: v3Meta, render: () => <V3 /> },
  { meta: v4Meta, render: () => <V4 /> },
  { meta: v5Meta, render: () => <V5 /> },
  { meta: v6Meta, render: () => <V6 /> },
  { meta: v7Meta, render: () => <V7 /> },
  { meta: v8Meta, render: () => <V8 /> },
  { meta: v9Meta, render: () => <V9 /> },
  { meta: v10Meta, render: () => <V10 /> },
] as const;

export function ComposerChromeGalleryRoute() {
  const [activeId, setActiveId] = useState<VariantId>(0);
  const active = useMemo(
    () => TABS.find((tab) => tab.meta.id === activeId) ?? TABS[0],
    [activeId],
  );

  return (
    <main className="min-h-dvh overflow-y-auto bg-bg text-fg">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
        <header className="space-y-3">
          <p className="text-2xs font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Dev gallery · composer chrome
          </p>
          <h1 className="text-xl font-semibold tracking-tight">Session chrome gallery</h1>
          <p className="text-sm leading-relaxed text-fg-muted">
            Tabbed harness for production chrome (Baseline), reserved compact slots (tabs 1–5), and
            motion / liquid-glass / merge explorations (tabs 6–10). Every tab shows the full scenario
            matrix by default. ChatComposer stays the real production control.
          </p>
          <p className="text-sm leading-relaxed text-fg-muted">
            Tabs 1–5 stay compact-reserved. Tabs 6–10 explore clean+sleek motion, liquid glass, and
            merge treatments — not theatrical / CRT / sonar / stacked-instrument theater.
          </p>
          <code className="block rounded-lg border border-border bg-surface-2/60 px-3 py-2 font-mono text-xs text-fg-muted">
            http://127.0.0.1:3000/dev/composer-chrome
          </code>
          <div
            role="tablist"
            aria-label="Composer chrome variants"
            className="flex flex-wrap gap-1.5 border-b border-border pb-3"
          >
            {TABS.map((tab) => {
              const selected = tab.meta.id === activeId;
              return (
                <button
                  key={tab.meta.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  id={`composer-chrome-tab-${tab.meta.id}`}
                  className={
                    selected
                      ? "rounded-md bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-fg"
                      : "rounded-md px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-2/60 hover:text-fg"
                  }
                  onClick={() => setActiveId(tab.meta.id)}
                >
                  {tabLabel(tab.meta)}
                </button>
              );
            })}
          </div>
        </header>

        <div
          role="tabpanel"
          aria-labelledby={`composer-chrome-tab-${active.meta.id}`}
          data-variant={active.meta.id}
        >
          {active.render()}
        </div>
      </div>
    </main>
  );
}
