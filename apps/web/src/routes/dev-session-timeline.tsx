// DEV-only reference harness: the production MessageTimeline replaying deterministic
// session scenarios, so native renderers can be compared against web at phone width.
// Open: http://127.0.0.1:3000/dev/session-timeline?scenario=working (add &bare=1 for a
// frameless 390px stage, used by automated screenshots).
import { MessageTimeline } from "@opengeni/react";
import { labScenarios, type LabScenarioId } from "@opengeni/react/testing";
import { useMemo } from "react";

import { PhoneFrame } from "./composer-chrome/phone-frame";

function param(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

export function DevSessionTimelineRoute() {
  const scenarios = useMemo(() => labScenarios(), []);
  const id = (param("scenario") ?? "working") as LabScenarioId;
  const scenario = scenarios.find((entry) => entry.id === id) ?? scenarios[0]!;
  const timeline = (
    <MessageTimeline
      className="h-full"
      events={scenario.events}
      key={scenario.id}
      status={scenario.running ? "running" : "idle"}
      turnSummary={{ rolling: true }}
    />
  );
  if (param("bare") === "1") {
    return <main className="h-dvh w-full overflow-hidden bg-bg text-fg">{timeline}</main>;
  }
  return (
    <main className="min-h-dvh overflow-y-auto bg-bg py-6 text-fg">
      <nav className="mb-4 flex justify-center gap-2 text-xs">
        {scenarios.map((entry) => (
          <a
            className={entry.id === scenario.id ? "font-semibold text-fg" : "text-fg-muted"}
            href={`?scenario=${entry.id}`}
            key={entry.id}
          >
            {entry.title}
          </a>
        ))}
      </nav>
      <PhoneFrame>{timeline}</PhoneFrame>
    </main>
  );
}