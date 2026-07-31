// Full scenario matrix for the DEV gallery — all fixtures visible by default.
import type { ComposerState } from "@opengeni/react";
import { useMemo, useState, type ReactNode } from "react";

import {
  chromeScenarios,
  type ChromeScenario,
  type ChromeScenarioId,
} from "@/dev/composer-chrome-fixtures";

import { ScenarioStack } from "./scenario-stack";

export function useGalleryScenarios() {
  return useMemo(() => chromeScenarios(), []);
}

export function ScenarioFilter({
  scenarios,
  filter,
  onChange,
}: {
  scenarios: ChromeScenario[];
  filter: "all" | ChromeScenarioId;
  onChange: (value: "all" | ChromeScenarioId) => void;
}) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      <span>Filter</span>
      <select
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-fg"
        value={filter}
        onChange={(event) => onChange(event.target.value as "all" | ChromeScenarioId)}
      >
        <option value="all">All scenarios</option>
        {scenarios.map((scenario) => (
          <option key={scenario.id} value={scenario.id}>
            {scenario.title}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ScenarioMatrix({
  composer,
  filter = "all",
}: {
  composer: ComposerState;
  filter?: "all" | ChromeScenarioId;
}) {
  const scenarios = useGalleryScenarios();
  const visible = filter === "all" ? scenarios : scenarios.filter((row) => row.id === filter);

  return (
    <div className="flex flex-col gap-10">
      {visible.map((scenario, index) => (
        <section
          key={scenario.id}
          aria-labelledby={`gallery-scenario-${scenario.id}`}
          className="overflow-hidden rounded-xl border border-border bg-surface/30"
        >
          <header className="space-y-1 border-b border-border bg-surface-2/50 px-4 py-3 sm:px-5">
            <p className="text-2xs font-medium uppercase tracking-[0.14em] text-fg-subtle">
              Scenario {index + 1}
              <span className="mx-1.5 text-border">·</span>
              <span className="font-mono normal-case tracking-normal text-fg-muted">{scenario.id}</span>
            </p>
            <h2 id={`gallery-scenario-${scenario.id}`} className="text-sm font-semibold text-fg">
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
  );
}

/** Baseline / stub shell: all scenarios + optional secondary filter. */
export function ScenarioMatrixPanel({
  composer,
  intro,
}: {
  composer: ComposerState;
  intro?: ReactNode;
}) {
  const scenarios = useGalleryScenarios();
  const [filter, setFilter] = useState<"all" | ChromeScenarioId>("all");

  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-3">
        {intro}
        <ScenarioFilter scenarios={scenarios} filter={filter} onChange={setFilter} />
      </header>
      <ScenarioMatrix composer={composer} filter={filter} />
    </div>
  );
}
