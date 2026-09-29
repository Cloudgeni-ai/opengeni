import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session, SessionTurn } from "@opengeni/sdk";
import { conversationTimeline } from "@opengeni/react/session";
import { SessionWaitStatus } from "@/components/session/session-wait-status";
import {
  SESSION_STARTUP_GRACE_MS,
  sessionStartupPhase,
  useSessionStartup,
  SessionStartupProvider,
} from "./session-startup";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "one",
    workspaceId: "workspace",
    status: "queued",
    activeTurnId: null,
    effectiveControl: { state: "active" },
    updatedAt: new Date().toISOString(),
    dispatchWait: { state: "acknowledged", attempts: 1, nextAttemptAt: null, lastError: null },
    ...overrides,
  } as Session;
}
const queuedTurn = {
  id: "behind",
  triggerEventId: "later",
  metadata: {},
} as unknown as SessionTurn;

test("only pre-execution active admission can be Starting; capacity/recovery/pause win", () => {
  expect(sessionStartupPhase(session(), 0)).toBe("starting");
  expect(sessionStartupPhase(session(), SESSION_STARTUP_GRACE_MS)).toBe("delayed");
  for (const status of [
    "idle",
    "running",
    "recovering",
    "waiting_capacity",
    "requires_action",
    "failed",
    "cancelled",
  ] as const) {
    expect(sessionStartupPhase(session({ status }), 0)).toBeNull();
  }
  expect(sessionStartupPhase(session({ activeTurnId: "claimed" }), 0)).toBeNull();
  expect(
    sessionStartupPhase(
      session({ effectiveControl: { state: "paused" } as Session["effectiveControl"] }),
      0,
    ),
  ).toBeNull();
  for (const wait of [
    { state: "pending" as const, attempts: 2, nextAttemptAt: null, lastError: null },
    { state: "pending" as const, attempts: 1, nextAttemptAt: null, lastError: "No worker" },
  ])
    expect(sessionStartupPhase(session({ dispatchWait: wait }), 0)).toBe("retrying");
});

test("initial dispatch is compact with discoverable diagnostics, never Working or Queued", () => {
  const html = renderToStaticMarkup(<SessionWaitStatus session={session()} />);
  expect(html).toContain("Starting");
  expect(html).toContain("Start details");
  expect(html).not.toContain("<details open");
  expect(html).not.toContain("Queued");
  expect(html).not.toContain("Working");
  expect(html).not.toContain("animate-spin");
});

test("accepted idle Send remains in conversation before/after replay, independently of later genuine queued work", () => {
  const optimistic = {
    clientEventId: "client",
    turnId: "turn",
    delivery: "send",
    destination: "chat",
    state: "queued",
    text: "Start this",
    annotations: [],
    resources: [],
    occurredAt: new Date().toISOString(),
  } as const;
  const item = {
    kind: "user-message" as const,
    id: "message",
    text: "Start this",
    reconciliationKey: "user-message:client",
    occurredAt: new Date().toISOString(),
    resources: [],
    tools: [],
  };
  // getSessionQueueSnapshot excludes accepted_for_execution. A later prompt
  // genuinely queued behind it must not move the accepted message out of chat.
  for (const raw of [[], [queuedTurn]]) {
    for (const items of [[], [item]]) {
      const timeline = conversationTimeline(
        [...items],
        { queue: raw, snapshot: null, acceptedSteers: [] },
        { optimisticMessages: [{ ...optimistic, annotations: [], resources: [] }] },
      );
      expect(timeline).toHaveLength(1);
      expect(timeline[0]?.kind === "user-message" && timeline[0].text).toBe("Start this");
    }
  }
});

function Probe({ value }: { value: Session }) {
  return <span>{useSessionStartup(value)}</span>;
}

test("a newly mounted wait surface shares the header's new episode after long idle and delayed detail", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (value: Session) => (
    <SessionStartupProvider session={value}>
      <div data-header>
        <Probe value={value} />
      </div>
      {value.status === "queued" ? <SessionWaitStatus session={value} /> : null}
    </SessionStartupProvider>
  );
  const oldIdle = session({ status: "idle", updatedAt: "2000-01-01T00:00:00Z" });
  try {
    await act(async () => root.render(render(oldIdle)));
    await act(async () => root.render(render({ ...oldIdle, status: "queued" })));
    expect(container.querySelector("[data-header]")?.textContent).toBe("starting");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Starting");
    await act(async () => root.render(render(session())));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Starting");
    await act(async () =>
      root.render(render(session({ workspaceId: "other", updatedAt: "2000-01-01T00:00:00Z" }))),
    );
    expect(container.querySelector("[data-header]")?.textContent).toBe("delayed");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Still waiting to start",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test("polls cannot reset grace; account/session changes and new idle episodes reset local state", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Probe
          value={session({
            updatedAt: new Date(Date.now() - SESSION_STARTUP_GRACE_MS + 80).toISOString(),
          })}
        />,
      ),
    );
    expect(container.textContent).toBe("starting");
    await act(async () => root.render(<Probe value={session()} />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(container.textContent).toBe("delayed");
    await act(async () => root.render(<Probe value={session({ workspaceId: "other" })} />));
    expect(container.textContent).toBe("starting");
    await act(async () => root.render(<Probe value={session({ status: "idle" })} />));
    expect(container.textContent).toBe("");
    // A fresh stream status may precede the detail refresh and still carry the
    // idle session's old timestamp. That is a new episode, not a stale dispatch.
    await act(async () =>
      root.render(<Probe value={session({ updatedAt: "2000-01-01T00:00:00Z" })} />),
    );
    expect(container.textContent).toBe("starting");
  } finally {
    await act(async () => root.unmount());
  }
});

test("reopening a stalled queued session immediately exposes the wait", () => {
  const html = renderToStaticMarkup(
    <SessionWaitStatus
      session={session({
        updatedAt: new Date(Date.now() - SESSION_STARTUP_GRACE_MS - 1).toISOString(),
      })}
    />,
  );
  expect(html).toContain("Still waiting to start");
  expect(html).toContain("Your messages are saved");
});
