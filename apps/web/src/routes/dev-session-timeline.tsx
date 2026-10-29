// DEV-only reference harness: the production MessageTimeline replaying deterministic
// session scenarios, so native renderers can be compared against web at phone width.
// Open: http://127.0.0.1:3000/dev/session-timeline?scenario=working (add &bare=1 for a
// frameless 390px stage, used by automated screenshots).
import { InteractiveAnswerProvider, MessageTimeline } from "@opengeni/react";
import { ChatInteractiveBlock, type SiteSnapshotClient } from "@opengeni/react/artifacts";
import { labScenarios, type LabScenarioId } from "@opengeni/react/testing";
import { useCallback, useMemo } from "react";

import { PhoneFrame } from "./composer-chrome/phone-frame";

function param(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

// The lab has no workspace: inline HTML previews render as in the app, and a
// Site reference shows the preview's own "could not load" state.
const noSites: SiteSnapshotClient = {
  getWorkspaceArtifact: () => Promise.reject(new Error("The lab has no Sites")),
  getWorkspaceArtifactHtml: () => Promise.reject(new Error("The lab has no Sites")),
};

const labSend = async () => true;

export function DevSessionTimelineRoute() {
  const scenarios = useMemo(() => labScenarios(), []);
  const id = (param("scenario") ?? "working") as LabScenarioId;
  const scenario = scenarios.find((entry) => entry.id === id) ?? scenarios[0]!;
  // Like the app's chat, so web and phone shots compare the same thing.
  const renderInteractiveBlock = useCallback(
    (block: { kind: "html" | "site"; content: string }) => (
      <ChatInteractiveBlock workspaceId="lab" client={noSites} {...block} />
    ),
    [],
  );
  const timeline = (
    // Picks in interactive answers "send" without leaving the lab.
    <InteractiveAnswerProvider send={labSend} scope={`lab-${scenario.id}`}>
      <MessageTimeline
        className="h-full"
        events={scenario.events}
        key={scenario.id}
        renderInteractiveBlock={renderInteractiveBlock}
        status={scenario.running ? "running" : "idle"}
        turnSummary={{ rolling: true }}
      />
    </InteractiveAnswerProvider>
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
