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
 * A compute workspace machine that can no longer start programs (its
 * /dev/null was removed), replayed through the production MessageTimeline,
 * the live recovery notice and the failed-session banner, composed as the
 * session route composes them, with the web app's stylesheet. Synthetic
 * events in the worker's exact shapes, no API calls.
 * `?state=restarting|stopped`, `?theme=light|dark`, `?desktop=macos` (the
 * desktop shell's platform attribute, inside a macOS window frame).
 * `?machine=modal`: a Modal box whose /bin/sh was removed. It is replaced
 * with a fresh box restored from the saved /workspace (`restarting`), or its
 * files could not be saved yet and the turn stops (`stopped`).
 * `?call=waiting|started` (Modal): the model's command when the replacement
 * began. A command still waiting for the box settles as not started; one that
 * had reached the box keeps its unknown outcome.
 */

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const stopped = params.get("state") === "stopped";
const desktop = params.get("desktop") === "macos";
const modal = params.get("machine") === "modal";
const call = params.get("call");
document.documentElement.dataset.ogTheme = theme;
document.documentElement.classList.toggle("dark", theme === "dark");
if (desktop) document.documentElement.dataset.desktop = "macos";

const SESSION = "process-start";
const TURN = "turn-1";
let sequence = 0;
const start = Date.now() - 40_000;
function event(type: string, payload: unknown, at: number, turnId: string | null = TURN) {
  sequence += 1;
  return {
    id: `process-start-${sequence}`,
    workspaceId: "demo",
    sessionId: SESSION,
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(start + at * 1000).toISOString(),
  } as SessionEvent;
}

const RESTART = "sandbox.process_start_restart";
const AGENT_TEXT =
  "not found: start the program for a shell command: No such file or directory (os error 2); /dev/null is missing";

const computeEvents: SessionEvent[] = [
  event(
    "user.message",
    {
      text: "Okay can we build what you said about making a tool that the agents have access to for Opengeni and then we make the read replica only accessible from within our network?",
    },
    0,
    null,
  ),
  event("turn.started", {}, 1),
  event("turn.startup.phase.started", { phase: "credential_seed" }, 1),
  event(
    "turn.startup.phase.failed",
    { phase: "credential_seed", durationMs: 188, expectedTransition: false },
    1.2,
  ),
  event("sandbox.operation.started", { name: RESTART, reason: "process_start_failed" }, 1.3),
  event("sandbox.operation.completed", { name: RESTART }, 6),
  event(
    "turn.recovery.requested",
    {
      error:
        "The workspace machine couldn't start programs, so it was restarted. Your files are kept; programs that were running stopped. The same turn continues once it is back.",
      code: "sandbox_machine_restarting",
      retryable: true,
      providerRecoveryCount: 1,
      maxProviderRecoveryCount: 5,
    },
    6,
  ),
];
if (stopped && !modal) {
  computeEvents.push(
    event("turn.started", {}, 9),
    event("turn.startup.phase.started", { phase: "credential_seed" }, 9),
    event(
      "turn.startup.phase.failed",
      { phase: "credential_seed", durationMs: 201, expectedTransition: false },
      9.2,
    ),
    event(
      "turn.failed",
      {
        error:
          "The workspace machine still can't start programs after it was restarted, so this turn stopped. Retry once more, or start a new chat if it keeps failing.",
        code: "sandbox_process_start_failed",
        retryable: false,
        detail: AGENT_TEXT,
      },
      9.3,
    ),
  );
}

const MODAL_AGENT_TEXT =
  "Modal could not start the sandbox shell: failed to load /bin/sh: no such file or directory";
const MODAL_GROUP = "group-demo";
const CALL = "call-tests";

const withCall = call === "waiting" || call === "started";

// Built in place so sequences follow the timeline: the model's command, then
// the restart, then the settlement's exact `agent.toolCall.output`.
const callCreated = (): SessionEvent[] =>
  withCall
    ? [
        event(
          "agent.toolCall.created",
          { id: CALL, name: "exec_command", arguments: { cmd: "bun test" } },
          1.1,
        ),
      ]
    : [];
const callSettled = (): SessionEvent[] =>
  withCall
    ? [
        event(
          "agent.toolCall.output",
          call === "waiting"
            ? {
                id: CALL,
                output: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "The command was not started because the workspace machine was not ready. Nothing ran, so it is safe to run again.",
                    },
                  ],
                },
                recovery: {
                  interrupted: true,
                  outcome: "not_started",
                  reason: "sandbox_lifecycle_transition",
                  unsupportedCallShape: false,
                },
              }
            : {
                id: CALL,
                output: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "Tool execution was interrupted by sandbox_lifecycle_transition; its side-effect outcome is unknown.",
                    },
                  ],
                },
                recovery: {
                  interrupted: true,
                  outcome: "unknown",
                  reason: "sandbox_lifecycle_transition",
                  unsupportedCallShape: false,
                },
              },
          1.4,
        ),
      ]
    : [];

const modalEvents: SessionEvent[] = [
  event(
    "user.message",
    {
      text: "Okay can we build what you said about making a tool that the agents have access to for Opengeni and then we make the read replica only accessible from within our network?",
    },
    0,
    null,
  ),
  event("turn.started", {}, 1),
  ...callCreated(),
  event(
    "sandbox.operation.started",
    {
      name: RESTART,
      reason: "process_start_failed",
      sandboxGroupId: MODAL_GROUP,
      leaseEpoch: 6,
    },
    1.3,
  ),
  ...callSettled(),
  // Not completed: the drain replaces the box, and the row settles with the turn.
  event(
    "turn.recovery.requested",
    {
      sandboxGroupId: MODAL_GROUP,
      leaseEpoch: 6,
      rotationReason: "operator",
      transitionReason: "rotation_in_progress",
      reason: "sandbox_lifecycle_transition",
    },
    1.5,
  ),
];
if (stopped && modal) {
  modalEvents.push(
    event("turn.started", {}, 30),
    event(
      "turn.failed",
      {
        error:
          "The workspace machine can't start programs and its files couldn't be saved yet. Opengeni will replace it once they're saved; retry then.",
        code: "sandbox_process_start_failed",
        retryable: false,
        detail: MODAL_AGENT_TEXT,
      },
      30.2,
    ),
  );
}

const events = modal ? modalEvents : computeEvents;

const status = stopped ? "failed" : "recovering";
const items = buildTimeline(englishText, events);
const recovery = currentProviderRecovery(
  { id: SESSION, status, activeTurnId: stopped ? null : TURN },
  events,
);
const failedEvent = events.at(-1)!;
const failure = stopped ? summarizeSessionFailure(events, "failed") : null;

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
          status={stopped ? "failed" : "running"}
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
