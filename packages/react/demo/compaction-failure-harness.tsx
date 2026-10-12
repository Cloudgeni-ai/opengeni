import { createRoot } from "react-dom/client";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline } from "@opengeni/react/session-ui";
// @ts-expect-error -- dev-only: the demo Vite alias resolves this to the web app's source.
import { FailedSessionBanner } from "@/components/session/failed-session-banner";
import "../../../apps/web/src/styles.css";

/*
 * A turn whose automatic compaction the model provider rejected, replayed
 * through the production MessageTimeline and the console's failed-session
 * banner with the web app's stylesheet. Synthetic events only, no API calls.
 * `?theme=light|dark` picks the theme the way the console's index.html does.
 */

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.ogTheme = theme;
document.documentElement.classList.toggle("dark", theme === "dark");

const RECORDED =
  "compaction summarization failed: 400 Missing required parameter: 'input[116].status'. " +
  "{'error': {'message': \"Missing required parameter: 'input[116].status'.\", " +
  "'type': 'invalid_request_error', 'param': 'input[116].status', 'code': 'missing_required_parameter'}}";

const REJECTION = {
  httpStatus: 400,
  type: "invalid_request_error",
  code: "missing_required_parameter",
  param: "input[116].status",
  requestId: "req_9c1e4b7a0f2d4e18b3a6c5d7e8f90a1b",
};

let sequence = 0;
const start = Date.now() - 90_000;
function event(type: string, payload: unknown, turnId: string | null, at: number): SessionEvent {
  sequence += 1;
  return {
    id: `compaction-failure-${sequence}`,
    workspaceId: "demo",
    sessionId: "compaction-failure",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(start + at * 1000).toISOString(),
  };
}

const events: SessionEvent[] = [
  event("user.message", { text: "Keep going with the remaining pull requests." }, null, 0),
  event("turn.started", {}, "turn-1", 1),
  event("turn.startup.phase.started", { phase: "model_preparation" }, "turn-1", 1),
  event("session.context.compaction.started", { trigger: "auto" }, "turn-1", 2),
  event(
    "session.context.compaction.skipped",
    { trigger: "auto", reason: "summarization_failed", providerRejection: REJECTION },
    "turn-1",
    9,
  ),
  event(
    "turn.startup.phase.failed",
    { phase: "model_preparation", durationMs: 8_400, expectedTransition: false },
    "turn-1",
    9,
  ),
  event(
    "turn.failed",
    {
      error: RECORDED,
      code: "context_compaction_failed",
      retryable: false,
      recovery: "user_message",
      compacted: false,
      providerRejection: REJECTION,
    },
    "turn-1",
    9,
  ),
];

function App() {
  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <div className="min-h-0 min-w-0 flex-1">
        <MessageTimeline
          className="h-full"
          events={events}
          status="failed"
          turnSummary={{ rolling: true }}
          trailingState={
            <FailedSessionBanner
              failure={{
                reason: RECORDED,
                recordedDetail: RECORDED,
                failureCode: "context_compaction_failed",
                failedAt: events.at(-1)!.occurredAt,
                consecutiveRecoveryCount: null,
              }}
            />
          }
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
