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

function harness(options?: { siteConversations: boolean }) {
  const counter = { refreshes: 0 };
  const refresh = async () => {
    counter.refreshes++;
  };
  function List() {
    useSessionListHintRefresh(refresh, null, options);
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
  return { counter, Harness };
}

test("hints that only name Site conversations do not refetch ordinary lists", async () => {
  const { counter, Harness } = harness();
  const mounted = await renderComponent(<Harness event={hint(null)} />);
  try {
    await flush();
    expect(counter.refreshes).toBe(1);
    await mounted.rerender(<Harness event={hint([], ["site-conversation"])} />);
    await flush();
    expect(counter.refreshes).toBe(1);
    await mounted.rerender(<Harness event={hint(["session-a"], ["site-conversation"])} />);
    await flush();
    expect(counter.refreshes).toBe(2);
    await mounted.rerender(<Harness event={hint(["session-b"])} />);
    await flush();
    expect(counter.refreshes).toBe(3);
  } finally {
    await mounted.unmount();
  }
});

test("a list of Site conversations refetches for hints naming Site conversations only", async () => {
  const { counter, Harness } = harness({ siteConversations: true });
  const mounted = await renderComponent(<Harness event={hint(null)} />);
  try {
    await flush();
    expect(counter.refreshes).toBe(1);
    await mounted.rerender(<Harness event={hint([], ["site-conversation"])} />);
    await flush();
    expect(counter.refreshes).toBe(2);
    // Ordinary sessions only: nothing this list shows changed.
    await mounted.rerender(<Harness event={hint(["session-a"])} />);
    await flush();
    expect(counter.refreshes).toBe(2);
    await mounted.rerender(<Harness event={hint(["session-b"], ["site-conversation"])} />);
    await flush();
    expect(counter.refreshes).toBe(3);
    // Workspace-wide hints always reconcile.
    await mounted.rerender(<Harness event={hint(null)} />);
    await flush();
    expect(counter.refreshes).toBe(4);
  } finally {
    await mounted.unmount();
  }
});
