import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { useEffect } from "react";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";
import {
  useSessionEvents,
  type UseSessionEventsOptions,
  type UseSessionEventsResult,
} from "../src/hooks/use-session-events";

registerDom();

const SECOND_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const actions = ["jumpToSequence", "loadOlder", "loadOldest", "loadNewer"] as const;
type Action = (typeof actions)[number];
type Props = UseSessionEventsOptions & { sessionId: string };

function fixture() {
  let reads = 0;
  let readOverride: ((page: SessionEvent[]) => Promise<SessionEvent[]>) | null = null;
  const signals: AbortSignal[] = [];
  const client = fakeClient({
    listEvents: async (workspaceId, sessionId, options = {}) => {
      reads++;
      const events: SessionEvent[] = Array.from({ length: 800 }, (_, index) => ({
        id: `${workspaceId}-${sessionId}-${index + 1}`,
        workspaceId,
        sessionId,
        sequence: index + 1,
        type: "user.message",
        payload: { text: `message ${index + 1}`, routing: "accepted_for_execution" },
        occurredAt: "2026-09-29T00:00:00.000Z",
        clientEventId: null,
        turnId: null,
      }));
      const selected = events.filter(
        (event) =>
          event.sequence > (options.after ?? 0) &&
          (options.before === undefined || event.sequence < options.before),
      );
      const page =
        options.before !== undefined || options.direction === "before"
          ? selected.slice(-(options.limit ?? 500))
          : selected.slice(0, options.limit ?? 500);
      return readOverride ? readOverride(page) : page;
    },
    streamEvents: (_workspaceId, _sessionId, options = {}) => {
      if (options.signal) signals.push(options.signal);
      return (async function* () {})();
    },
  });
  return {
    client,
    signals,
    reads: () => reads,
    override: (read: ((page: SessionEvent[]) => Promise<SessionEvent[]>) | null) => {
      readOverride = read;
    },
  };
}

function invoke(result: UseSessionEventsResult, action: Action) {
  return action === "jumpToSequence" ? result.jumpToSequence(400) : result[action]();
}

describe("session event navigation ownership", () => {
  test("an old exact target cannot supersede a pending replacement target", async () => {
    const first = fixture();
    const second = fixture();
    const hook = await renderHook(
      ({ client }) => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      { client: first.client },
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await flush(20);
      const old = hook.result.current;
      await hook.rerender({ client: second.client });
      second.override(async (page) => {
        await gate;
        return page;
      });
      let pending!: Promise<boolean>;
      await actRun(() => {
        pending = hook.result.current.jumpToSequence(600);
      });
      expect(hook.result.current.loadingTarget).toBe(true);
      const reads = first.reads();
      await actRun(async () => expect(await old.jumpToSequence(400)).toBe(false));
      expect(first.reads()).toBe(reads);
      expect(hook.result.current.loadingTarget).toBe(true);
      release();
      await actRun(async () => expect(await pending).toBe(true));
      expect(hook.result.current.loadingTarget).toBe(false);
      expect(hook.result.current.events.some((event) => event.sequence === 600)).toBe(true);
    } finally {
      release();
      await hook.unmount();
    }
  });

  test("an old exact target cannot stop the replacement live stream or leave its loading flag set", async () => {
    const source = fixture();
    const hook = await renderHook(
      (sessionId: string) =>
        useSessionEvents(sessionId, { client: source.client, workspaceId: WORKSPACE_ID }),
      SESSION_ID as string,
    );
    try {
      await flush(20);
      const old = hook.result.current;
      await hook.rerender(SECOND_SESSION_ID);
      await flush(20);
      const stream = source.signals.at(-1)!;
      expect(stream.aborted).toBe(false);
      const reads = source.reads();
      await actRun(async () => expect(await old.jumpToSequence(1)).toBe(false));
      expect(hook.result.current.loadingTarget).toBe(false);
      expect(stream.aborted).toBe(false);
      expect(source.reads()).toBe(reads);
      expect(
        hook.result.current.events.every((event) => event.sessionId === SECOND_SESSION_ID),
      ).toBe(true);
    } finally {
      await hook.unmount();
    }
  });

  for (const action of [...actions, "jumpToLatest", "jumpToLatestQuestion"] as const) {
    test(`old ${action} cannot regain ownership after switching away and back`, async () => {
      const source = fixture();
      const hook = await renderHook(
        (sessionId: string) =>
          useSessionEvents(sessionId, { client: source.client, workspaceId: WORKSPACE_ID }),
        SESSION_ID as string,
      );
      try {
        await flush(20);
        await actRun(() => hook.result.current.jumpToSequence(500));
        const old = hook.result.current;
        await hook.rerender(SECOND_SESSION_ID);
        await hook.rerender(SESSION_ID);
        await flush(20);
        await actRun(() => hook.result.current.jumpToSequence(500));
        const current = hook.result.current;
        const reads = source.reads();
        await actRun(async () => {
          if (action === "jumpToLatest") await old.jumpToLatest();
          else if (action === "jumpToLatestQuestion")
            expect(await old.jumpToLatestQuestion()).toBeNull();
          else expect(await invoke(old, action)).toBe(false);
        });
        expect(source.reads()).toBe(reads);
        expect(hook.result.current.events).toBe(current.events);
        expect(hook.result.current.loadingTarget).toBe(false);
        expect(hook.result.current.initialLoading).toBe(false);
      } finally {
        await hook.unmount();
      }
    });
  }

  for (const action of actions) {
    test(`current ${action} errors remain actionable and retryable`, async () => {
      const source = fixture();
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client: source.client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await flush(20);
        await actRun(() => hook.result.current.jumpToSequence(500));
        const failure = new Error("current read unauthorized");
        source.override(async () => {
          throw failure;
        });
        await actRun(async () => {
          await expect(invoke(hook.result.current, action)).rejects.toBe(failure);
        });
        expect(hook.result.current.loadingTarget).toBe(false);
        expect(hook.result.current.loadingOlder).toBe(false);
        expect(hook.result.current.loadingOldest).toBe(false);
        expect(hook.result.current.loadingNewer).toBe(false);
        source.override(null);
        await actRun(() => invoke(hook.result.current, action));
        expect(hook.result.current.error).toBeNull();
      } finally {
        await hook.unmount();
      }
    });

    test(`old ${action} is fenced before passive identity cleanup`, async () => {
      const first = fixture();
      const second = fixture();
      let passiveClient = first.client;
      const hook = await renderHook(
        ({ client }) => {
          const result = useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID });
          useEffect(() => {
            passiveClient = client;
          }, [client]);
          return result;
        },
        { client: first.client },
      );
      try {
        await flush(20);
        await actRun(() => hook.result.current.jumpToSequence(500));
        const old = hook.result.current;
        const reads = first.reads();
        await hook.rerenderThroughLayout({ client: second.client });
        expect(passiveClient).toBe(first.client);
        expect(await invoke(old, action)).toBe(false);
        expect(first.reads()).toBe(reads);
        await flush();
        expect(hook.result.current.events).toBe(old.events);
        expect(hook.result.current.loadingTarget).toBe(false);
      } finally {
        await hook.unmount();
      }
    });

    for (const outcome of ["resolve", "reject"] as const) {
      test(`pending ${action} ${outcome} is inert before passive identity cleanup`, async () => {
        const first = fixture();
        const second = fixture();
        let passiveClient = first.client;
        const hook = await renderHook(
          ({ client }) => {
            const result = useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID });
            useEffect(() => {
              passiveClient = client;
            }, [client]);
            return result;
          },
          { client: first.client },
        );
        let resolve!: (events: SessionEvent[]) => void;
        let reject!: (error: Error) => void;
        const gate = new Promise<SessionEvent[]>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        try {
          await flush(20);
          await actRun(() => hook.result.current.jumpToSequence(500));
          const previous = hook.result.current.events;
          first.override(() => gate);
          let pending!: Promise<boolean>;
          await actRun(() => {
            pending = invoke(hook.result.current, action);
          });
          const reads = first.reads();
          await hook.rerenderThroughLayout({ client: second.client });
          expect(passiveClient).toBe(first.client);
          if (outcome === "reject") reject(new Error("old client no longer authorized"));
          else
            resolve([
              { ...previous[0]!, id: "stale-page", sequence: action === "loadNewer" ? 750 : 100 },
            ]);
          expect(await pending).toBe(false);
          expect(first.reads()).toBe(reads);
          await flush();
          expect(hook.result.current.events).toBe(previous);
          expect(hook.result.current.error).toBeNull();
          expect(hook.result.current.loadingTarget).toBe(false);
          expect(hook.result.current.loadingOlder).toBe(false);
          expect(hook.result.current.loadingOldest).toBe(false);
          expect(hook.result.current.loadingNewer).toBe(false);
        } finally {
          await hook.unmount();
        }
      });
    }
  }

  for (const identity of [
    "session",
    "workspace",
    "client",
    "after",
    "replay",
    "enabled",
  ] as const) {
    for (const action of actions) {
      test(`old ${action} is inert after ${identity} replacement`, async () => {
        const first = fixture();
        const second = fixture();
        const initial: Props = {
          client: first.client,
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
        };
        const replacement: Props = {
          ...initial,
          ...(identity === "session" ? { sessionId: SECOND_SESSION_ID } : {}),
          ...(identity === "workspace" ? { workspaceId: SECOND_WORKSPACE_ID } : {}),
          ...(identity === "client" ? { client: second.client } : {}),
          ...(identity === "after" ? { after: 100 } : {}),
          ...(identity === "replay" ? { replay: "full" } : {}),
          ...(identity === "enabled" ? { enabled: false } : {}),
        };
        const hook = await renderHook(
          ({ sessionId, ...options }: Props) => useSessionEvents(sessionId, options),
          initial,
        );
        try {
          await flush(20);
          await actRun(async () =>
            expect(await hook.result.current.jumpToSequence(500)).toBe(true),
          );
          const old = hook.result.current;
          await hook.rerender(replacement);
          await flush(20);
          await actRun(async () =>
            expect(await hook.result.current.jumpToSequence(500)).toBe(true),
          );
          const current = hook.result.current;
          expect(current.hasOlder).toBe(true);
          expect(current.hasNewer).toBe(true);
          const reads = first.reads() + second.reads();
          await actRun(async () => expect(await invoke(old, action)).toBe(false));
          expect(first.reads() + second.reads()).toBe(reads);
          expect(hook.result.current.events).toBe(current.events);
          expect(hook.result.current.loadingTarget).toBe(false);
          expect(hook.result.current.loadingOlder).toBe(false);
          expect(hook.result.current.loadingOldest).toBe(false);
          expect(hook.result.current.loadingNewer).toBe(false);
          expect(hook.result.current.hasOlder).toBe(true);
          expect(hook.result.current.hasNewer).toBe(true);
          expect(hook.result.current.error).toBeNull();
          // A rejected old callback must not poison the replacement's navigation.
          await actRun(async () =>
            expect(await hook.result.current.jumpToSequence(600)).toBe(true),
          );
        } finally {
          await hook.unmount();
        }
      });
    }
  }
});
