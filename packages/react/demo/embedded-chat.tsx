/* Embedded OpenGeniChat with fixture data inside a plain host product: the docs
   screenshots (docs-site/images/embedded-conversation*.png, captured by
   scripts/capture-embedded-conversation-screenshot.ts). Real components, the
   real timeline projection, and a scripted client; nothing is mocked in UI.

   The chat is mounted with zero styling, so it follows the host page:
   `?theme=dark` puts the host in dark mode (`class="dark"` on <html> and a dark
   page background), `&host=navy` uses a tinted dark palette, and
   `&scenario=` selects the conversation state (approval, question, running,
   steer-waiting, steered, waiting, long, empty, error, and automation runs:
   automation, automation-live, automation-quiet, and attachments: messages sent
   with a screenshot and a PDF; `&draft=1` also puts them in the composer's
   draft, to compare a sent message with how it looked before sending). `&legacy=1` delivers an
   automation run the way Opengeni recorded it before runs had a plain
   description; `&ids=1` puts internal IDs in what the run's event and an
   earlier setup update say. `&explicit=1` pins the legacy `data-og-theme` wrapper;
   `&hostile=1` adds global host element CSS. `&send=one` mounts the chat with
   one Send (`busySend: "steer"`); `waiting` is a paused workstream with two
   messages waiting. `&goal=paused` gives the chat a goal the agent paused, and
   `&signals=off` mounts it with `agentSignals: false`, as a product for end
   users would; `&signals=no-goal` hides only the goal (`{ goal: false }`).
   `&agents=1` makes the host pass two helper agents in `chromeProps`.
   `&mark=1` leads the live turn row with a host mark
   (`turnSummary.renderLiveMark`). `&refuse=1` makes the first new-chat create a
   definite refusal from a host endpoint (a 400 with its own reason). */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  OpenGeniApiError,
  type SendMessageInput,
  type Session,
  type SessionEvent,
  type SessionQueueSnapshot,
} from "@opengeni/sdk";
import {
  OpenGeniChat,
  OpenGeniProvider,
  NewConversation,
  SessionConversationView,
  useSessionConversation,
  type TurnSummaryLiveMarkState,
} from "@opengeni/react";
import { fakeClient, fakeGoal, fakeTurn, WORKSPACE_ID } from "../test/fake-client";
import "@opengeni/react/compiled.css";

const SELECTED = "5a1c0000-0000-4000-8000-000000000001";
const TURN = "5a1c0000-0000-4000-8000-0000000000a1";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const host = params.get("host") === "navy" ? "navy" : "plain";
const scenario = params.get("scenario") ?? "approval";
const explicit = params.get("explicit") === "1";
const oneSend = params.get("send") === "one";
const pausedGoal = params.get("goal") === "paused";
const signalsParam = params.get("signals");
const agentSignals =
  signalsParam === "off" ? false : signalsParam === "no-goal" ? { goal: false } : true;
// A host that shows the chat's helper agents above the composer.
const hostAgents =
  params.get("agents") === "1"
    ? {
        chromeProps: {
          agentsSignal: { count: 2, detail: "1 running", tone: "running" as const },
          agentsPanel: (
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }}>
              <li>Check the payment provider's log · running</li>
              <li>Draft the refund note · done</li>
            </ul>
          ),
        },
      }
    : {};
const liveMark = params.get("mark") === "1";
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

const STEER_TURN = "5a1c0000-0000-4000-8000-0000000000b1";
const steering = scenario === "steer-waiting" || scenario === "steered";
const RUN_TURN = "5a1c0000-0000-4000-8000-0000000000d1";
const automationRun = scenario.startsWith("automation");
const legacyRun = params.get("legacy") === "1";
const withIds = params.get("ids") === "1";
const ORGANISATION_ID = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";
const selectedStatus =
  scenario === "running" || scenario === "waiting" || steering || scenario === "automation-live"
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

// Files the person attached in the attachments scenario.
const STATEMENT_FILE = "5a1c0000-0000-4000-8000-0000000000f1";
const INVOICE_FILE = "5a1c0000-0000-4000-8000-0000000000f2";
const OCTOBER_FILE = "5a1c0000-0000-4000-8000-0000000000f3";

function statementScreenshot(month: string, rows: Array<[string, string]>): string {
  const lines = rows
    .map(
      ([label, amount], index) =>
        `<text x="24" y="${112 + index * 34}" font-size="15" fill="#3b3b38">${label}</text>` +
        `<text x="456" y="${112 + index * 34}" font-size="15" fill="#3b3b38" text-anchor="end">${amount}</text>` +
        `<line x1="24" x2="456" y1="${124 + index * 34}" y2="${124 + index * 34}" stroke="#e4e2dc"/>`,
    )
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300" font-family="Inter, sans-serif">` +
    `<rect width="480" height="300" fill="#fbfaf7"/>` +
    `<rect width="480" height="52" fill="#1f5f8b"/>` +
    `<text x="24" y="33" font-size="17" font-weight="600" fill="#ffffff">Card statement · ${month}</text>` +
    lines +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const attachedFiles = new Map([
  [
    STATEMENT_FILE,
    {
      filename: "statement-september.png",
      contentType: "image/png",
      sizeBytes: 184_320,
      url: statementScreenshot("September 2026", [
        ["Acme Support · INV-2026-09", "$490.00"],
        ["Acme Support · INV-2026-09", "$490.00"],
        ["Coffee Corner", "$4.20"],
      ]),
    },
  ],
  [
    INVOICE_FILE,
    {
      filename: "INV-2026-09.pdf",
      contentType: "application/pdf",
      sizeBytes: 48_128,
      url: "data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK",
    },
  ],
  [
    OCTOBER_FILE,
    {
      filename: "statement-october.png",
      contentType: "image/png",
      sizeBytes: 152_064,
      url: statementScreenshot("October 2026", [
        ["Acme Support · INV-2026-10", "$490.00"],
        ["Acme Support · INV-2026-10", "$490.00"],
      ]),
    },
  ],
]);

function investigation() {
  push("session.created", {}, 8, null);
  push(
    "user.message",
    scenario === "attachments"
      ? {
          text: "Customer on T-4821 says they were charged twice in September. Here's their statement and the invoice. Can you check?",
          resources: [
            { kind: "file", fileId: STATEMENT_FILE },
            { kind: "file", fileId: INVOICE_FILE },
          ],
        }
      : {
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

/**
 * An event-triggered automation acting in this chat: a ticket was assigned to
 * the person, and the agent looks it up and tells them about it.
 */
function automationRunEvents() {
  const instructions =
    "Continue this conversation when a ticket is assigned to the signed-in user. The recipient is the assignee (confirm through acme__list_my_tickets). Read the event, check that the ticket is still open, and tell the person what it is about and what to do first. If it is already closed, do nothing.";
  if (withIds) {
    push(
      "system.update.delivered",
      {
        updateIds: ["5a1c0000-0000-4000-8000-0000000000f1"],
        count: 1,
        members: [
          {
            id: "5a1c0000-0000-4000-8000-0000000000f1",
            kind: "capability_setup_completed",
            classification: "info",
            sourceId: "5a1c0000-0000-4000-8000-0000000000f2",
            summary: `Acme Helpdesk is connected for the support team. Organisation: ${ORGANISATION_ID}.`,
          },
        ],
      },
      3,
      null,
    );
  }
  push(
    "system.update.delivered",
    {
      updateIds: ["5a1c0000-0000-4000-8000-0000000000e1"],
      count: 1,
      members: [
        {
          id: "5a1c0000-0000-4000-8000-0000000000e1",
          kind: "scheduled_occurrence",
          classification: "info",
          sourceId: "5a1c0000-0000-4000-8000-0000000000e2",
          ...(legacyRun
            ? { summary: instructions }
            : {
                summary: "Ticket assigned to you",
                automation: {
                  name: "Ticket assigned to you",
                  eventSummaries: [
                    withIds
                      ? `T-4907 Refund request from Contoso (organisation ${ORGANISATION_ID})`
                      : "T-4907 Refund request from Contoso",
                  ],
                  eventCount: 1,
                },
              }),
        },
      ],
    },
    2,
    RUN_TURN,
  );
  push("turn.started", {}, 2, RUN_TURN);
  push(
    "agent.toolCall.created",
    { id: "call-run-ticket", name: "acme__get_ticket", arguments: { ticketId: "T-4907" } },
    2,
    RUN_TURN,
  );
  push(
    "agent.toolCall.output",
    {
      id: "call-run-ticket",
      output: text({
        id: "T-4907",
        status: scenario === "automation-quiet" ? "closed" : "open",
        customer: { name: "Contoso" },
        subject: "Refund request for October invoice",
      }),
    },
    1.8,
    RUN_TURN,
  );
  push(
    "agent.toolCall.created",
    {
      id: "call-run-history",
      name: "acme__list_ticket_events",
      arguments: { ticketId: "T-4907" },
    },
    1.6,
    RUN_TURN,
  );
  if (scenario === "automation-live") return;
  push(
    "agent.toolCall.output",
    { id: "call-run-history", output: text([{ type: "assigned" }, { type: "commented" }]) },
    1.5,
    RUN_TURN,
  );
  push(
    "agent.message.completed",
    {
      phase: "final",
      text:
        scenario === "automation-quiet"
          ? legacyRun
            ? "The ticket was already closed, so I didn't notify anyone."
            : "NO_REPLY"
          : "Contoso is asking for a refund of their October invoice ($1,250). The ticket is open and now yours. Start by checking whether the October payment went through twice.",
    },
    1.4,
    RUN_TURN,
  );
  push("turn.completed", {}, 1.4, RUN_TURN);
}

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
} else if (scenario === "waiting") {
  investigation();
} else if (steering) {
  // The person steers while the agent works. The Steer is only their message:
  // it waits for the next model step, then takes over as the next turn.
  investigation();
  push(
    "agent.toolCall.created",
    {
      id: "call-invoice",
      name: "acme__get_invoice",
      arguments: { invoiceId: "INV-2026-09" },
    },
    1,
  );
  push(
    "user.message",
    {
      text: "Also check whether October was double charged too.",
      delivery: "steer",
      routing: "accepted_for_steering",
    },
    0.5,
    STEER_TURN,
  );
  const steerEventId = `evt-${sequence}`;
  if (scenario === "steered") {
    push(
      "agent.toolCall.output",
      { id: "call-invoice", output: text({ id: "INV-2026-09", status: "paid", total: "$490.00" }) },
      0.4,
    );
    push("turn.superseded", { reason: "steer", atModelStep: true }, 0.4);
    push("turn.started", { triggerEventId: steerEventId }, 0.4, STEER_TURN);
    push(
      "agent.toolCall.created",
      {
        id: "call-october",
        name: "acme__list_payments",
        arguments: { customerId: "cus_9Lk2", since: "2026-10-01" },
      },
      0.2,
      STEER_TURN,
    );
  }
} else if (automationRun) {
  investigation();
  push(
    "agent.message.completed",
    {
      phase: "final",
      text: [...finding, "", "I refunded the duplicate and noted it on the ticket."].join("\n"),
    },
    6,
  );
  push("turn.completed", {}, 6);
  automationRunEvents();
} else if (scenario === "attachments") {
  investigation();
  push("agent.message.completed", { phase: "final", text: finding.join("\n") }, 6);
  push("turn.completed", {}, 6);
  // A message that only makes sense with its picture.
  push(
    "user.message",
    {
      text: "They sent this one for October too. Same problem?",
      resources: [{ kind: "file", fileId: OCTOBER_FILE }],
    },
    2,
    STEER_TURN,
  );
  push("turn.started", {}, 2, STEER_TURN);
  push(
    "agent.message.completed",
    {
      phase: "final",
      text: "Yes. October's invoice **INV-2026-10** was also charged twice. I'll refund both duplicates once you approve.",
    },
    1,
    STEER_TURN,
  );
  push("turn.completed", {}, 1, STEER_TURN);
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
  state: scenario === "waiting" ? "paused" : "active",
  directState: scenario === "waiting" ? "paused" : "active",
  controlVersion: 1,
  controlEtag: "demo",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};
const waitingItems =
  scenario === "waiting"
    ? [
        fakeTurn({
          id: "5a1c0000-0000-4000-8000-0000000000c1",
          sessionId: SELECTED,
          prompt: "Also check whether October was double charged.",
        }),
        fakeTurn({
          id: "5a1c0000-0000-4000-8000-0000000000c2",
          sessionId: SELECTED,
          position: 2,
          prompt: "Then draft a short reply to the customer.",
        }),
      ]
    : [];

const base = fakeClient({});
const controllerFixture = { streams: 0, sent: [] as SendMessageInput[] };
if (params.get("controller") === "1") {
  Object.assign(window, { embeddedConversationHarness: controllerFixture });
}
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
      activeTurnId: scenario === "automation-live" ? RUN_TURN : TURN,
      effectiveControl: control,
    } as never;
  },
  getQueue: async () =>
    ({
      version: 1,
      effectiveControl: control,
      activePersonalConnections: [],
      stoppingPreviousAttempt: false,
      // The queue snapshot never lists a prompt accepted for steering.
      items: waitingItems,
      pendingInputs: [],
      pendingInputAttachment: null,
    }) as never,
  getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
  ...(scenario === "attachments" && params.get("draft") === "1"
    ? {
        getComposerDraft: async () =>
          ({
            ...(await base.getComposerDraft(WORKSPACE_ID, SELECTED)),
            revision: 1,
            text: "Here's their statement and the invoice.",
            resources: [
              { kind: "file", fileId: STATEMENT_FILE },
              { kind: "file", fileId: INVOICE_FILE },
            ],
            updatedAt: minutesAgo(0),
          }) as never,
      }
    : {}),
  getFile: async (workspace, fileId) => {
    const file = attachedFiles.get(fileId);
    if (!file) throw new Error("File not found");
    return {
      id: fileId,
      workspaceId: workspace,
      status: "ready",
      filename: file.filename,
      safeFilename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      sha256: null,
      bucket: "demo",
      objectKey: fileId,
      createdAt: minutesAgo(8),
      updatedAt: minutesAgo(8),
    } as never;
  },
  createFileDownloadUrl: async (_workspace, fileId) => {
    const file = attachedFiles.get(fileId);
    if (!file) throw new Error("File not found");
    return { url: file.url, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as never;
  },
  listHumanInputRequests: async () => humanInputRequests as never,
  listEvents: async (_workspace, id) => {
    if (scenario === "error") throw new Error("Network request failed");
    return id === SELECTED ? events : [];
  },
  pauseSession: async () => ({ effectiveControl: control }) as never,
  sendMessage: async (_workspace, sessionId, input) => {
    const message = typeof input === "string" ? { text: input } : input;
    controllerFixture.sent.push(message);
    return {
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      sessionId,
      sequence: ++sequence,
      type: "user.message",
      payload: message,
      occurredAt: new Date().toISOString(),
    };
  },
  streamEvents: async function* (_workspace, _session, options) {
    controllerFixture.streams++;
    await new Promise<void>((resolve) =>
      options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield* [];
  },
});

// A goal the agent paused to wait for a person's decision.
if (pausedGoal) {
  const goal = fakeGoal({
    sessionId: SELECTED,
    status: "paused",
    pausedReason: "agent",
    text: "Resolve the double charge on T-4821",
  });
  Object.assign(client, {
    getGoal: async () => goal,
    updateGoal: async () => goal,
    deleteGoal: async () => undefined,
  });
}

// The demo can hold the real default new-chat flow at a response boundary.
// Browser checks edit the next draft, retry an uncertain outcome, then settle
// the same synthetic create without contacting a provider.
const creationFixture = {
  attempts: [] as Array<{ initialMessage?: string; idempotencyKey?: string }>,
  finish: () => {},
};
Object.assign(window, { embeddedCreationHarness: creationFixture });
Object.assign(client, {
  createSession: async (
    _workspace: string,
    input: { initialMessage?: string; idempotencyKey?: string },
  ) => {
    creationFixture.attempts.push(structuredClone(input));
    if (params.get("retry") === "1" && creationFixture.attempts.length === 1)
      throw new TypeError("Response lost");
    if (params.get("refuse") === "1" && creationFixture.attempts.length === 1)
      throw new OpenGeniApiError(
        400,
        JSON.stringify({
          error: "Ultrafast isn't available for this model. Choose another speed.",
          code: "BAD_REQUEST",
          details: { field: "latencyMode" },
        }),
        { outcomeUnknown: false },
      );
    await new Promise<void>((resolve) => {
      creationFixture.finish = resolve;
    });
    const created = chat(
      "5a1c0000-0000-4000-8000-000000000099",
      input.initialMessage ?? "New chat",
      0,
    );
    sessions.unshift(created);
    return created;
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

function PersistentConversationDemo() {
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(true);
  const conversation = useSessionConversation(SELECTED, {
    composerOptions: { sendExtras: () => ({ modelContext: "Current record: ticket T-4821" }) },
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 13 }}>
        <button type="button" onClick={() => setExpanded((value) => !value)}>
          Toggle panel layout
        </button>
        <button type="button" onClick={() => setVisible((value) => !value)}>
          {visible ? "Hide conversation" : "Show conversation"}
        </button>
        <button
          type="button"
          onClick={() =>
            conversation.composer.addAnnotation?.({
              id: crypto.randomUUID(),
              source: {
                kind: "user_message",
                eventId: "evt-2",
                eventType: "user.message",
                sequence: 2,
                turnId: TURN,
                startOffset: 0,
                endOffset: 8,
                contextBefore: "",
                contextAfter: " on T-4821",
              },
              quote: "Customer",
              note: "Check this exact source.",
            })
          }
        >
          Add example annotation
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: expanded ? "100%" : "min(460px, 100%)",
          alignSelf: "flex-end",
        }}
      >
        {visible ? <SessionConversationView conversation={conversation} /> : null}
      </div>
    </div>
  );
}

/** A plain host product around the stock component, as a customer would ship it. */
/** A stand-in for a host's animated mascot at the start of the live turn row. */
function demoLiveMark(state: TurnSummaryLiveMarkState) {
  return (
    <span data-demo-mark={state.kind} className="size-4 animate-pulse rounded-full bg-og-accent" />
  );
}

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
          {params.get("new") === "standalone" ? (
            <NewConversation />
          ) : params.get("controller") === "1" ? (
            <PersistentConversationDemo />
          ) : (
            <OpenGeniChat
              defaultSessionId={scenario === "empty" ? null : SELECTED}
              conversationProps={{
                agentSignals,
                ...hostAgents,
                ...(liveMark
                  ? {
                      timelineProps: {
                        turnSummary: {
                          rolling: true,
                          renderLiveMark: demoLiveMark,
                        },
                      },
                    }
                  : {}),
                ...(oneSend ? { composerOptions: { busySend: "steer" as const } } : {}),
              }}
            />
          )}
        </OpenGeniProvider>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<HostApp />);
