import { describe, expect, test } from "bun:test";
import { OpenGeniApiError, type SessionEvent, type SessionGoal } from "@opengeni/sdk";
import { retainSharedQueries } from "../src/hooks/shared-query";
import { useGoal } from "../src/hooks/use-goal";
import { useSession } from "../src/hooks/use-session";
import { useSessionLineage } from "../src/hooks/use-session-lineage";
import { useTurnQueue } from "../src/hooks/use-turn-queue";
import { recordObservedSessionSequence } from "../../sdk/src/session-sequence";
import { fakeClient, fakeGoal, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderHook } from "./render-hook";

registerDom();

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
): SessionEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: "2026-10-17T00:00:00.000Z",
  } as SessionEvent;
}

function observed<T extends object>(value: T, sequence: number): T {
  recordObservedSessionSequence(value, String(sequence));
  return value;
}

function queueSnapshot() {
  return { version: 1, items: [], pendingInputs: [] } as never;
}

describe("conversation reads and the event feed's window", () => {
  test("a window that starts after the read re-reads once; a covering window does not", async () => {
    for (const [window, expected] of [
      [[event(5, "agent.message.completed"), event(10, "turn.completed")], 1],
      [[event(50, "agent.message.delta"), event(60, "agent.message.delta")], 2],
    ] as const) {
      let reads = 0;
      const client = fakeClient({
        getQueue: async () => {
          reads += 1;
          return observed(queueSnapshot(), 10);
        },
      });
      const hook = await renderHook(
        (events: SessionEvent[]) =>
          useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
        [] as SessionEvent[],
      );
      await flush(50);
      await hook.rerender([...window]);
      await flush(300);
      expect(reads).toBe(expected);
      await hook.unmount();
    }
  });

  test("a spawn still in flight refreshes lineage; a finished one is covered by the read", async () => {
    for (const [tail, expected] of [
      [[event(3, "agent.toolCall.created", { id: "call-1", name: "session_create" })], 2],
      [
        [
          event(3, "agent.toolCall.created", { id: "call-1", name: "session_create" }),
          event(4, "agent.toolCall.output", { id: "call-1", name: "session_create" }),
        ],
        1,
      ],
    ] as const) {
      let reads = 0;
      const client = fakeClient({
        getSessionLineage: async () => {
          reads += 1;
          return observed({ ancestors: [], children: [], truncated: false } as never, 4);
        },
      });
      const hook = await renderHook(
        (events: SessionEvent[]) =>
          useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
        [] as SessionEvent[],
      );
      await flush(50);
      await hook.rerender([event(1, "session.created"), ...tail]);
      await flush(300);
      // The in-flight spawn reads now and once more after the child commits.
      expect(reads).toBe(expected);
      await hook.unmount();
    }
  });

  test("a goal event during the read of a self-streamed goal re-reads", async () => {
    let reads = 0;
    let releaseRead: (() => void) | null = null;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const client = fakeClient({
      getSession: async () => ({ id: SESSION_ID, lastSequence: 1 }) as never,
      findGoal: async () => {
        reads += 1;
        if (reads === 1) {
          await readReleased;
          return observed(fakeGoal(), 1);
        }
        return observed(fakeGoal({ status: "paused", pausedReason: "api" }), 2);
      },
      streamEvents: async function* () {
        yield event(2, "goal.paused");
        await new Promise(() => undefined);
      } as never,
    });
    const hook = await renderHook(
      () => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(50);
    releaseRead!();
    await flush(300);
    expect(reads).toBe(2);
    expect(hook.result.current.isPaused).toBe(true);
    await hook.unmount();
  });
});

describe("retained conversation views", () => {
  test("a denied reopen stops showing what was kept", async () => {
    let denied = false;
    const client = fakeClient({
      getSession: async () => {
        if (denied) throw new OpenGeniApiError(403, "forbidden");
        return { id: SESSION_ID, status: "idle", lastSequence: 1, title: "Private" } as never;
      },
    });
    const release = retainSharedQueries(client);
    try {
      const first = await renderHook(
        () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      await flush(50);
      expect(first.result.current.session?.title).toBe("Private");
      await first.unmount();

      denied = true;
      const reopened = await renderHook(
        () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      await flush(50);
      expect(reopened.result.current.session).toBeNull();
      await reopened.unmount();

      // Nothing is kept for a later reopen either.
      let releaseRead: (() => void) | null = null;
      denied = false;
      const slowClient = client as { getSession: (...args: never[]) => Promise<unknown> };
      const original = slowClient.getSession;
      slowClient.getSession = async (...args) => {
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        return original(...args);
      };
      const again = await renderHook(
        () => useSession(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      expect(again.result.current.session).toBeNull();
      releaseRead?.();
      await again.unmount();
    } finally {
      release();
    }
  });

  test("a goal read as gone is not shown again on the next reopen", async () => {
    let current: SessionGoal | null = fakeGoal();
    let holdReads = false;
    let releaseRead: (() => void) | null = null;
    const client = fakeClient({
      findGoal: async () => {
        if (holdReads) {
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        }
        return current;
      },
    });
    const release = retainSharedQueries(client);
    const mount = () =>
      renderHook(() => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID }), undefined);
    try {
      const first = await mount();
      await flush(50);
      expect(first.result.current.goal).not.toBeNull();
      await first.unmount();

      current = null;
      const second = await mount();
      await flush(50);
      expect(second.result.current.goal).toBeNull();
      await second.unmount();

      holdReads = true;
      const third = await mount();
      expect(third.result.current.goal).toBeNull();
      releaseRead?.();
      await flush(10);
      await third.unmount();
    } finally {
      release();
    }
  });

  test("a command on a retained goal that was replaced meanwhile does nothing", async () => {
    const original = fakeGoal({ text: "Old objective" });
    let current: SessionGoal = original;
    let holdReads = false;
    let releaseRead: (() => void) | null = null;
    let updates = 0;
    const client = fakeClient({
      findGoal: async () => {
        if (holdReads) {
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        }
        return current;
      },
      updateGoal: async () => {
        updates += 1;
        return current;
      },
    });
    const release = retainSharedQueries(client);
    const mount = () =>
      renderHook(() => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID }), undefined);
    try {
      const first = await mount();
      await flush(50);
      await first.unmount();

      // Another actor replaces the objective while the conversation is closed.
      current = fakeGoal({ text: "New objective" });
      holdReads = true;
      const reopened = await mount();
      expect(reopened.result.current.goal?.text).toBe("Old objective");
      let paused: Promise<SessionGoal | null> | null = null;
      paused = reopened.result.current.pause("aimed at the old objective");
      await flush(10);
      releaseRead?.();
      await flush(50);
      expect(await paused).toBeNull();
      expect(updates).toBe(0);
      expect(reopened.result.current.goal?.text).toBe("New objective");
      await reopened.unmount();
    } finally {
      release();
    }
  });
});
