/* ----------------------------------------------------------------------------
   Read hooks ride out transient failures (an API rolling deploy or a network
   blip) quietly: loading or the last data stays on screen while they retry,
   an error surfaces only after the quiet window, retries continue in the
   background, and a later success recovers on its own. Definitive errors
   (401/403/404, other statuses) stay exactly as visible as before.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import {
  OpenGeniApiError,
  type Session,
  type SessionEvent,
  type SessionQueueSnapshot,
  type SessionTurn,
} from "@opengeni/sdk";

import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";
import { fakeClient, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { useTurnQueue } from "../src/hooks/use-turn-queue";
import { useSession } from "../src/hooks/use-session";
import { useSessionEvents } from "../src/hooks/use-session-events";
import { DEFAULT_TRANSIENT_READ_RETRY, usePolledValue } from "../src/hooks/internal";
import { OpenGeniProvider } from "../src/provider";

registerDom({ clock: "virtual" });

const session = {
  id: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  lastSequence: 0,
  title: "Deploy-safe",
  titleSource: "user",
} as Session;

const unavailable = () => new OpenGeniApiError(503, "", { mutation: false });
const parked = () =>
  new OpenGeniApiError(503, JSON.stringify({ error: "maintenance" }), { mutation: false });

function queueSnapshot(items: SessionTurn[]): SessionQueueSnapshot {
  return {
    version: 1,
    effectiveControl: {
      state: "active",
      controlVersion: 1,
      controlEtag: "control-1",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    stoppingPreviousAttempt: false,
    items,
    pendingInputs: [],
    pendingInputAttachment: null,
    activePersonalConnections: [],
  } as SessionQueueSnapshot;
}

function event(sequence: number): SessionEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type: "user.message",
    payload: { text: `message ${sequence}` },
    occurredAt: "2026-10-22T12:00:00.000Z",
  } as SessionEvent;
}

describe("useSession transient read retry", () => {
  test("keeps loading through transient failures and recovers without an error", async () => {
    let calls = 0;
    const client = fakeClient({
      getSession: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        if (calls === 2) throw unavailable();
        return session;
      },
    });
    const errors: Array<Error | null> = [];
    const hook = await renderHook(() => {
      const result = useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] });
      errors.push(result.error);
      return result;
    }, undefined);
    await flush();
    expect(calls).toBe(1);
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.error).toBeNull();

    await flush(1_500);
    expect(calls).toBe(2);
    expect(hook.result.current.loading).toBe(true);

    await flush(3_000);
    expect(calls).toBe(3);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.session?.title).toBe("Deploy-safe");
    // No render ever exposed an error.
    expect(errors.every((error) => error === null)).toBe(true);
    await hook.unmount();
  });

  test("a persistent transient failure surfaces once after the quiet window, keeps retrying, then recovers", async () => {
    let failing = true;
    let calls = 0;
    const client = fakeClient({
      getSession: async () => {
        calls += 1;
        if (failing) throw unavailable();
        return session;
      },
    });
    const hook = await renderHook(
      () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    await flush(DEFAULT_TRANSIENT_READ_RETRY.quietWindowMs - 3_000);
    expect(calls).toBeGreaterThan(3);
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.error).toBeNull();

    await flush(8_000);
    const surfaced = hook.result.current.error;
    expect(surfaced).toBeInstanceOf(OpenGeniApiError);
    expect(hook.result.current.loading).toBe(false);

    // Background retries continue without replacing (re-announcing) the error.
    const before = calls;
    await flush(DEFAULT_TRANSIENT_READ_RETRY.backgroundDelayMs * 1.3);
    expect(calls).toBeGreaterThan(before);
    expect(hook.result.current.error).toBe(surfaced);

    failing = false;
    await flush(DEFAULT_TRANSIENT_READ_RETRY.backgroundDelayMs * 1.3);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.session?.id).toBe(SESSION_ID);
    await hook.unmount();
  });

  test("Try again (refresh) after a surfaced transient error recovers at once", async () => {
    let failing = true;
    const client = fakeClient({
      getSession: async () => {
        if (failing) throw new TypeError("Failed to fetch");
        return session;
      },
    });
    const hook = await renderHook(
      () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    await flush(DEFAULT_TRANSIENT_READ_RETRY.quietWindowMs + 6_000);
    expect(hook.result.current.error).toBeInstanceOf(TypeError);
    failing = false;
    await actRun(() => hook.result.current.refresh());
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.session?.id).toBe(SESSION_ID);
    await hook.unmount();
  });

  test.each([401, 403, 404, 500])(
    "a definitive %i surfaces at once and is not retried",
    async (status) => {
      let calls = 0;
      const client = fakeClient({
        getSession: async () => {
          calls += 1;
          throw new OpenGeniApiError(status, "", { mutation: false });
        },
      });
      const hook = await renderHook(
        () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
        undefined,
      );
      await flush();
      expect(hook.result.current.error).toMatchObject({ status });
      expect(hook.result.current.loading).toBe(false);
      await flush(60_000);
      expect(calls).toBe(1);
      await hook.unmount();
    },
  );

  test("a transient refresh failure keeps the loaded session on screen without an error", async () => {
    let failing = false;
    const client = fakeClient({
      getSession: async () => {
        if (failing) throw unavailable();
        return session;
      },
    });
    const hook = await renderHook(
      () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    await flush();
    expect(hook.result.current.session?.id).toBe(SESSION_ID);
    failing = true;
    await actRun(() => hook.result.current.refresh());
    await flush(5_000);
    expect(hook.result.current.session?.id).toBe(SESSION_ID);
    expect(hook.result.current.error).toBeNull();
    failing = false;
    await flush(5_000);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });
});

describe("usePolledValue transient retry", () => {
  test("transientRetry: false surfaces a transient failure at once", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    };
    const hook = await renderHook(() => usePolledValue(load, { transientRetry: false }), undefined);
    await flush();
    expect(hook.result.current.error).toBeInstanceOf(TypeError);
    await flush(30_000);
    expect(calls).toBe(1);
    await hook.unmount();
  });

  test("a disabled query schedules no background retries", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    };
    const hook = await renderHook(
      (enabled: boolean) => usePolledValue(load, { enabled }),
      true as boolean,
    );
    await flush(500);
    expect(calls).toBe(1);
    await hook.rerender(false);
    await flush(60_000);
    expect(calls).toBe(1);
    await hook.unmount();
  });
});

describe("useSessionEvents transient retry", () => {
  test("a transient initial tail failure restarts quietly and loads the conversation", async () => {
    let calls = 0;
    const client = fakeClient({
      listEvents: async () => {
        calls += 1;
        if (calls <= 2) throw new TypeError("Failed to fetch");
        return [event(1)];
      },
      streamEvents: (_workspaceId, _sessionId, options = {}) =>
        (async function* () {
          options.onOpen?.();
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield* [];
        })(),
    });
    const errors: Array<Error | null> = [];
    const hook = await renderHook(() => {
      const result = useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID });
      errors.push(result.error);
      return result;
    }, undefined);
    await flush(20);
    expect(hook.result.current.initialLoading).toBe(true);
    expect(hook.result.current.connectionState).toBe("connecting");
    await flush(5_000);
    expect(calls).toBe(3);
    expect(hook.result.current.initialLoading).toBe(false);
    expect(hook.result.current.events.map((row) => row.sequence)).toEqual([1]);
    expect(errors.every((error) => error === null)).toBe(true);
    await hook.unmount();
  });

  test("a persistent transient tail failure surfaces once after the quiet window and recovers", async () => {
    let failing = true;
    const client = fakeClient({
      listEvents: async () => {
        if (failing) throw unavailable();
        return [event(1)];
      },
      streamEvents: (_workspaceId, _sessionId, options = {}) =>
        (async function* () {
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield* [];
        })(),
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(DEFAULT_TRANSIENT_READ_RETRY.quietWindowMs - 3_000);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.initialLoading).toBe(true);

    await flush(8_000);
    const surfaced = hook.result.current.error;
    expect(surfaced).toBeInstanceOf(OpenGeniApiError);
    expect(hook.result.current.connectionState).toBe("error");
    expect(hook.result.current.initialLoading).toBe(false);

    await flush(DEFAULT_TRANSIENT_READ_RETRY.backgroundDelayMs * 1.3);
    expect(hook.result.current.error).toBe(surfaced);

    failing = false;
    await flush(DEFAULT_TRANSIENT_READ_RETRY.backgroundDelayMs * 1.3);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.events.map((row) => row.sequence)).toEqual([1]);
    await hook.unmount();
  });

  test("a stream suspended while hidden starts a fresh quiet window when the page returns", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const setVisibility = async (next: DocumentVisibilityState) => {
      visibility = next;
      await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
    };
    let failing = true;
    const client = fakeClient({
      listEvents: async () => {
        if (failing) throw unavailable();
        return [event(1)];
      },
      streamEvents: (_workspaceId, _sessionId, options = {}) =>
        (async function* () {
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield* [];
        })(),
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      // A quiet streak is under way when the tab is hidden past its grace.
      await flush(DEFAULT_TRANSIENT_READ_RETRY.quietWindowMs / 2);
      expect(hook.result.current.error).toBeNull();
      await setVisibility("hidden");
      await flush(60_000);
      expect(hook.result.current.connectionState).toBe("idle");

      // Back after a minute: the next transient failure is quiet again
      // instead of counting the hidden time against the quiet window.
      await setVisibility("visible");
      await flush(3_000);
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.connectionState).toBe("connecting");

      failing = false;
      await flush(8_000);
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.events.map((row) => row.sequence)).toEqual([1]);
    } finally {
      await hook.unmount();
      if (originalVisibility) {
        Object.defineProperty(document, "visibilityState", originalVisibility);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
  });

  test("a definitive tail failure still surfaces at once", async () => {
    let calls = 0;
    const client = fakeClient({
      listEvents: async () => {
        calls += 1;
        throw new OpenGeniApiError(403, "", { mutation: false });
      },
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(20);
    expect(hook.result.current.error).toMatchObject({ status: 403 });
    expect(hook.result.current.connectionState).toBe("error");
    await flush(60_000);
    expect(calls).toBe(1);
    await hook.unmount();
  });

  test("a transient reconciliation failure after the stream opens retries quietly", async () => {
    // A reconnect during an API rollout re-reads the deployment contract; the
    // pod it lands on may still be starting.
    let failConfig = true;
    let failedConfigReads = 0;
    const healthy = fakeClient({});
    const client = fakeClient({
      getClientConfig: async () => {
        if (failConfig) {
          failedConfigReads += 1;
          throw new TypeError("Failed to fetch");
        }
        return await healthy.getClientConfig!();
      },
      listEvents: async () => [event(1)],
      streamEvents: (_workspaceId, _sessionId, options = {}) =>
        (async function* () {
          options.onOpen?.();
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield* [];
        })(),
    });
    const errors: Array<Error | null> = [];
    let current: ReturnType<typeof useSessionEvents> | undefined;
    function Observe() {
      current = useSessionEvents(SESSION_ID);
      errors.push(current.error);
      return null;
    }
    const rendered = await renderComponent(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <Observe />
      </OpenGeniProvider>,
    );
    try {
      await flush(2_500);
      expect(failedConfigReads).toBeGreaterThan(0);
      expect(current?.events.map((row) => row.sequence)).toEqual([1]);
      failConfig = false;
      await flush(10_000);
      expect(errors.every((error) => error === null)).toBe(true);
      expect(current?.error).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});

describe("maintenance marker", () => {
  test("a session read stays quiet for as long as the update lasts, then recovers", async () => {
    let parkedReads = true;
    let calls = 0;
    const client = fakeClient({
      getSession: async () => {
        calls += 1;
        if (parkedReads) throw parked();
        return session;
      },
    });
    const hook = await renderHook(
      () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    // Far past the quiet window: still loading, no error, still checking
    // at least every few seconds.
    await flush(10 * 60_000);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.session).toBeNull();
    expect(calls).toBeGreaterThan((10 * 60_000) / 10_000);
    parkedReads = false;
    await flush(10_000);
    expect(hook.result.current.session?.title).toBe("Deploy-safe");
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("the event stream keeps reconnecting quietly through an update", async () => {
    let parkedReads = true;
    const client = fakeClient({
      listEvents: async () => {
        if (parkedReads) throw parked();
        return [event(1)];
      },
      streamEvents: (_workspaceId, _sessionId, options = {}) =>
        (async function* () {
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          yield* [];
        })(),
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(10 * 60_000);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.connectionState).not.toBe("error");
    parkedReads = false;
    await flush(10_000);
    expect(hook.result.current.events.map((row) => row.sequence)).toEqual([1]);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });
});

describe("useTurnQueue transient retry", () => {
  const queued = fakeTurn({ id: "queued-turn", prompt: "queued prompt" });

  test("keeps the last queue through an update, without an error, and recovers", async () => {
    let failing: (() => Error) | null = null;
    let reads = 0;
    const client = fakeClient({
      getQueue: async () => {
        reads += 1;
        if (failing) throw failing();
        return queueSnapshot([queued]);
      },
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    await flush(10);
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["queued-turn"]);

    failing = parked;
    await actRun(() => hook.result.current.refresh());
    const readsAtPark = reads;
    await flush(10 * 60_000);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["queued-turn"]);
    expect(reads).toBeGreaterThan(readsAtPark + 10);

    failing = null;
    await flush(10_000);
    const settled = reads;
    expect(hook.result.current.error).toBeNull();
    await flush(60_000);
    // Recovered: the background retry loop stopped.
    expect(reads).toBe(settled);
    await hook.unmount();
  });

  test("a lasting gateway failure surfaces once after the quiet window", async () => {
    let failing = true;
    const client = fakeClient({
      getQueue: async () => {
        if (failing) throw unavailable();
        return queueSnapshot([queued]);
      },
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    await flush(DEFAULT_TRANSIENT_READ_RETRY.quietWindowMs - 3_000);
    expect(hook.result.current.error).toBeNull();
    await flush(8_000);
    const surfaced = hook.result.current.error;
    expect(surfaced).toBeInstanceOf(OpenGeniApiError);
    await flush(DEFAULT_TRANSIENT_READ_RETRY.backgroundDelayMs * 1.3);
    expect(hook.result.current.error).toBe(surfaced);
    failing = false;
    await flush(DEFAULT_TRANSIENT_READ_RETRY.backgroundDelayMs * 1.3);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["queued-turn"]);
    await hook.unmount();
  });

  test("a hidden page stops retrying the queue and reads again when shown", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const setVisibility = async (next: DocumentVisibilityState) => {
      visibility = next;
      await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
    };
    let failing = true;
    let reads = 0;
    const client = fakeClient({
      getQueue: async () => {
        reads += 1;
        if (failing) throw parked();
        return queueSnapshot([queued]);
      },
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    try {
      await flush(30_000);
      expect(reads).toBeGreaterThan(3);
      await setVisibility("hidden");
      // Past the hidden-tab grace, then no read for ten minutes.
      await flush(10_000);
      const readsWhileHidden = reads;
      await flush(10 * 60_000);
      expect(reads).toBe(readsWhileHidden);

      failing = false;
      await setVisibility("visible");
      await flush(10);
      expect(reads).toBe(readsWhileHidden + 1);
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["queued-turn"]);
    } finally {
      await hook.unmount();
      if (originalVisibility) {
        Object.defineProperty(document, "visibilityState", originalVisibility);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
  });

  test("a definitive queue failure surfaces at once and is not retried", async () => {
    let reads = 0;
    const client = fakeClient({
      getQueue: async () => {
        reads += 1;
        throw new OpenGeniApiError(403, "", { mutation: false });
      },
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    await flush(10);
    expect(hook.result.current.error).toBeInstanceOf(OpenGeniApiError);
    await flush(60_000);
    expect(reads).toBe(1);
    await hook.unmount();
  });
});
