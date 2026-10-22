import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import {
  SessionConversation,
  SessionConversationView,
} from "../src/components/session-conversation";
import { useSessionConversation } from "../src/hooks/use-session-conversation";
import type { TimelineItem } from "../src/timeline";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent, renderHook } from "./render-hook";

registerDom();

const TURN = "33333333-3333-4333-8333-333333333333";
const SENT_AT = new Date(Date.now() - 2_000).toISOString();

type Control = { state: "active" | "paused"; controlVersion: number } | undefined;
function session(
  status: "queued" | "running" | "idle",
  options: { control?: Control; activeTurnId?: string | null; lastSequence?: number } = {},
) {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    status,
    activeTurnId: options.activeTurnId ?? null,
    ...("control" in options
      ? options.control
        ? { effectiveControl: options.control }
        : {}
      : { effectiveControl: { state: "active", controlVersion: 1 } }),
    inputWait: null,
    dispatchWait: { state: "acknowledged", attempts: 1, nextAttemptAt: null, lastError: null },
    updatedAt: SENT_AT,
    lastSequence: options.lastSequence ?? 1,
    queueVersion: 0,
  };
}

function event(
  sequence: number,
  type: SessionEvent["type"],
  payload: unknown,
  turnId: string | null,
): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(Date.parse(SENT_AT) + sequence * 100).toISOString(),
    clientEventId: null,
    turnId,
  } as SessionEvent;
}

const accepted = event(
  1,
  "user.message",
  { text: "Explain my network", routing: "accepted_for_execution" },
  TURN,
);

/** A client whose live stream the test drives. */
function client(read: {
  session: () => unknown;
  history: () => SessionEvent[];
  gate?: Promise<void>;
}) {
  const live: SessionEvent[] = [];
  let wake: (() => void) | null = null;
  return {
    push(next: SessionEvent) {
      live.push(next);
      wake?.();
    },
    client: fakeClient({
      getSession: async () => read.session() as never,
      listEvents: async () => {
        await read.gate;
        return read.history() as never;
      },
      getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
      listHumanInputRequests: async () => [],
      streamEvents: async function* (_workspace, _session, options) {
        while (!options?.signal?.aborted) {
          const next = live.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    }),
  };
}

const startupRows = (items: TimelineItem[]) =>
  items.filter((item) => item.kind === "startup-phase" && item.status === "running");

async function conversation(fixture: ReturnType<typeof client>) {
  const view = await renderHook(
    () => useSessionConversation(SESSION_ID, { client: fixture.client, workspaceId: WORKSPACE_ID }),
    undefined,
  );
  await flush(80);
  return view;
}

test("an accepted first prompt shows one startup row in an embedded conversation", async () => {
  const fixture = client({ session: () => session("queued"), history: () => [accepted] });
  const view = await conversation(fixture);
  try {
    const rows = startupRows(view.result.current.timeline);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turnId: TURN, phase: "queue" });
  } finally {
    await view.unmount();
  }
});

test("the startup row gives way to the turn when it starts, without a duplicate", async () => {
  let current = session("queued");
  const fixture = client({ session: () => current, history: () => [accepted] });
  const view = await conversation(fixture);
  try {
    expect(startupRows(view.result.current.timeline)).toHaveLength(1);
    current = session("running", { activeTurnId: TURN, lastSequence: 2 });
    fixture.push(event(2, "turn.started", {}, TURN));
    fixture.push(event(3, "session.status.changed", { status: "running" }, TURN));
    await flush(120);
    const queued = view.result.current.timeline.filter(
      (item) => item.kind === "startup-phase" && item.phase === "queue",
    );
    expect(queued.length).toBeLessThanOrEqual(1);
    expect(startupRows(view.result.current.timeline)).toHaveLength(0);
  } finally {
    await view.unmount();
  }
});

test("a paused session, or one without control state, shows no startup row", async () => {
  for (const control of [{ state: "paused", controlVersion: 2 } as const, undefined]) {
    const fixture = client({
      session: () => session("queued", { control }),
      history: () => [accepted],
    });
    const view = await conversation(fixture);
    try {
      expect(startupRows(view.result.current.timeline)).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  }
});

test("an idle conversation's timeline is left as it is", async () => {
  const reply = event(2, "agent.message.completed", { text: "Done." }, TURN);
  const fixture = client({
    session: () => session("idle", { lastSequence: 3 }),
    history: () => [accepted, event(1.5, "turn.started", {}, TURN), reply],
  });
  const view = await conversation(fixture);
  try {
    expect(view.result.current.timeline.some((item) => item.kind === "startup-phase")).toBe(false);
  } finally {
    await view.unmount();
  }
});

test("a host-created session keeps one prompt and one startup row from send to live history", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fixture = client({ session: () => session("queued"), history: () => [accepted], gate });
  function Host({ sessionId }: { sessionId: string | null }) {
    const controller = useSessionConversation(sessionId, {
      client: fixture.client,
      workspaceId: WORKSPACE_ID,
      pendingPrompt: sessionId === null ? { text: "Explain my network", sentAt: SENT_AT } : null,
    });
    return <SessionConversationView conversation={controller} />;
  }
  const view = await renderComponent(<Host sessionId={null} />);
  const frames: string[] = [];
  const observer = new MutationObserver(() => frames.push(view.container.textContent ?? ""));
  observer.observe(view.container, { subtree: true, childList: true, characterData: true });
  try {
    await flush(50);
    const row = view.container.querySelector(".og-genie-loading");
    expect(row).not.toBeNull();
    expect(view.container.textContent).toContain("Explain my network");
    // The host's create call returns; the session reads, its history is still loading.
    await view.rerender(<Host sessionId={SESSION_ID} />);
    await flush(50);
    expect(view.container.querySelector(".og-genie-loading")).toBe(row);
    release();
    await flush(120);
    // Live history took over in place: the same startup element, never a blank.
    expect(view.container.querySelector(".og-genie-loading")).toBe(row);
    expect(view.container.querySelectorAll(".og-genie-loading")).toHaveLength(1);
    expect(view.container.textContent).toContain("Explain my network");
    for (const frame of frames) {
      expect(frame).toContain("Explain my network");
      expect(frame).not.toContain("No activity yet");
    }
  } finally {
    observer.disconnect();
    await view.unmount();
  }
});

test("SessionConversation stays mounted when the host's session id arrives", async () => {
  const fixture = client({ session: () => session("queued"), history: () => [accepted] });
  const prompt = { text: "Explain my network", sentAt: SENT_AT };
  const render = (sessionId: string | null) => (
    <SessionConversation
      client={fixture.client}
      workspaceId={WORKSPACE_ID}
      sessionId={sessionId}
      pendingPrompt={prompt}
    />
  );
  const view = await renderComponent(render(null));
  try {
    await flush(50);
    const root = view.container.querySelector("[data-og-conversation]");
    const row = view.container.querySelector(".og-genie-loading");
    expect(row).not.toBeNull();
    await view.rerender(render(SESSION_ID));
    await flush(120);
    expect(view.container.querySelector("[data-og-conversation]")).toBe(root);
    expect(view.container.querySelector(".og-genie-loading")).toBe(row);
  } finally {
    await view.unmount();
  }
});

test("the first prompt stays with its own session when the controller moves to another", async () => {
  const OTHER = "44444444-4444-4444-8444-444444444444";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  // Neither history loads before the switch.
  const fixture = client({ session: () => session("queued"), history: () => [accepted], gate });
  const other = fakeClient({
    getSession: async () => ({ ...session("idle"), id: OTHER }) as never,
    listEvents: async () => {
      await gate;
      return [] as never;
    },
    getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* (_workspace, _session, options) {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
  });
  const routed = fakeClient({
    ...Object.fromEntries(
      ["getSession", "listEvents", "getQueue", "listHumanInputRequests", "streamEvents"].map(
        (name) => [
          name,
          (...args: unknown[]) =>
            ((args[1] === OTHER ? other : fixture.client) as any)[name](...args),
        ],
      ),
    ),
  });
  const prompt = { text: "Prompt for A", sentAt: SENT_AT };
  const view = await renderHook(
    (sessionId: string | null) =>
      useSessionConversation(sessionId, {
        client: routed,
        workspaceId: WORKSPACE_ID,
        pendingPrompt: prompt,
      }),
    null as string | null,
  );
  try {
    await flush(30);
    expect(JSON.stringify(view.result.current.timeline)).toContain("Prompt for A");
    await view.rerender(SESSION_ID);
    await flush(80);
    // Another chat opens in the same controller while its history loads.
    await view.rerender(OTHER);
    await flush(30);
    expect(JSON.stringify(view.result.current.timeline)).not.toContain("Prompt for A");
    expect(startupRows(view.result.current.timeline)).toHaveLength(0);
    release();
    await flush(50);
  } finally {
    await view.unmount();
  }
});

test("the composer is disabled until the host's session exists", async () => {
  const fixture = client({ session: () => session("queued"), history: () => [accepted] });
  const render = (sessionId: string | null) => (
    <SessionConversation
      client={fixture.client}
      workspaceId={WORKSPACE_ID}
      sessionId={sessionId}
      pendingPrompt={{ text: "Explain my network", sentAt: SENT_AT }}
    />
  );
  const view = await renderComponent(render(null));
  try {
    await flush(50);
    // Disabled as a whole: typing, dictation and the model choice are all off.
    expect(view.container.querySelector("textarea")?.disabled).toBe(true);
    await view.rerender(render(SESSION_ID));
    await flush(80);
    expect(view.container.querySelector("textarea")?.disabled).toBe(false);
  } finally {
    await view.unmount();
  }
});
