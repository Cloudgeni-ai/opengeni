import { expect, test } from "bun:test";
import { useMemo } from "react";
import {
  OpenGeniClient,
  type SessionQueueSnapshot,
  type WorkspaceControlEvent,
} from "@opengeni/sdk";
import { OpenGeniContext, type OpenGeniContextValue } from "../src/session-context";
import { useTurnQueue, type UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import { SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function snapshot(version: number, stopping: boolean): SessionQueueSnapshot {
  return {
    version,
    effectiveControl: {
      state: "paused",
      controlVersion: 4,
      controlEtag: "control-4",
      directState: "paused",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    stoppingPreviousAttempt: stopping,
    items: [],
    pendingInputs: [],
    pendingInputAttachment: null,
    activePersonalConnections: [],
  };
}

function controlEvent(revision: number): WorkspaceControlEvent {
  return {
    id: `control-${revision}`,
    workspaceId: WORKSPACE_ID,
    sequence: revision,
    revision,
    type: "workspace.control.changed",
    scope: "session",
    rootSessionId: SESSION_ID,
    action: "pause",
    automatic: false,
    reason: null,
    actor: "test",
    occurredAt: new Date().toISOString(),
  };
}

test("reconnect and workspace-control reads do not adopt a queue read that started before them", async () => {
  // Reads in `stale` started while the paused attempt was still stopping and
  // answer only after it quiesced; every other read sees the settled state.
  const stale = new Map<number, () => void>();
  let requests = 0;
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async () => {
      requests += 1;
      const request = requests;
      const stopping = request === 1 || stale.has(request);
      if (stale.has(request)) {
        await new Promise<void>((resolve) => stale.set(request, resolve));
      }
      return new Response(JSON.stringify(snapshot(request, stopping)), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  let reconcile: (() => Promise<void>) | undefined;
  const context: OpenGeniContextValue = {
    client,
    workspaceId: WORKSPACE_ID,
    workspaceControlEvent: null,
    workspaceControlConnectionState: "live",
    workspaceInteractionEvent: null,
    workspaceInteractionConnectionState: "live",
    registerSessionReconciler: (_id, _key, callback) => {
      reconcile = callback;
      return () => {};
    },
    reconcileSession: async () => {},
  };
  const result: { current: UseTurnQueueResult | null } = { current: null };
  function Queue() {
    result.current = useTurnQueue(SESSION_ID, { events: [] });
    return null;
  }
  function Harness({ event }: { event: WorkspaceControlEvent | null }) {
    const value = useMemo(() => ({ ...context, workspaceControlEvent: event }), [event]);
    return (
      <OpenGeniContext.Provider value={value}>
        <Queue />
      </OpenGeniContext.Provider>
    );
  }
  const startStaleRead = async () => {
    stale.set(requests + 1, () => {});
    const read = client.getQueue(WORKSPACE_ID, SESSION_ID);
    await flush();
    // Wrapped so awaiting this helper does not wait for the gated read.
    return { read };
  };
  const releaseStale = () => {
    for (const [request, release] of stale) {
      release();
      stale.delete(request);
    }
  };

  const mounted = await renderComponent(<Harness event={null} />);
  try {
    await flush();
    expect(requests).toBe(1);
    expect(result.current?.stoppingPreviousAttempt).toBe(true);

    // A reconnect reconciliation while an older read is still in flight.
    let { read: staleRead } = await startStaleRead();
    expect(requests).toBe(2);
    let reconciled: Promise<void> | undefined;
    await actRun(async () => {
      reconciled = reconcile?.();
    });
    releaseStale();
    await actRun(async () => {
      await staleRead;
      await reconciled;
    });
    await flush();
    expect(requests).toBe(3);
    expect(result.current?.snapshot?.version).toBe(3);
    expect(result.current?.stoppingPreviousAttempt).toBe(false);

    // A workspace control event while an older read is still in flight.
    ({ read: staleRead } = await startStaleRead());
    expect(requests).toBe(4);
    await mounted.rerender(<Harness event={controlEvent(1)} />);
    await flush();
    releaseStale();
    await actRun(async () => {
      await staleRead;
    });
    await flush();
    expect(requests).toBe(5);
    expect(result.current?.snapshot?.version).toBe(5);
    expect(result.current?.stoppingPreviousAttempt).toBe(false);
  } finally {
    await mounted.unmount();
  }
});
