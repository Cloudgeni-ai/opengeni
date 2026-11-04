import { createRoot } from "react-dom/client";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline } from "@opengeni/react";
import { MessageTimeline } from "@opengeni/react/session-ui";
import { ModelRecoveryNotice } from "../src/app/components/session/model-recovery-notice";
import { FailedSessionBanner } from "../src/app/components/session/failed-session-banner";
import { summarizeSessionFailure } from "../src/app/lib/events";
import { currentProviderRecovery } from "../src/lib/provider-recovery";
import { timelineShowsFailure } from "../src/app/lib/timeline-failure-owner";
import "../../../apps/web/src/styles.css";
import { createOpenGeniText } from "../src/messages/runtime";

const englishText = createOpenGeniText();

/*
 * A Connected Machine with no shell left (its /bin/sh was moved away and no
 * dash or bash remains), replayed through the production MessageTimeline and
 * the failed-session banner, composed as the session route composes them,
 * with the web app's stylesheet. Synthetic events in the worker's exact
 * shapes, no API calls. `?copy=before` shows the copy before this change.
 * `?theme=light|dark`, `?desktop=macos` (the desktop shell's platform
 * attribute, inside a macOS window frame).
 */

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const before = params.get("copy") === "before";
const desktop = params.get("desktop") === "macos";
document.documentElement.dataset.ogTheme = theme;
document.documentElement.classList.toggle("dark", theme === "dark");
if (desktop) document.documentElement.dataset.desktop = "macos";

const SESSION = "missing-shell";
const TURN = "turn-1";
let sequence = 0;
const start = Date.now() - 40_000;
function event(type: string, payload: unknown, at: number, turnId: string | null = TURN) {
  sequence += 1;
  return {
    id: `missing-shell-${sequence}`,
    workspaceId: "demo",
    sessionId: SESSION,
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(start + at * 1000).toISOString(),
  } as SessionEvent;
}

// Before this change the runtime did not know the agent's missing-shell note,
// so it kept only "a shell command" and showed the generic copy.
const AGENT_TEXT = before
  ? "not found: spawn or apply execution containment for a shell command: No such file or directory (os error 2)"
  : 'not found: spawn or apply execution containment for program "/bin/sh" (the shell /bin/sh is missing and no dash or bash was found): No such file or directory (os error 2)';
const COPY = before
  ? "Your connected machine can't start programs. Restart the machine, then retry."
  : "Your connected machine can't start programs because the shell /bin/sh is missing and no dash or bash was found. Put /bin/sh back on the machine, then retry.";

const events: SessionEvent[] = [
  event("user.message", { text: "Run the test suite on my machine and tell me what fails." }, 0, null),
  event("turn.started", {}, 1),
  event("turn.startup.phase.started", { phase: "credential_seed" }, 1),
  event(
    "turn.startup.phase.failed",
    { phase: "credential_seed", durationMs: 143, expectedTransition: false },
    1.2,
  ),
  event(
    "turn.failed",
    { error: COPY, code: "sandbox_process_start_failed", retryable: false, detail: AGENT_TEXT },
    1.3,
  ),
];

const items = buildTimeline(englishText, events);
const recovery = currentProviderRecovery(
  { id: SESSION, status: "failed", activeTurnId: null },
  events,
);
const failedEvent = events.at(-1)!;
const failure = summarizeSessionFailure(events, "failed");

function Conversation() {
  const banner = failure ? (
    <FailedSessionBanner
      failure={failure}
      shownInTimeline={timelineShowsFailure(items, {
        failureEventId: failedEvent.id,
        turnId: failedEvent.turnId,
      })}
      actions={{ failureId: failedEvent.id, retryBlocker: null, onRetry: async () => false }}
    />
  ) : null;
  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="min-h-0 min-w-0 flex-1">
        <MessageTimeline
          className="h-full"
          items={items}
          events={events}
          status="failed"
          turnSummary={{ rolling: true }}
          trailingState={banner}
          emptyState={banner}
        />
      </div>
      {recovery ? <ModelRecoveryNotice recovery={recovery} /> : null}
    </div>
  );
}

function App() {
  if (!desktop) {
    return (
      <div className="h-screen">
        <Conversation />
      </div>
    );
  }
  // Preview-only frame: the desktop shell draws the window and its controls.
  return (
    <div className="flex h-screen items-center justify-center bg-surface-2 p-8">
      <div className="relative flex h-[680px] w-[1100px] flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 px-4">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="min-h-0 flex-1">
          <Conversation />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
