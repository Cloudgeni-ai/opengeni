import { expect, test } from "bun:test";
import { useMemo } from "react";
import type {
  LineageNode,
  SessionEvent,
  SessionSummary,
  WorkspaceSessionListEvent,
} from "@opengeni/sdk";
import { OpenGeniContext, type OpenGeniContextValue } from "../src/session-context";
import {
  LINEAGE_POLL_WITH_HINTS_MS,
  LINEAGE_POLL_WITHOUT_HINTS_MS,
  useDescendantRequestsRefresh,
  useLineagePollInterval,
} from "../src/app/lib/use-descendant-requests-refresh";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const PARENT = "parent";

const hint = (sessionIds: string[] | null, available = true): WorkspaceSessionListEvent => ({
  type: "workspace.sessions.changed",
  workspaceId: WORKSPACE_ID,
  available,
  sessionIds,
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

function lineage(status: SessionSummary["status"]): LineageNode[] {
  return [
    {
      session: { id: "child", workspaceId: WORKSPACE_ID, status } as SessionSummary,
      children: [],
    } as unknown as LineageNode,
  ];
}

function toolOutput(sequence: number, name: string): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: PARENT,
    sequence,
    type: "agent.toolCall.output",
    payload: { name },
    occurredAt: "2026-10-23T06:00:00.000Z",
    turnId: "turn-1",
  } as SessionEvent;
}

function harness() {
  const seen = { refreshes: 0, signal: 0, poll: 0 };
  const refreshLineage = async () => {
    seen.refreshes += 1;
  };
  function Probe({ events, nodes }: { events: SessionEvent[]; nodes: LineageNode[] }) {
    seen.signal = useDescendantRequestsRefresh({
      client: context.client,
      workspaceId: WORKSPACE_ID,
      sessionId: PARENT,
      events,
      nodes,
      sessionRunning: false,
      refreshLineage,
    });
    seen.poll = useLineagePollInterval(WORKSPACE_ID);
    return null;
  }
  function Harness(props: {
    event: WorkspaceSessionListEvent | null;
    events?: SessionEvent[];
    nodes?: LineageNode[];
  }) {
    const value = useMemo(
      () => ({ ...context, workspaceSessionListEvent: props.event }),
      [props.event],
    );
    return (
      <OpenGeniContext.Provider value={value}>
        <Probe events={props.events ?? NO_EVENTS} nodes={props.nodes ?? WAITING_TREE} />
      </OpenGeniContext.Provider>
    );
  }
  return { seen, Harness };
}

const NO_EVENTS: SessionEvent[] = [];
const WAITING_TREE = lineage("requires_action");
const RUNNING_TREE = lineage("running");

// The hook debounces bursts of hints into one re-read.
const settle = () => flush(200);

test("re-reads the tree when a list hint names a descendant, and only then", async () => {
  const { seen, Harness } = harness();
  const mounted = await renderComponent(<Harness event={null} />);
  try {
    await settle();
    expect(seen.refreshes).toBe(0);
    expect(seen.poll).toBe(LINEAGE_POLL_WITHOUT_HINTS_MS);

    await mounted.rerender(<Harness event={hint(["child"])} />);
    await settle();
    expect(seen.refreshes).toBe(1);
    expect(seen.signal).toBe(1);
    expect(seen.poll).toBe(LINEAGE_POLL_WITH_HINTS_MS);

    // A session outside this idle tree changes nothing here.
    await mounted.rerender(<Harness event={hint(["elsewhere"])} />);
    await settle();
    expect(seen.refreshes).toBe(1);

    // A full reconcile re-reads.
    await mounted.rerender(<Harness event={hint(null)} />);
    await settle();
    expect(seen.refreshes).toBe(2);

    // Hints that stopped arriving fall back to the faster poll.
    await mounted.rerender(<Harness event={hint(["child"], false)} />);
    await settle();
    expect(seen.refreshes).toBe(2);
    expect(seen.poll).toBe(LINEAGE_POLL_WITHOUT_HINTS_MS);
  } finally {
    await mounted.unmount();
  }
});

test("a running tree re-reads for sessions it has not seen yet", async () => {
  const { seen, Harness } = harness();
  const mounted = await renderComponent(<Harness event={null} nodes={RUNNING_TREE} />);
  try {
    await mounted.rerender(<Harness event={hint(["new-grandchild"])} nodes={RUNNING_TREE} />);
    await settle();
    expect(seen.refreshes).toBe(1);
  } finally {
    await mounted.unmount();
  }
});

test("re-reads when this session's agent answers a sub-session", async () => {
  const { seen, Harness } = harness();
  const first = [toolOutput(1, "session_create")];
  const mounted = await renderComponent(<Harness event={null} events={first} />);
  try {
    await settle();
    const baseline = seen.refreshes;
    await mounted.rerender(
      <Harness event={null} events={[...first, toolOutput(2, "read_file")]} />,
    );
    await settle();
    expect(seen.refreshes).toBe(baseline);
    await mounted.rerender(
      <Harness
        event={null}
        events={[
          ...first,
          toolOutput(2, "read_file"),
          toolOutput(3, "opengeni__session_human_input_respond"),
        ]}
      />,
    );
    await settle();
    expect(seen.refreshes).toBe(baseline + 1);
    expect(seen.signal).toBe(baseline + 1);
  } finally {
    await mounted.unmount();
  }
});
