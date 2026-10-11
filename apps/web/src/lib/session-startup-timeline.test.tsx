import { expect, test } from "bun:test";
import { act } from "react";
import type { Session, SessionEvent, SessionQueueSnapshot, SessionTurn } from "@opengeni/sdk";
import { buildTimeline, type ComposerState, type TimelineItem } from "@opengeni/react/session";
import { MessageTimeline } from "@opengeni/react/session-ui";
import { registerDom, renderComponent, flush } from "../../../../packages/react/test/render-hook";
import { SessionStartupProvider } from "./session-startup";
import { sessionStartupTimeline, useSessionStartupTimeline } from "./session-startup-timeline";
registerDom();
const start = new Date(Date.now() - 35_000).toISOString();
const session = {
  id: "session",
  workspaceId: "workspace",
  updatedAt: start,
  lastSequence: 0,
  queueVersion: 0,
  status: "queued",
  activeTurnId: null,
  effectiveControl: { state: "active" },
  inputWait: null,
  dispatchWait: { state: "acknowledged", attempts: 1, nextAttemptAt: null, lastError: null },
} as Session;
function event(
  type: string,
  turnId = "turn",
  payload: Record<string, unknown> = {},
  occurredAt = start,
): SessionEvent {
  return {
    id: `${turnId}-${type}`,
    type,
    turnId,
    occurredAt,
    payload,
    sequence: 1,
    sessionId: "session",
    workspaceId: "workspace",
  } as SessionEvent;
}
const accepted = event("turn.queued", "turn", { routing: "accepted_for_execution" });
const message: TimelineItem = {
  kind: "user-message",
  id: "message",
  text: "Explain this",
  resources: [],
  tools: [],
  occurredAt: start,
};
const optimistic = {
  appliedQueueVersion: 1,
  clientEventId: "client",
  turnId: "turn",
  destination: "chat",
  delivery: "send",
  state: "queued",
  occurredAt: start,
  text: "Explain this",
  resources: [],
  annotations: [],
} as NonNullable<ComposerState["optimisticMessages"]>[number];
function project(
  overrides: Partial<Parameters<typeof sessionStartupTimeline>[1]> = {},
  items: TimelineItem[] = [message],
) {
  return sessionStartupTimeline(items, {
    session,
    events: [accepted],
    optimisticMessages: [],
    hasNewer: false,
    ...overrides,
  });
}
test("accepted receipt and durable replay share one startup identity and acceptance time", () => {
  const receipt = project({
    session: { ...session, status: "idle" },
    events: [],
    optimisticMessages: [optimistic],
  });
  expect(receipt.at(-1)).toMatchObject({ id: project().at(-1)!.id, occurredAt: start });
  const pending = receipt.at(-1)!;
  expect(pending.kind).toBe("startup-phase");
  expect(pending.occurredAt).toBe(start);
  const started = event("turn.started", "turn", {}, new Date().toISOString());
  const durable = buildTimeline([accepted, started]);
  expect(durable[0]?.id).toBe(pending.id);
  expect(
    project(
      {
        events: [accepted, started],
        session: { ...session, status: "running", activeTurnId: "turn" },
      },
      durable,
    ),
  ).toBe(durable);
});
test("only accepted current work gets an orb; queue, send errors, Pause and terminal states win", () => {
  for (const state of ["sending", "failed"] as const)
    expect(project({ events: [], optimisticMessages: [{ ...optimistic, state }] })).toEqual([
      message,
    ]);
  expect(
    project({ events: [], optimisticMessages: [{ ...optimistic, destination: "queue" }] }),
  ).toEqual([message]);
  for (const status of [
    "failed",
    "cancelled",
    "recovering",
    "waiting_capacity",
    "requires_action",
  ] as const)
    expect(project({ session: { ...session, status } })).toEqual([message]);
  expect(
    project({
      session: { ...session, effectiveControl: { ...session.effectiveControl, state: "paused" } },
    }),
  ).toEqual([message]);
  expect(project({ hasNewer: true })).toEqual([message]);
  expect(project({ session: { ...session, status: "running", activeTurnId: "earlier" } })).toEqual([
    message,
  ]);
  expect(
    project({
      session: {
        ...session,
        status: "idle",
        inputWait: { reason: "Waiting for checks", deadlineAt: start },
      },
    }),
  ).toEqual([message]);
  for (const type of ["turn.started", "turn.completed", "turn.failed", "turn.cancelled"])
    expect(project({ events: [accepted, event(type)] })).toEqual([message]);
});
test("later queued work cannot duplicate the current startup; a promoted queue head can start", () => {
  const later = event("turn.queued", "later", { routing: "queued_for_execution" });
  expect(project({ events: [accepted, later] })).toHaveLength(2);
  expect(project({ events: [accepted, later] }).at(-1)?.id).toBe("turn-queue");
  expect(
    project({ events: [accepted, event("turn.completed"), later], queue: queue(["later"]) }).at(-1)
      ?.id,
  ).toBe("later-queue");
  expect(project({ session: { ...session, status: "idle" }, events: [later] })).toEqual([message]);
});
test("startup errors update in place, stay immediately visible and retain retry diagnostics", async () => {
  const r = await renderComponent(
    <MessageTimeline items={project()} turnSummary={{ rolling: true }} />,
  );
  try {
    const orb = r.container.querySelector("canvas");
    const failedSession = {
      ...session,
      dispatchWait: {
        state: "pending" as const,
        attempts: 2,
        nextAttemptAt: "2099-01-01T12:00:00Z",
        lastError: "Worker temporarily unavailable",
      },
    };
    await r.rerender(
      <MessageTimeline
        items={project({ session: failedSession })}
        turnSummary={{ rolling: true }}
      />,
    );
    expect(r.container.querySelector("canvas")).toBe(orb);
    expect(r.container.querySelector('[role="status"]')?.textContent).toContain(
      "Unable to start yet",
    );
    expect(r.container.textContent).not.toContain("Worker temporarily unavailable");
    await act(async () =>
      (r.container.querySelector(".og-genie-details") as HTMLButtonElement).click(),
    );
    expect(r.container.textContent).toContain("Automatic start retry at");
    expect(r.container.textContent).toContain("2 dispatch attempts");
    expect(r.container.textContent).toContain("Worker temporarily unavailable");
    const claimed = { ...failedSession, activeTurnId: "turn", status: "running" as const };
    await r.rerender(
      <MessageTimeline items={project({ session: claimed })} turnSummary={{ rolling: true }} />,
    );
    expect(r.container.querySelector("canvas")).toBe(orb);
    expect(r.container.textContent).not.toContain("Unable to start yet");
    expect(r.container.textContent).not.toContain("No agent turn is running");
    await r.rerender(
      <MessageTimeline
        items={project({
          session: {
            ...session,
            effectiveControl: { ...session.effectiveControl, state: "paused" },
          },
        })}
        turnSummary={{ rolling: true }}
      />,
    );
    await flush();
    expect(r.container.querySelector("canvas")).toBeNull();
  } finally {
    await r.unmount();
  }
});
test("worker claim and preparation retain the same orb, open disclosure and full elapsed time", async () => {
  const older = event(
    "turn.queued",
    "turn",
    { routing: "accepted_for_execution" },
    new Date(Date.now() - 65_000).toISOString(),
  );
  const pending = project({ events: [older] });
  const r = await renderComponent(
    <MessageTimeline items={pending} turnSummary={{ rolling: true }} />,
  );
  try {
    const orb = r.container.querySelector("canvas");
    expect(r.container.textContent).toContain("A little longer than usual");
    await act(async () =>
      (r.container.querySelector(".og-genie-details") as HTMLButtonElement).click(),
    );
    const started = event("turn.started", "turn", {}, new Date().toISOString());
    const phases = buildTimeline([older, started]);
    await r.rerender(
      <MessageTimeline items={[message, ...phases]} turnSummary={{ rolling: true }} />,
    );
    expect(r.container.querySelector("canvas")).toBe(orb);
    expect(r.container.textContent).toContain("Hide details");
    expect(r.container.textContent).toContain("A little longer than usual");
    expect(r.container.textContent).not.toContain("No agent turn is running");
    await r.rerender(
      <MessageTimeline
        items={[
          message,
          ...phases,
          {
            kind: "reasoning",
            id: "thought",
            turnId: "turn",
            text: "Thinking through the problem",
            streaming: true,
            occurredAt: new Date().toISOString(),
          },
        ]}
        turnSummary={{ rolling: true }}
      />,
    );
    await flush();
    expect(r.container.querySelector("canvas")).toBeNull();
    expect(r.container.textContent).toContain("Working");
  } finally {
    await r.unmount();
  }
});
test("queue withdrawal and supersession cannot resurrect removed work or steal the next startup", () => {
  for (const operation of ["edit", "delete"]) {
    const withdrawn = event("session.queue.changed", "turn", { turnId: "turn", operation });
    expect(
      project({
        events: [accepted, withdrawn],
        session: { ...session, status: "idle" },
        optimisticMessages: [optimistic],
      }),
    ).toEqual([message]);
    expect(
      project({
        events: [
          accepted,
          withdrawn,
          event("turn.queued", "next", { routing: "accepted_for_execution" }),
        ],
      }).at(-1)?.id,
    ).toBe("next-queue");
  }
  expect(project({ events: [accepted, event("turn.superseded")] })).toEqual([message]);
});
test("duplicate and rejected late events cannot create or dismiss current loading", () => {
  for (const marker of [
    { duplicateOfEventId: "original" },
    { turnAssociation: "late_rejected" as const },
  ]) {
    expect(project({ events: [{ ...accepted, ...marker }] })).toEqual([message]);
    expect(project({ events: [accepted, { ...event("turn.started"), ...marker }] })).toHaveLength(
      2,
    );
  }
});
test("acceptance before session refresh cannot show an old dispatch error", () => {
  const items = project({
    session: {
      ...session,
      status: "idle",
      dispatchWait: { ...session.dispatchWait!, lastError: "Old error" },
    },
    events: [],
    optimisticMessages: [optimistic],
  });
  expect(items.at(-1)).toMatchObject({ dispatchWait: null });
});
function queue(ids: string[], version = 1): SessionQueueSnapshot {
  return {
    version,
    items: ids.map((id) => ({ id, createdAt: start }) as SessionTurn),
  } as SessionQueueSnapshot;
}
test("promoted work follows the fresh canonical queue order, never acceptance order", () => {
  const a = event("turn.queued", "a", { routing: "queued_for_execution" });
  const b = event("turn.queued", "b", { routing: "queued_for_execution" });
  const moved = event("session.queue.changed", "b", {
    operation: "move",
    beforeTurnId: "a",
    queueVersion: 2,
  });
  const events = [a, b, moved];
  expect(project({ events, queue: queue(["b", "a"], 2) }).at(-1)?.id).toBe("b-queue");
  expect(
    project({ events, queue: queue(["a", "b"], 1), fallbackStartedAt: start }).at(-1)?.id,
  ).toBe("pending-startup:session-queue");
  expect(project({ events: [a, b, event("turn.started", "a")], queue: queue(["a", "b"]) })).toEqual(
    [message],
  );
});
test("idle detail newer than acceptance cannot revive completed work while SSE lags", () => {
  expect(
    project({ session: { ...session, status: "idle", lastSequence: 12, queueVersion: 2 } }),
  ).toEqual([message]);
  expect(
    project({
      session: { ...session, status: "idle", lastSequence: 12, queueVersion: 2 },
      events: [],
      optimisticMessages: [optimistic],
    }),
  ).toEqual([message]);
  expect(
    project({
      session: { ...session, status: "idle", lastSequence: 0, queueVersion: 0 },
      events: [],
      optimisticMessages: [optimistic],
    }),
  ).toHaveLength(2);
});
test("stale queued detail cannot add a second orb after newer start, completion or withdrawal", () => {
  for (const next of [
    event("turn.started"),
    event("turn.completed"),
    event("session.queue.changed", "turn", { operation: "delete" }),
  ]) {
    const events = [accepted, next];
    const items = buildTimeline(events);
    expect(project({ events, fallbackStartedAt: start }, items)).toBe(items);
  }
});
const EMPTY_ITEMS: TimelineItem[] = [];
function StartupView({
  value,
  events,
  items = EMPTY_ITEMS,
}: {
  value: Session;
  events: SessionEvent[];
  items?: TimelineItem[];
}) {
  const timeline = useSessionStartupTimeline(items, {
    session: value,
    events,
    optimisticMessages: [],
    hasNewer: false,
  });
  return <MessageTimeline items={timeline} turnSummary={{ rolling: true }} />;
}
test("machine-input startup survives claim and first phase, then the next wake gets a fresh clock", async () => {
  const since = new Date(Date.now() - 65_000).toISOString();
  const queued = {
    ...session,
    updatedAt: since,
    lastSequence: 100,
    dispatchWait: { ...session.dispatchWait!, lastError: "Worker temporarily unavailable" },
  };
  const pending = {
    ...event("system.update.pending", "", { kind: "scheduled_occurrence" }, since),
    turnId: null,
    sequence: 100,
  };
  const r = await renderComponent(<StartupView value={queued} events={[pending]} />);
  try {
    const orb = r.container.querySelector("canvas");
    expect(orb).not.toBeNull();
    expect(r.container.textContent).toContain("Unable to start yet");
    await act(async () =>
      (r.container.querySelector(".og-genie-details") as HTMLButtonElement).click(),
    );
    await r.rerender(
      <StartupView
        value={{ ...queued, updatedAt: new Date().toISOString(), dispatchWait: null }}
        events={[pending]}
      />,
    );
    expect(r.container.textContent).toContain("A little longer than usual");
    const started = {
      ...event("turn.started", "machine", {}, new Date().toISOString()),
      sequence: 101,
    };
    const running = {
      ...queued,
      status: "running" as const,
      activeTurnId: "machine",
      lastSequence: 101,
    };
    await r.rerender(<StartupView value={running} events={[pending, started]} />);
    expect(r.container.querySelector("canvas")).toBe(orb);
    expect(r.container.textContent).toContain("Hide details");
    expect(r.container.textContent).toContain("A little longer than usual");
    expect(r.container.textContent).not.toContain("No agent turn is running");
    const phase: TimelineItem = {
      kind: "startup-phase",
      id: "actual-phase",
      turnId: "machine",
      phase: "sandbox",
      status: "running",
      startedAt: started.occurredAt,
      occurredAt: started.occurredAt,
      completedAt: null,
      durationMs: null,
      outcome: null,
    };
    await r.rerender(<StartupView value={running} events={[pending, started]} items={[phase]} />);
    expect(r.container.querySelector("canvas")).toBe(orb);
    expect(r.container.textContent).toContain("A little longer than usual");
    const end = { ...event("turn.completed", "machine"), sequence: 102 };
    await r.rerender(
      <StartupView
        value={{ ...queued, status: "idle", lastSequence: 102, dispatchWait: null }}
        events={[pending, started, end]}
        items={[
          { ...phase, status: "complete" },
          {
            kind: "turn-end",
            failureText: null,
            id: "end",
            turnId: "machine",
            outcome: "complete",
            occurredAt: end.occurredAt,
          },
        ]}
      />,
    );
    expect(r.container.querySelector("canvas")).toBeNull();
    await r.rerender(
      <StartupView
        value={{
          ...queued,
          updatedAt: new Date().toISOString(),
          lastSequence: 103,
          dispatchWait: null,
        }}
        events={[]}
      />,
    );
    expect(r.container.querySelector("canvas")).not.toBeNull();
    expect(r.container.textContent).not.toContain("A little longer than usual");
    expect(r.container.querySelector(".og-genie-details")).toBeNull();
  } finally {
    await r.unmount();
  }
});
test("a lagging shell never lends the previous idle clock to a new queued wake", async () => {
  const oldIdle = {
    ...session,
    status: "idle" as const,
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  };
  const queued = { ...session, updatedAt: new Date().toISOString() };
  const r = await renderComponent(
    <SessionStartupProvider session={oldIdle}>
      <StartupView value={queued} events={[]} />
    </SessionStartupProvider>,
  );
  try {
    expect(r.container.querySelector("canvas")).toBeNull();
    await r.rerender(
      <SessionStartupProvider session={queued}>
        <StartupView value={queued} events={[]} />
      </SessionStartupProvider>,
    );
    expect(r.container.querySelector("canvas")).not.toBeNull();
    expect(r.container.querySelector(".og-genie-details")).toBeNull();
    expect(r.container.textContent).not.toContain("A little longer than usual");
  } finally {
    await r.unmount();
  }
});
test("SSE claim before queued detail refresh keeps exactly one existing orb", async () => {
  const r = await renderComponent(
    <StartupView value={session} events={[accepted]} items={[message]} />,
  );
  try {
    const orb = r.container.querySelector("canvas");
    const started = { ...event("turn.started"), sequence: 2 };
    const events = [accepted, started];
    await r.rerender(
      <StartupView value={session} events={events} items={[message, ...buildTimeline(events)]} />,
    );
    expect(r.container.querySelectorAll("canvas")).toHaveLength(1);
    expect(r.container.querySelector("canvas")).toBe(orb);
    expect(r.container.querySelectorAll('[data-og-item="turn-queue"]')).toHaveLength(0);
  } finally {
    await r.unmount();
  }
});
test("a next machine wake resets the clock even when no idle frame was observed", async () => {
  const old = new Date(Date.now() - 120_000).toISOString();
  const queued = { ...session, updatedAt: old, lastSequence: 100 };
  const r = await renderComponent(<StartupView value={queued} events={[]} />);
  try {
    const started = { ...event("turn.started", "first", {}, old), sequence: 101 };
    const phase: TimelineItem = {
      kind: "startup-phase",
      id: "phase",
      turnId: "first",
      phase: "sandbox",
      status: "running",
      startedAt: old,
      occurredAt: old,
      completedAt: null,
      durationMs: null,
      outcome: null,
    };
    await r.rerender(
      <StartupView
        value={{ ...queued, status: "running", activeTurnId: "first", lastSequence: 101 }}
        events={[started]}
        items={[phase]}
      />,
    );
    expect(r.container.textContent).toContain("A little longer than usual");
    const now = new Date().toISOString();
    const ended = { ...event("turn.completed", "first", {}, now), sequence: 102 };
    const next = { ...event("system.update.pending", "", {}, now), turnId: null, sequence: 103 };
    const history: TimelineItem[] = [
      { ...phase, status: "complete" },
      {
        kind: "turn-end",
        id: "end",
        turnId: "first",
        outcome: "complete",
        failureText: null,
        occurredAt: now,
      },
    ];
    await r.rerender(
      <StartupView
        value={{ ...queued, updatedAt: now, lastSequence: 103 }}
        events={[started, ended, next]}
        items={history}
      />,
    );
    expect(r.container.querySelectorAll("canvas")).toHaveLength(1);
    expect(r.container.textContent).not.toContain("A little longer than usual");
    expect(r.container.querySelector(".og-genie-details")).toBeNull();
    // Polling must preserve the new episode rather than borrowing the shell's old clock.
    await r.rerender(
      <StartupView
        value={{ ...queued, updatedAt: now, lastSequence: 103 }}
        events={[started, ended, next]}
        items={history}
      />,
    );
    expect(r.container.textContent).not.toContain("A little longer than usual");
  } finally {
    await r.unmount();
  }
});
test("a fresh queue snapshot cannot promote a second prompt while newer events prove a claim", () => {
  const queued = event("turn.queued", "next", { routing: "queued_for_execution" });
  const started = { ...event("turn.started"), sequence: 2 };
  const events = [accepted, queued, started];
  const items = buildTimeline(events);
  expect(project({ events, queue: queue(["next"], 3), fallbackStartedAt: start }, items)).toBe(
    items,
  );
});
