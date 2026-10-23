import { expect, test } from "bun:test";
import { useEffect, useMemo } from "react";
import type {
  LineageNode,
  SessionEvent,
  SessionSummary,
  WorkspaceSessionListEvent,
} from "@opengeni/sdk";
import { OpenGeniContext, type OpenGeniContextValue } from "../src/session-context";
import {
  LINEAGE_POLL_ACTIVE_WITHOUT_HINTS_MS,
  LINEAGE_POLL_MS,
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

// The runtime's shapes: the created event names the tool; its output carries
// only the call id (packages/runtime/src/run-events.ts).
function parentEvent(sequence: number, type: string, payload: unknown): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: PARENT,
    sequence,
    type,
    payload,
    occurredAt: "2026-10-23T06:00:00.000Z",
    turnId: "turn-1",
  } as SessionEvent;
}
const toolCall = (sequence: number, id: string, name: string) =>
  parentEvent(sequence, "agent.toolCall.created", { id, name, arguments: {}, raw: {} });
const toolOutput = (sequence: number, id: string) =>
  parentEvent(sequence, "agent.toolCall.output", { id, output: "ok" });

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
      refreshLineage,
    });
    const poll = useLineagePollInterval(WORKSPACE_ID);
    seen.poll = poll.pollIntervalMs;
    const observeTree = poll.observeTree;
    useEffect(() => observeTree(nodes), [nodes, observeTree]);
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
const NO_NODES: LineageNode[] = [];
const WAITING_TREE = lineage("requires_action");
const RUNNING_TREE = lineage("running");
const IDLE_TREE = lineage("idle");

// The hook debounces bursts of hints into one re-read.
const settle = () => flush(200);

test("re-reads the tree when a list hint names a descendant, and only then", async () => {
  const { seen, Harness } = harness();
  const mounted = await renderComponent(<Harness event={null} />);
  try {
    await settle();
    expect(seen.refreshes).toBe(0);

    await mounted.rerender(<Harness event={hint(["child"])} />);
    await settle();
    expect(seen.refreshes).toBe(1);
    // Items re-read when the re-read tree shows their sub-session moved on;
    // a hint does not make every item read again.
    expect(seen.signal).toBe(0);

    // Neither this session itself nor one outside its idle tree re-reads.
    await mounted.rerender(<Harness event={hint([PARENT])} />);
    await settle();
    await mounted.rerender(<Harness event={hint(["elsewhere"])} />);
    await settle();
    expect(seen.refreshes).toBe(1);

    // A full reconcile re-reads.
    await mounted.rerender(<Harness event={hint(null)} />);
    await settle();
    expect(seen.refreshes).toBe(2);
  } finally {
    await mounted.unmount();
  }
});

test("only a running descendant makes unseen sessions worth a re-read", async () => {
  const { seen, Harness } = harness();
  const mounted = await renderComponent(<Harness event={null} nodes={IDLE_TREE} />);
  try {
    await mounted.rerender(<Harness event={hint(["new-session"])} nodes={IDLE_TREE} />);
    await settle();
    expect(seen.refreshes).toBe(0);
    await mounted.rerender(<Harness event={hint(["new-grandchild"])} nodes={RUNNING_TREE} />);
    await settle();
    expect(seen.refreshes).toBe(1);
  } finally {
    await mounted.unmount();
  }
});

test("polls faster only while sub-sessions are active and hints are unavailable", async () => {
  const { seen, Harness } = harness();
  const mounted = await renderComponent(<Harness event={null} nodes={NO_NODES} />);
  try {
    await settle();
    expect(seen.poll).toBe(LINEAGE_POLL_MS);
    await mounted.rerender(<Harness event={null} nodes={IDLE_TREE} />);
    await settle();
    expect(seen.poll).toBe(LINEAGE_POLL_MS);
    await mounted.rerender(<Harness event={null} nodes={WAITING_TREE} />);
    await settle();
    expect(seen.poll).toBe(LINEAGE_POLL_ACTIVE_WITHOUT_HINTS_MS);
    await mounted.rerender(<Harness event={null} nodes={RUNNING_TREE} />);
    await settle();
    expect(seen.poll).toBe(LINEAGE_POLL_ACTIVE_WITHOUT_HINTS_MS);
    // Live hints carry changes, so the default poll is enough.
    await mounted.rerender(<Harness event={hint([])} nodes={RUNNING_TREE} />);
    await settle();
    expect(seen.poll).toBe(LINEAGE_POLL_MS);
    // Hints that stopped arriving fall back to the faster poll.
    await mounted.rerender(<Harness event={hint([], false)} nodes={RUNNING_TREE} />);
    await settle();
    expect(seen.poll).toBe(LINEAGE_POLL_ACTIVE_WITHOUT_HINTS_MS);
  } finally {
    await mounted.unmount();
  }
});

test("re-reads once this session's agent has answered a sub-session", async () => {
  const { seen, Harness } = harness();
  const first = [
    toolCall(1, "call-spawn", "opengeni__session_create"),
    toolOutput(2, "call-spawn"),
  ];
  const mounted = await renderComponent(<Harness event={null} events={first} />);
  try {
    await settle();
    const baseline = seen.refreshes;
    const asked = [
      ...first,
      toolCall(3, "call-read", "read_file"),
      toolOutput(4, "call-read"),
      toolCall(5, "call-answer", "opengeni__session_human_input_respond"),
    ];
    await mounted.rerender(<Harness event={null} events={asked} />);
    await settle();
    // Other tools' outputs, and the answer before it has run, change nothing.
    expect(seen.refreshes).toBe(baseline);
    expect(seen.signal).toBe(0);

    await mounted.rerender(
      <Harness event={null} events={[...asked, toolOutput(6, "call-answer")]} />,
    );
    await settle();
    expect(seen.refreshes).toBe(baseline + 1);
    expect(seen.signal).toBe(1);
  } finally {
    await mounted.unmount();
  }
});
