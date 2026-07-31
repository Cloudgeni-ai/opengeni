// Scenario matrix helpers for the DEV session-chrome harness.
import { useMemo } from "react";

import {
  chromeScenarios,
  type ChromeScenario,
  type ChromeScenarioId,
} from "@/dev/composer-chrome-fixtures";

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
