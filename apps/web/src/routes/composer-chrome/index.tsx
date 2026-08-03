// DEV-only session chrome harness for the production SessionChrome dock.
// Open: http://127.0.0.1:3000/dev/composer-chrome
import { useMemo, useState } from "react";

import { idleComposer, type ChromeScenarioId } from "@/dev/composer-chrome-fixtures";

import { ScenarioFilter, useGalleryScenarios } from "./scenario-matrix";
import { ScenarioStack } from "./scenario-stack";

export function ComposerChromeGalleryRoute() {
  const composer = useMemo(() => idleComposer(), []);
  const scenarios = useGalleryScenarios();
  const [filter, setFilter] = useState<"all" | ChromeScenarioId>("all");
  const visible = filter === "all" ? scenarios : scenarios.filter((row) => row.id === filter);

  return (
    <main className="min-h-dvh overflow-y-auto bg-bg text-fg">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
        <header className="space-y-3">
          <p className="text-2xs font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Dev harness · session chrome
          </p>
          <h1 className="text-xl font-semibold tracking-tight">Session chrome</h1>
          <p className="text-sm leading-relaxed text-fg-muted">
            Scenario matrix for the production{" "}
            <code className="font-mono text-xs text-fg">SessionChrome</code> dock (incoming, queue,
            goal, agents) above the stock ChatComposer.
          </p>
          <code className="block rounded-lg border border-border bg-surface-2/60 px-3 py-2 font-mono text-xs text-fg-muted">
            http://127.0.0.1:3000/dev/composer-chrome
          </code>
          <ScenarioFilter scenarios={scenarios} filter={filter} onChange={setFilter} />
        </header>

        <div className="flex flex-col gap-10" data-session-chrome-harness="">
          {visible.map((scenario, index) => (
            <section
              key={scenario.id}
              aria-labelledby={`session-chrome-scenario-${scenario.id}`}
              className="overflow-hidden rounded-xl border border-border bg-surface/30"
            >
              <header className="space-y-1 border-b border-border bg-surface-2/50 px-4 py-3 sm:px-5">
                <p className="text-2xs font-medium uppercase tracking-[0.14em] text-fg-subtle">
                  Scenario {index + 1}
                  <span className="mx-1.5 text-border">·</span>
                  <span className="font-mono normal-case tracking-normal text-fg-muted">
                    {scenario.id}
                  </span>
                </p>
                <h2
                  id={`session-chrome-scenario-${scenario.id}`}
                  className="text-sm font-semibold text-fg"
                >
                  {scenario.title}
                </h2>
                <p className="text-xs text-fg-muted">{scenario.description}</p>
              </header>
              <div className="p-3 sm:p-4">
                <ScenarioStack scenario={scenario} composer={composer} />
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
