/* Embedded OpenGeniChat with fixture data inside a plain host product: the docs
   screenshots (docs-site/images/embedded-conversation*.png, captured by
   scripts/capture-embedded-conversation-screenshot.ts). Real components, the
   real timeline projection, and a scripted client; nothing is mocked in UI.

   The chat is mounted with zero styling, so it follows the host page:
   `?theme=dark` puts the host in dark mode (`class="dark"` on <html> and a dark
   page background), `&host=navy` uses a tinted dark palette, and
   `&scenario=` selects the conversation state (approval, question, running,
   long, empty, error). `&explicit=1` pins the legacy `data-og-theme` wrapper;
   `&hostile=1` adds global host element CSS. */
import { createRoot } from "react-dom/client";
import type { Session, SessionEvent, SessionQueueSnapshot } from "@opengeni/sdk";
import { OpenGeniChat, OpenGeniProvider } from "@opengeni/react";
import { fakeClient, WORKSPACE_ID } from "../test/fake-client";
import "@opengeni/react/compiled.css";

const SELECTED = "5a1c0000-0000-4000-8000-000000000001";
const TURN = "5a1c0000-0000-4000-8000-0000000000a1";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const host = params.get("host") === "navy" ? "navy" : "plain";
const scenario = params.get("scenario") ?? "approval";
const explicit = params.get("explicit") === "1";
// A host with global element CSS (as Django/Spectre-style apps ship): lists,
// paragraphs, buttons and line-height must not leak into the chat.
if (params.get("hostile") === "1") {
  const style = document.createElement("style");
  style.textContent = `
    body { line-height: 1.8; font-size: 16px; }
    ul { list-style: disc inside; margin: .8rem 0 .8rem .8rem; padding: 0 0 0 1rem; }
    ul li { margin-top: .4rem; }
    p { line-height: 1.8; margin: 0 0 1.2rem; }
    h2 { font-size: 2rem; margin: 1rem 0; }
    button { padding: 8px 12px; border-radius: 2px; }
  `;
  document.head.append(style);
}

function chat(id: string, title: string, minutes: number, status = "idle"): Session {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    title,
    titleSource: "agent",
    status,
    initialMessage: title,
    createdAt: minutesAgo(minutes + 5),
    updatedAt: minutesAgo(minutes),
  } as unknown as Session;
}

const selectedStatus =
  scenario === "running"
    ? "running"
    : scenario === "approval" || scenario === "question"
      ? "requires_action"
      : "idle";
const sessions: Session[] = [
  chat(SELECTED, "Double charge on ticket T-4821", 1, selectedStatus),
  chat("5a1c0000-0000-4000-8000-000000000002", "Weekly churn summary", 95),
  chat("5a1c0000-0000-4000-8000-000000000003", "Invoice export failing for Globex", 60 * 26),
  chat("5a1c0000-0000-4000-8000-000000000004", "Rewrite the onboarding email", 60 * 50),
  chat("5a1c0000-0000-4000-8000-000000000005", "Q3 enterprise renewals at risk", 60 * 24 * 6),
];

let sequence = 0;
const events: SessionEvent[] = [];
function push(type: string, payload: unknown, minutes: number, turnId: string | null = TURN) {
  sequence += 1;
  events.push({
    id: `evt-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SELECTED,
    sequence,
    type,
    payload,
    occurredAt: minutesAgo(minutes),
    turnId,
  } as SessionEvent);
}
const text = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

function investigation() {
  push("session.created", {}, 8, null);
  push(
    "user.message",
    {
      text: "Customer on T-4821 says they were charged twice in September. Can you check?",
    },
    8,
  );
  push("turn.started", {}, 8);
  push(
    "agent.toolCall.created",
    { id: "call-ticket", name: "acme__get_ticket", arguments: { ticketId: "T-4821" } },
    7,
  );
  push(
    "agent.toolCall.output",
    {
      id: "call-ticket",
      output: text({
        id: "T-4821",
        customer: { id: "cus_9Lk2", name: "Northwind Traders", plan: "Growth" },
        subject: "Charged twice for September",
        opened: "2026-09-28T09:14:00Z",
      }),
    },
    7,
  );
  push(
    "agent.toolCall.created",
    {
      id: "call-payments",
      name: "acme__list_payments",
      arguments: { customerId: "cus_9Lk2", since: "2026-09-01" },
    },
    7,
  );
  push(
    "agent.toolCall.output",
    {
      id: "call-payments",
      output: text([
        { id: "pay_71Qx", invoice: "INV-2026-09", amount: "$490.00", at: "2026-09-27T23:02:11Z" },
        { id: "pay_71Qy", invoice: "INV-2026-09", amount: "$490.00", at: "2026-09-27T23:02:14Z" },
      ]),
    },
    7,
  );
}

const finding = [
  "I checked the ticket and Northwind's payments. The customer is right: invoice **INV-2026-09** was charged twice, three seconds apart.",
  "",
  "| Payment | Amount | Time (UTC) |",
  "| --- | --- | --- |",
  "| pay_71Qx | $490.00 | Sep 27, 23:02:11 |",
  "| pay_71Qy | $490.00 | Sep 27, 23:02:14 |",
];

const humanInputRequests: unknown[] = [];

if (scenario === "approval") {
  investigation();
  push(
    "agent.message.completed",
    {
      phase: "final",
      text: [
        ...finding,
        "",
        "I'd like to refund the duplicate **pay_71Qy** and add a note to the ticket. Approve the refund below.",
      ].join("\n"),
    },
    6,
  );
  push(
    "session.requiresAction",
    {
      approvals: [
        {
          name: "acme__refund_payment",
          rawItem: {
            callId: "call-refund",
            name: "acme__refund_payment",
            arguments: { paymentId: "pay_71Qy", amount: "490.00", reason: "duplicate charge" },
          },
        },
      ],
    },
    6,
  );
  push("session.status.changed", { status: "requires_action" }, 6);
} else if (scenario === "question") {
  investigation();
  push(
    "agent.message.completed",
    {
      phase: "commentary",
      text: [...finding, "", "I need your go-ahead to refund it."].join("\n"),
    },
    6,
  );
  push(
    "agent.toolCall.created",
    {
      id: "call-ask",
      name: "request_human_input",
      arguments: { questions: [{ id: "decision" }] },
    },
    6,
  );
  push("session.status.changed", { status: "requires_action" }, 6);
  humanInputRequests.push({
    id: "5a1c0000-0000-4000-8000-0000000000f1",
    workspaceId: WORKSPACE_ID,
    sessionId: SELECTED,
    turnId: TURN,
    status: "pending",
    allowSkip: false,
    createdAt: minutesAgo(6),
    expiresAt: new Date(Date.now() + 53 * 60_000).toISOString(),
    questions: [
      {
        id: "decision",
        kind: "single_select",
        label: "Approval",
        prompt: "Refund the duplicate $490.00 charge (pay_71Qy) to Northwind Traders?",
        options: [
          { id: "approve", label: "Approve", description: "Refund pay_71Qy and note the ticket." },
          { id: "cancel", label: "Cancel", description: "Leave both charges in place." },
        ],
        required: true,
        allowOther: false,
      },
    ],
  });
} else if (scenario === "running") {
  investigation();
  push("agent.message.delta", { delta: "Both payments hit the same invoice. Checking the " }, 0);
} else if (scenario === "long") {
  investigation();
  push(
    "agent.message.completed",
    {
      phase: "final",
      text: [
        ...finding,
        "",
        ...Array.from(
          { length: 14 },
          (_, index) =>
            `${index + 1}. Step ${index + 1} of the refund runbook: confirm the payment, the invoice, the customer, and the ledger entry before moving on to the next check.`,
        ),
      ].join("\n"),
    },
    6,
  );
  push("turn.completed", {}, 6);
}

const control: SessionQueueSnapshot["effectiveControl"] = {
  state: "active",
  directState: "active",
  controlVersion: 1,
  controlEtag: "demo",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

const base = fakeClient({});
const client = fakeClient({
  getClientConfig: async () =>
    ({
      ...(await base.getClientConfig()),
      modelSelection: false,
      fileUploads: { enabled: true, maxSizeBytes: 10_000_000 },
    }) as never,
  listSessionPage: async () => ({ pinned: [], sessions, nextCursor: null }) as never,
  getSession: async (_workspace, id) => {
    if (scenario === "error") throw new Error("Network request failed");
    return {
      ...(sessions.find((session) => session.id === id) ?? sessions[0]!),
      activeTurnId: TURN,
      effectiveControl: control,
    } as never;
  },
  getQueue: async () =>
    ({
      version: 1,
      effectiveControl: control,
      activePersonalConnections: [],
      stoppingPreviousAttempt: false,
      items: [],
      pendingInputs: [],
      pendingInputAttachment: null,
    }) as never,
  getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
  listHumanInputRequests: async () => humanInputRequests as never,
  listEvents: async (_workspace, id) => {
    if (scenario === "error") throw new Error("Network request failed");
    return id === SELECTED ? events : [];
  },
  pauseSession: async () => ({ effectiveControl: control }) as never,
  streamEvents: async function* (_workspace, _session, options) {
    await new Promise<void>((resolve) =>
      options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield* [];
  },
});

const palette =
  theme === "light"
    ? { page: "#ffffff", header: "#ffffff", ink: "#1d1d1b", muted: "#6b6b66", line: "#e7e7e4" }
    : host === "navy"
      ? { page: "#0b1020", header: "#0b1020", ink: "#e7ebf5", muted: "#8f9bb8", line: "#1d2540" }
      : { page: "#161616", header: "#1b1b1b", ink: "#ececec", muted: "#a3a3a3", line: "#2e2e2e" };
document.documentElement.classList.toggle("dark", theme === "dark");
document.body.style.background = palette.page;
document.body.style.color = palette.ink;

/** A plain host product around the stock component, as a customer would ship it. */
function HostApp() {
  const nav = ["Inbox", "Tickets", "Customers", "Billing"];
  const narrow = window.innerWidth < 640;
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        color: palette.ink,
      }}
    >
      <header
        style={{
          height: 52,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 28,
          padding: "0 20px",
          borderBottom: `1px solid ${palette.line}`,
          background: palette.header,
          fontSize: 13,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600 }}>
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: "linear-gradient(135deg, #1f8a74, #9fe3d3)",
            }}
          />
          Acme Support
        </span>
        <nav style={{ display: narrow ? "none" : "flex", gap: 20, color: palette.muted }}>
          {nav.map((item) => (
            <span key={item}>{item}</span>
          ))}
          <span style={{ color: palette.ink, fontWeight: 500 }}>Assistant</span>
        </nav>
        <span
          style={{
            marginLeft: "auto",
            width: 28,
            height: 28,
            borderRadius: 999,
            background: theme === "dark" ? "#2a3350" : "#efeee9",
            display: "grid",
            placeItems: "center",
            fontSize: 11,
            fontWeight: 600,
            color: palette.muted,
          }}
        >
          MB
        </span>
      </header>
      <div
        {...(explicit ? { "data-og-theme": theme } : {})}
        style={{ flex: 1, minHeight: 0, padding: narrow ? 0 : "16px 24px 24px" }}
      >
        <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
          <OpenGeniChat defaultSessionId={scenario === "empty" ? null : SELECTED} />
        </OpenGeniProvider>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<HostApp />);
