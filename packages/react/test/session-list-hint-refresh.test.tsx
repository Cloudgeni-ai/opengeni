import { expect, test } from "bun:test";
import { useMemo } from "react";
import type { WorkspaceSessionListEvent } from "@opengeni/sdk";
import { OpenGeniContext, type OpenGeniContextValue } from "../src/session-context";
import { useSessionListHintRefresh } from "../src/app/lib/use-session-list-hint-refresh";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const hint = (
  sessionIds: string[] | null,
  siteSessionIds?: string[],
): WorkspaceSessionListEvent => ({
  type: "workspace.sessions.changed",
  workspaceId: WORKSPACE_ID,
  available: true,
  sessionIds,
  ...(siteSessionIds ? { siteSessionIds } : {}),
});

test("hints that only name Site conversations do not refetch ordinary lists", async () => {
  let refreshes = 0;
  const refresh = async () => {
    refreshes++;
  };
  const context: OpenGeniContextValue = {
    client: fakeClient({}),
    workspaceId: WORKSPACE_ID,
    workspaceControlEvent: null,
    workspaceControlConnectionState: "live",
    workspaceInteractionEvent: null,
    workspaceInteractionConnectionState: "live",
    registerSessionReconciler: () => () => {},
    reconcileSession: async () => {},
  };
  function List() {
    useSessionListHintRefresh(refresh, null);
    return null;
  }
  function Harness({ event }: { event: WorkspaceSessionListEvent }) {
    const value = useMemo(() => ({ ...context, workspaceSessionListEvent: event }), [event]);
    return (
      <OpenGeniContext.Provider value={value}>
        <List />
      </OpenGeniContext.Provider>
    );
  }
  const mounted = await renderComponent(<Harness event={hint(null)} />);
  try {
    await flush();
    expect(refreshes).toBe(1);
    await mounted.rerender(<Harness event={hint([], ["site-conversation"])} />);
    await flush();
    expect(refreshes).toBe(1);
    await mounted.rerender(<Harness event={hint(["session-a"], ["site-conversation"])} />);
    await flush();
    expect(refreshes).toBe(2);
    await mounted.rerender(<Harness event={hint(["session-b"])} />);
    await flush();
    expect(refreshes).toBe(3);
  } finally {
    await mounted.unmount();
  }
});
