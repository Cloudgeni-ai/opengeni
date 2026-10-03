/* Embedded OpenGeniChat with fixture data inside a plain host product: the docs
   screenshots (docs-site/images/embedded-conversation*.png, captured by
   scripts/capture-embedded-conversation-screenshot.ts). Real components, the
   real timeline projection, and a scripted client; nothing is mocked in UI.
   `?theme=dark` renders the dark variant. */
import { createRoot } from "react-dom/client";
import type { Session, SessionEvent, SessionQueueSnapshot } from "@opengeni/sdk";
import { OpenGeniChat, OpenGeniProvider } from "@opengeni/react";
import { fakeClient, WORKSPACE_ID } from "../test/fake-client";
import "@opengeni/react/compiled.css";

const SELECTED = "5a1c0000-0000-4000-8000-000000000001";
const TURN = "5a1c0000-0000-4000-8000-0000000000a1";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

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

const sessions: Session[] = [
  chat(SELECTED, "Double charge on ticket T-4821", 1, "requires_action"),
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

push("session.created", {}, 4, null);
push(
  "user.message",
  {
    text: "Customer on T-4821 says they were charged twice in September. Can you check?",
  },
  4,
);
push("turn.started", {}, 4);
push(
  "agent.toolCall.created",
  { id: "call-ticket", name: "acme__get_ticket", arguments: { ticketId: "T-4821" } },
  3,
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
  3,
);
push(
  "agent.toolCall.created",
  {
    id: "call-payments",
    name: "acme__list_payments",
    arguments: { customerId: "cus_9Lk2", since: "2026-09-01" },
  },
  3,
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
  2,
);
push(
  "agent.message.completed",
  {
    phase: "final",
    text: [
      "I checked the ticket and Northwind's payments. The customer is right: invoice **INV-2026-09** was charged twice, three seconds apart.",
      "",
      "| Payment | Amount | Time (UTC) |",
      "| --- | --- | --- |",
      "| pay_71Qx | $490.00 | Sep 27, 23:02:11 |",
      "| pay_71Qy | $490.00 | Sep 27, 23:02:14 |",
      "",
      "I'd like to refund the duplicate **pay_71Qy** and add a note to the ticket. Approve the refund below.",
    ].join("\n"),
  },
  1,
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
  1,
);

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
    ({ ...(await base.getClientConfig()), modelSelection: false }) as never,
  listSessionPage: async () => ({ pinned: [], sessions, nextCursor: null }) as never,
  getSession: async (_workspace, id) =>
    ({
      ...(sessions.find((session) => session.id === id) ?? sessions[0]!),
      activeTurnId: TURN,
      effectiveControl: control,
    }) as never,
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
  listHumanInputRequests: async () => [],
  listEvents: async (_workspace, id) => (id === SELECTED ? events : []),
  streamEvents: async function* (_workspace, _session, options) {
    await new Promise<void>((resolve) =>
      options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield* [];
  },
});

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.body.style.background = theme === "dark" ? "#161616" : "#f3f3f1";

/** A plain host product around the stock component, as a customer would ship it. */
function HostApp() {
  const dark = theme === "dark";
  const ink = dark ? "#ececec" : "#1d1d1b";
  const muted = dark ? "#a3a3a3" : "#6b6b66";
  const line = dark ? "#2e2e2e" : "#e4e4df";
  const nav = ["Inbox", "Tickets", "Customers", "Billing"];
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        color: ink,
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
          borderBottom: `1px solid ${line}`,
          background: dark ? "#1b1b1b" : "#fbfbf9",
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
        <nav style={{ display: window.innerWidth < 640 ? "none" : "flex", gap: 20, color: muted }}>
          {nav.map((item) => (
            <span key={item}>{item}</span>
          ))}
          <span style={{ color: ink, fontWeight: 500 }}>Assistant</span>
        </nav>
        <span
          style={{
            marginLeft: "auto",
            width: 28,
            height: 28,
            borderRadius: 999,
            background: dark ? "#3a3a3a" : "#e8e6df",
            display: "grid",
            placeItems: "center",
            fontSize: 11,
            fontWeight: 600,
            color: muted,
          }}
        >
          MB
        </span>
      </header>
      <div data-og-theme={theme} style={{ flex: 1, minHeight: 0 }}>
        <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
          <OpenGeniChat defaultSessionId={SELECTED} />
        </OpenGeniProvider>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<HostApp />);
