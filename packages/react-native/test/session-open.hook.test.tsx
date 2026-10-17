import { describe, expect, test } from "bun:test";
import { useEffect, type ReactNode } from "react";
import type { Session, SessionEvent, SessionQueueSnapshot } from "@opengeni/sdk";
import { OpenGeniProvider } from "../../react/src/provider";
import { retainSharedQueries } from "../../react/src/hooks/shared-query";
import { mountWithRealScheduling, registerDom } from "../../react/test/render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "../../react/test/fake-client";
import { recordObservedSessionSequence } from "../../sdk/src/session-sequence";
import type { OpenGeniReactNativeAdapters } from "../src/adapters";
import { OpenGeniReactNativeProvider } from "../src/environment";
import {
  useOpenGeniNativeSession,
  type OpenGeniNativeSessionClient,
} from "../src/use-native-session";

registerDom();

// Every GET answers after this delay, like a network round trip.
const READ_DELAY_MS = 40;

function adapters(): OpenGeniReactNativeAdapters {
  const storage = new Map<string, string>();
  return {
    lifecycle: { currentState: () => "active", subscribe: () => () => undefined },
    persistence: {
      hydrate: async () => undefined,
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
      clear: () => storage.clear(),
      flush: async () => undefined,
      invalidate: async () => undefined,
    },
    crypto: {
      randomUUID: () => crypto.randomUUID(),
      sha256Hex: async () => "00".repeat(32),
    },
    files: {
      pickDocuments: async () => [],
      pickImages: async () => [],
      readBytes: async () => new Uint8Array(),
    },
    fetch: globalThis.fetch,
  };
}

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: "2026-10-17T00:00:00.000Z",
    clientEventId: null,
    turnId: type.startsWith("turn.") || type.startsWith("agent.") ? "turn-1" : null,
  } as SessionEvent;
}

// A settled conversation: a prompt, a reply, a title and status changes. Its
// tail contains events every read hook watches (turn, status and title).
const HISTORY: SessionEvent[] = [
  event(1, "session.created"),
  event(2, "user.message", { text: "Hello" }),
  event(3, "session.status.changed", { status: "running" }),
  event(4, "turn.started"),
  event(5, "agent.message.completed", { text: "Hi there", messageId: "m-1" }),
  event(6, "session.title_set", { title: "Greeting", source: "agent" }),
  event(7, "turn.completed"),
  event(8, "session.status.changed", { status: "idle" }),
];

const SESSION = {
  id: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  status: "idle",
  lastSequence: 8,
  activeTurnId: null,
  title: "Greeting",
  titleSource: "agent",
} as unknown as Session;

function queueSnapshot(): SessionQueueSnapshot {
  return {
    version: 3,
    effectiveControl: { controlVersion: 1 },
    activePersonalConnections: [],
    stoppingPreviousAttempt: false,
    items: [],
    pendingInputs: [],
    pendingInputAttachment: null,
  } as unknown as SessionQueueSnapshot;
}

type Server = {
  client: OpenGeniNativeSessionClient;
  reads: string[];
  /** Reopen the live stream, as a reconnect does. */
  reconnect: () => void;
};

/**
 * A recording client. `observedSequence` is what the projection reads report
 * (the SDK records it from the X-OpenGeni-Session-Sequence header); null is a
 * server or proxy that does not report it.
 */
function server(observedSequence: number | null): Server {
  const reads: string[] = [];
  const opens = new Set<() => void>();
  const delayed =
    <T,>(method: string, value: () => T) =>
    async (..._args: unknown[]): Promise<T> => {
      reads.push(method);
      await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
      const result = value();
      if (observedSequence !== null) {
        recordObservedSessionSequence(result, String(observedSequence));
      }
      return result;
    };
  const client = fakeClient({
    getClientConfig: delayed("getClientConfig", () => ({}) as never),
    getSession: delayed("getSession", () => ({ ...SESSION })),
    getQueue: delayed("getQueue", queueSnapshot),
    getComposerDraft: delayed("getComposerDraft", () => ({
      revision: 0,
      text: "",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: null,
    })) as never,
    listEvents: delayed("listEvents", () => [...HISTORY]) as never,
    listHumanInputRequests: delayed("listHumanInputRequests", () => []) as never,
    getGoal: delayed("getGoal", () => null) as never,
    getSessionLineage: delayed("getSessionLineage", () => ({
      ancestors: [],
      children: [],
      truncated: false,
    })) as never,
    streamEvents: ((_workspaceId: string, _sessionId: string, options: any) => {
      reads.push("streamEvents");
      return (async function* () {
        const open = () => options?.onOpen?.();
        opens.add(open);
        open();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        opens.delete(open);
      })();
    }) as never,
  }) as unknown as OpenGeniNativeSessionClient;
  return {
    client,
    reads,
    reconnect: () => {
      for (const open of opens) open();
    },
  };
}

type Open = {
  /** Reads per method, by name. */
  reads: Record<string, number>;
  /** The first render already showed the timeline (no spinner). */
  paintedAtFirstRender: boolean;
  /** Milliseconds from mount until the timeline was on screen. */
  firstPaintMs: number | null;
  unmount: () => Promise<void>;
};

function counts(reads: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const read of reads) result[read] = (result[read] ?? 0) + 1;
  return result;
}

async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mount the native session screen's controller and let its reads settle. */
async function open(
  backend: Server,
  wrap: (node: ReactNode) => ReactNode = (node) => node,
): Promise<Open> {
  backend.reads.length = 0;
  const startedAt = performance.now();
  let firstPaintMs: number | null = null;
  let renders = 0;
  let paintedAtFirstRender = false;
  function Probe() {
    const controller = useOpenGeniNativeSession({
      client: backend.client,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
    });
    const painted = !controller.initialLoading && controller.timeline.length > 0;
    renders += 1;
    if (renders === 1) paintedAtFirstRender = painted;
    useEffect(() => {
      if (painted && firstPaintMs === null) firstPaintMs = performance.now() - startedAt;
    }, [painted]);
    return null;
  }
  const mounted = mountWithRealScheduling(
    <OpenGeniReactNativeProvider adapters={nativeAdapters}>
      {wrap(<Probe />)}
    </OpenGeniReactNativeProvider>,
  );
  await settle();
  return {
    reads: counts(backend.reads),
    paintedAtFirstRender,
    firstPaintMs,
    unmount: async () => {
      await mounted.unmount();
      // The native provider restores its browser-compatible globals a tick later.
      await settle(10);
    },
  };
}

const nativeAdapters = adapters();

const ONE_READ_EACH = {
  listEvents: 1,
  getSession: 1,
  getQueue: 1,
  getComposerDraft: 1,
  listHumanInputRequests: 1,
  getGoal: 1,
  getSessionLineage: 1,
  streamEvents: 1,
};

describe("opening a conversation in the native session screen", () => {
  test("reads each resource once when every read reports the sequence it reflects", async () => {
    const backend = server(SESSION.lastSequence);
    const cold = await open(backend);
    await cold.unmount();
    expect(cold.reads).toEqual(ONE_READ_EACH);
    expect(cold.paintedAtFirstRender).toBe(false);
    expect(cold.firstPaintMs).not.toBeNull();
  });

  test("re-reads a projection once when the loaded tail holds an event after its read", async () => {
    // The projections were read at sequence 6; the tail then shows the turn
    // completing (7) and the session going idle (8). The detail row is at 8.
    const backend = server(6);
    const cold = await open(backend);
    await cold.unmount();
    expect(cold.reads).toEqual({
      ...ONE_READ_EACH,
      getQueue: 2,
      listHumanInputRequests: 2,
      getSessionLineage: 2,
    });
  });

  test("keeps re-reading after historical events when the server does not report a sequence", async () => {
    const backend = server(null);
    const cold = await open(backend);
    await cold.unmount();
    expect(cold.reads).toEqual({
      ...ONE_READ_EACH,
      getQueue: 2,
      listHumanInputRequests: 2,
      getSessionLineage: 2,
    });
  });

  test("reopening draws the last timeline at once and still reads each resource once", async () => {
    const backend = server(SESSION.lastSequence);
    const release = retainSharedQueries(backend.client);
    try {
      const cold = await open(backend);
      await cold.unmount();
      const reopen = await open(backend);
      await reopen.unmount();
      expect(cold.paintedAtFirstRender).toBe(false);
      expect(reopen.paintedAtFirstRender).toBe(true);
      expect(reopen.reads).toEqual(ONE_READ_EACH);
    } finally {
      release();
    }
  });

  test("keeps nothing for a reopen unless the host retains reads for its client", async () => {
    const backend = server(SESSION.lastSequence);
    const cold = await open(backend);
    await cold.unmount();
    const reopen = await open(backend);
    await reopen.unmount();
    expect(reopen.paintedAtFirstRender).toBe(false);
  });

  test("inside OpenGeniProvider the first stream open re-reads nothing, and a reconnect repairs", async () => {
    const backend = server(SESSION.lastSequence);
    const withProvider = (node: ReactNode) => (
      <OpenGeniProvider client={backend.client as never} workspaceId={WORKSPACE_ID}>
        {node}
      </OpenGeniProvider>
    );
    const opened = await open(backend, withProvider);
    // The provider's API-contract check reads the client config once.
    expect(opened.reads).toEqual({ ...ONE_READ_EACH, getClientConfig: 1 });
    backend.reads.length = 0;
    backend.reconnect();
    await settle();
    await opened.unmount();
    const repaired = counts(backend.reads);
    expect(repaired.getSession).toBe(1);
    expect(repaired.getQueue).toBe(1);
    expect(repaired.listHumanInputRequests).toBe(1);
    expect(repaired.getSessionLineage).toBe(1);
  });
});
