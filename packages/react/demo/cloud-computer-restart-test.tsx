import { createRoot } from "react-dom/client";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline } from "@opengeni/react";
import { MessageTimeline } from "@opengeni/react/session-ui";
import "../../../apps/web/src/styles.css";
import { createOpenGeniText } from "../src/messages/runtime";

const englishText = createOpenGeniText();

/*
 * A command that was in flight when the chat's own cloud computer (a compute
 * box) restarted, replayed through the production MessageTimeline with the
 * web app's stylesheet. Synthetic events in the worker's exact shapes, no API
 * calls. `?copy=before` shows the old "[connected machine]" receipt,
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

const BEFORE = [
  "[connected machine] the machine is unreachable",
  "What happened: the enrolled machine did not respond; it appears offline (control code ERROR_CODE_AGENT_OFFLINE).",
  "Which layer: the machine link — the machine itself, not your command",
  "What was preserved: unknown — the link dropped and the command may or may not have run.",
  "What to try: check the machine, and check whether the command already took effect before re-running it.",
].join("\n");

const AFTER = [
  "[cloud computer] the cloud computer this chat runs on stopped answering; it is most likely restarting",
  "What happened: the cloud computer this chat runs on did not answer, most likely because it is restarting (control code ERROR_CODE_AGENT_OFFLINE).",
  "Which layer: the cloud computer itself, not your command",
  "What was preserved: unknown — the command was in flight when the cloud computer stopped answering, so it may not have run, or may have run fully or partly.",
  "What to try: once the cloud computer is back (usually within seconds), check whether a command that changes state took effect, fully or partly, before re-running it; programs started earlier may have stopped.",
].join("\n");

const SESSION = "cloud-computer-restart";
const TURN = "turn-1";
let sequence = 0;
const start = Date.now() - 40_000;
function event(type: string, payload: unknown, at: number, turnId: string | null = TURN) {
  sequence += 1;
  return {
    id: `cloud-computer-restart-${sequence}`,
    workspaceId: "demo",
    sessionId: SESSION,
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(start + at * 1000).toISOString(),
  } as SessionEvent;
}

const events: SessionEvent[] = [
  event("user.message", { text: "List the tools you can call from the shell." }, 0, null),
  event("turn.started", {}, 1),
  event(
    "agent.toolCall.created",
    { id: "call-1", name: "exec_command", arguments: { cmd: "ogtool list" } },
    2,
  ),
  event("agent.toolCall.output", { id: "call-1", output: before ? BEFORE : AFTER }, 9),
];

const items = buildTimeline(englishText, events);

function Conversation() {
  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="min-h-0 min-w-0 flex-1">
        <MessageTimeline
          className="h-full"
          items={items}
          events={events}
          status="running"
          turnSummary={{ rolling: true }}
        />
      </div>
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
