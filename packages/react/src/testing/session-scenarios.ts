// Deterministic session scenarios for visual harnesses (web dev gallery and native lab).
// They use the same durable event shapes a live session produces, so every renderer
// replays identical input through the official projection with no model calls.
import type { SessionEvent } from "@opengeni/sdk";

export type LabScenarioId = "answer" | "working" | "needs-you" | "history";

export interface LabScenario {
  id: LabScenarioId;
  title: string;
  events: SessionEvent[];
  /** Whether the session is currently running a turn. */
  running: boolean;
}

function recorder(sessionId: string) {
  const events: SessionEvent[] = [];
  let clock = Date.parse("2026-10-03T09:00:00Z");
  const push = (type: string, payload: unknown, turnId: string | null, advanceMs = 2_000) => {
    clock += advanceMs;
    events.push({
      id: `${sessionId}-evt-${events.length + 1}`,
      workspaceId: "lab-workspace",
      sessionId,
      sequence: events.length + 1,
      type,
      payload,
      turnId,
      occurredAt: new Date(clock).toISOString(),
    } as SessionEvent);
  };
  const tool = (
    turnId: string,
    id: string,
    name: string,
    args: unknown,
    output?: unknown,
    durationMs = 3_000,
  ) => {
    push("agent.toolCall.created", { id, name, arguments: args }, turnId, 800);
    if (output !== undefined) push("agent.toolCall.output", { id, output }, turnId, durationMs);
  };
  return { events, push, tool };
}

function answer(): LabScenario {
  const r = recorder("lab-answer");
  const t = "turn-answer";
  r.push("user.message", { text: "What's the difference between a retry and a resume for a failed run?" }, t);
  r.push("turn.started", {}, t, 400);
  r.push("agent.reasoning.delta", { text: "The user wants a crisp conceptual distinction, with an example." }, t, 1_500);
  const text = [
    "**Retry** starts the failed step again from its last durable checkpoint. **Resume** continues the whole run from where it paused, keeping everything already done.",
    "",
    "### When to use which",
    "",
    "- **Retry** when a single step failed for a transient reason (timeout, rate limit).",
    "- **Resume** when the run was *waiting* — for an approval, an answer, or capacity.",
    "",
    "```bash",
    "opengeni sessions retry 7f3c --step build",
    "```",
    "",
    "Neither replays side effects that already succeeded.",
  ].join("\n");
  r.push("agent.message.delta", { text }, t, 2_500);
  r.push("agent.message.completed", { text }, t, 300);
  r.push("turn.completed", { output: text }, t, 200);
  return { id: "answer", title: "Quick answer", events: r.events, running: false };
}

function working(): LabScenario {
  const r = recorder("lab-working");
  const t = "turn-working";
  r.push("user.message", { text: "The checkout tests started failing after the currency change. Can you find out why and fix it?" }, t);
  r.push("turn.started", {}, t, 400);
  r.push("agent.reasoning.delta", { text: "Start by reproducing the failure, then narrow to the currency formatting path." }, t, 1_800);
  r.tool(t, "c1", "exec_command", { cmd: "bun test checkout" }, "3 failed, 41 passed\n✗ formats totals in NOK\n✗ rounds VAT per line\n✗ shows discount", 6_000);
  r.tool(t, "c2", "search_files", { query: "formatCurrency(" }, "src/money/format.ts:12\nsrc/checkout/summary.tsx:48\nsrc/checkout/line.tsx:31");
  r.push("agent.message.delta", { text: "Found it: the currency change switched to minor units, but the summary still divides by 100.", phase: "commentary" }, t, 1_200);
  r.push("agent.message.completed", { text: "Found it: the currency change switched to minor units, but the summary still divides by 100.", phase: "commentary" }, t, 200);
  r.tool(t, "c3", "apply_patch", { path: "src/checkout/summary.tsx" }, "Updated 1 file (+3 −5)");
  r.tool(t, "c4", "exec_command", { cmd: "bun test checkout" });
  return { id: "working", title: "Working", events: r.events, running: true };
}

function needsYou(): LabScenario {
  const r = recorder("lab-needs-you");
  const t = "turn-needs-you";
  r.push("user.message", { text: "Ship the fix to the preview environment and tell the team." }, t);
  r.push("turn.started", {}, t, 400);
  r.tool(t, "n1", "exec_command", { cmd: "bun run build" }, "Build completed in 41s", 8_000);
  r.tool(t, "n2", "list_channels", { query: "release" }, "#releases, #release-ops");
  r.push("agent.toolCall.created", { id: "n3", name: "deploy_preview", arguments: { environment: "preview", ref: "fix/checkout-minor-units" } }, t, 900);
  r.push(
    "session.requiresAction",
    {
      approvals: [
        {
          id: "n3",
          name: "deploy_preview",
          arguments: { environment: "preview", ref: "fix/checkout-minor-units" },
        },
      ],
    },
    t,
    300,
  );
  r.push(
    "session.humanInput.requested",
    {
      request: {
        id: "hi-1",
        allowSkip: true,
        questions: [
          {
            id: "channel",
            kind: "single_select",
            prompt: "Where should I announce the preview?",
            label: "Announcement",
            required: true,
            options: [
              { id: "releases", label: "#releases", description: "Team-wide release notes" },
              { id: "release-ops", label: "#release-ops", description: "Operators only" },
            ],
          },
        ],
      },
    },
    t,
    300,
  );
  return { id: "needs-you", title: "Needs you", events: r.events, running: true };
}

function history(): LabScenario {
  const r = recorder("lab-history");
  const a = "turn-h1";
  r.push("user.message", { text: "Summarise yesterday's support tickets." }, a);
  r.push("turn.started", {}, a, 400);
  r.tool(a, "h1", "search_tickets", { since: "yesterday" }, "38 tickets", 4_000);
  r.tool(a, "h2", "read_ticket", { id: "T-1182" }, "Customer cannot export invoices to PDF");
  r.tool(a, "h3", "read_ticket", { id: "T-1190" }, "Login loop on Android 15");
  const summary =
    "38 tickets yesterday. The two themes:\n\n1. **PDF export** fails for invoices with attachments (11 tickets).\n2. **Android login loop** after the last release (7 tickets).\n\nEverything else was routine.";
  r.push("agent.message.delta", { text: summary }, a, 2_000);
  r.push("agent.message.completed", { text: summary }, a, 200);
  r.push("turn.completed", { output: summary }, a, 200);
  const b = "turn-h2";
  r.push("user.message", { text: "Open an issue for the Android one and assign it to mobile." }, b, 60_000);
  r.push("turn.started", {}, b, 400);
  r.tool(b, "h4", "create_issue", { title: "Android login loop after release", team: "mobile" }, "Error: tracker token expired", 2_000);
  r.push("turn.failed", { error: "The issue tracker connection needs to be reauthorized." }, b, 400);
  const c = "turn-h3";
  r.push("user.message", { text: "Reconnected. Try again." }, c, 30_000);
  r.push("turn.started", {}, c, 400);
  r.tool(c, "h5", "create_issue", { title: "Android login loop after release", team: "mobile" }, "Created MOB-412", 2_000);
  const done = "Created **MOB-412** and assigned it to the mobile team.";
  r.push("agent.message.delta", { text: done }, c, 1_000);
  r.push("agent.message.completed", { text: done }, c, 200);
  r.push("turn.completed", { output: done }, c, 200);
  return { id: "history", title: "History", events: r.events, running: false };
}

export function labScenarios(): LabScenario[] {
  return [answer(), working(), needsYou(), history()];
}