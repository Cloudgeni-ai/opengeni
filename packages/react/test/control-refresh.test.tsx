import { expect, test } from "bun:test";
import type { SessionEvent, WorkspaceControlEvent } from "@opengeni/sdk";
import { OpenGeniContext, type OpenGeniContextValue } from "../src/session-context";
import { useLastStartedTurnPolicy } from "../src/hooks/use-last-started-turn-policy";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

test("control bursts do not refetch model metadata; admitted turns and reconciliation still do", async () => {
  let reads = 0;
  let reconcile: (() => Promise<void>) | undefined;
  const client = fakeClient({
    listTurns: async () => {
      reads++;
      return [];
    },
  });
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
  function Header({ events }: { events: SessionEvent[] }) {
    useLastStartedTurnPolicy(SESSION_ID, { events });
    return null;
  }
  const events: SessionEvent[] = [];
  const render = (event: WorkspaceControlEvent | null, feed = events) => {
    const value = { ...context, workspaceControlEvent: event };
    return (
      <OpenGeniContext.Provider value={value}>
        <Header events={feed} />
      </OpenGeniContext.Provider>
    );
  };
  const mounted = await renderComponent(render(null));
  try {
    await flush();
    expect(reads).toBe(1);
    for (let revision = 1; revision <= 50; revision++) {
      await mounted.rerender(
        render({
          id: `control-${revision}`,
          workspaceId: WORKSPACE_ID,
          sequence: revision,
          revision,
          type: "workspace.control.changed",
          scope: "session",
          rootSessionId: SESSION_ID,
          action: "resume",
          automatic: false,
          reason: null,
          actor: "test",
          occurredAt: new Date().toISOString(),
        }),
      );
    }
    await flush();
    expect(reads).toBe(1);
    await mounted.rerender(
      render(null, [
        {
          id: "turn-started",
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          sequence: 1,
          type: "turn.started",
          payload: {},
          occurredAt: new Date().toISOString(),
        },
      ]),
    );
    await flush();
    expect(reads).toBe(2);
    await actRun(async () => await reconcile?.());
    expect(reads).toBe(3);
  } finally {
    await mounted.unmount();
  }
});
