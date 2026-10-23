import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  HumanInputQuestion,
  LineageNode,
  SessionEvent,
  SessionHumanInputRequest,
  SessionSummary,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { act, createElement, type ReactNode } from "react";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

const { HumanInputForm } = await import("../src");
const { configurePageAppHost } = await import("../src/app/lib/app-host");
// The app's router renders links as anchors; render the same href here.
configurePageAppHost({
  navigation: {
    Link: ({
      to,
      params,
      search,
      children,
      ...rest
    }: {
      to?: string;
      params?: Record<string, string>;
      search?: Record<string, unknown>;
      children?: ReactNode;
    }) => {
      const path = Object.entries(params ?? {}).reduce(
        (href, [key, value]) => href.replace(`$${key}`, value),
        to ?? "",
      );
      const query = new URLSearchParams(
        Object.entries(search ?? {}).map(([key, value]) => [key, String(value)]),
      ).toString();
      return createElement("a", { ...rest, href: query ? `${path}?${query}` : path }, children);
    },
  } as never,
});
const { resetHumanInputDraftMemoryForTests } = await import("../src/human-input-draft-store");
const {
  descendantRequestActivity,
  descendantsRunning,
  hintTouchesTree,
  isSubSessionResponseOutput,
  lineageSessionIds,
  subSessionResponseCallIds,
  subSessionsNeedYouLabel,
  waitingDescendants,
} = await import("../src/app/lib/descendant-requests");
const { DescendantRequests, resetDescendantRequestsStateForTests } =
  await import("../src/app/components/session/descendant-requests");

type DescendantRequestsProps = Parameters<typeof DescendantRequests>[0];

const WORKSPACE = "workspace-1";
const PARENT = "parent-session";

let mounted: RenderedComponent | null = null;

beforeEach(() => {
  resetHumanInputDraftMemoryForTests();
  resetDescendantRequestsStateForTests();
  window.sessionStorage.clear();
});

afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await current.unmount();
});

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workspaceId: WORKSPACE,
    status: "requires_action",
    title: `Session ${id}`,
    titleSource: "user",
    lastSequence: 10,
    createdAt: "2026-10-23T06:00:00.000Z",
    updatedAt: "2026-10-23T06:00:00.000Z",
    requiresActionSince: "2026-10-23T06:00:00.000Z",
    ...overrides,
  } as SessionSummary;
}

function node(session: SessionSummary, children: LineageNode[] = []): LineageNode {
  return { session, children } as unknown as LineageNode;
}

let sequence = 0;
function event(
  type: string,
  payload: unknown,
  options: { turnId?: string | null; sequence?: number } = {},
): SessionEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    workspaceId: WORKSPACE,
    sessionId: "child",
    sequence: options.sequence ?? sequence,
    type,
    payload,
    occurredAt: "2026-10-23T06:00:00.000Z",
    turnId: options.turnId === undefined ? "turn-1" : options.turnId,
  } as SessionEvent;
}

const question: HumanInputQuestion = {
  id: "summary",
  kind: "text",
  prompt: "Which branch should I review?",
  options: [],
  required: true,
  allowOther: false,
};

function request(sessionId: string, id = "request-1"): SessionHumanInputRequest {
  return {
    id,
    workspaceId: WORKSPACE,
    sessionId,
    turnId: "turn-1",
    turnGeneration: 1,
    creationAttemptId: "attempt-1",
    toolCallId: "call-1",
    status: "pending",
    questions: [question],
    allowSkip: false,
    response: null,
    respondedBy: null,
    respondedAt: null,
    expiresAt: null,
    createdAt: "2026-10-23T06:00:00.000Z",
    updatedAt: "2026-10-23T06:00:00.000Z",
  } as SessionHumanInputRequest;
}

type Calls = {
  submitted: Array<{
    sessionId: string;
    requestId: string;
    response: SubmitHumanInputResponseRequest;
  }>;
  decisions: Array<{ sessionId: string; approvalId: string; decision: string }>;
  reviews: Array<{ sessionId: string; approvalId: string }>;
};

function fakeClient(state: {
  requests?: Record<string, SessionHumanInputRequest[]>;
  events?: Record<string, SessionEvent[]>;
}) {
  const calls: Calls = { submitted: [], decisions: [], reviews: [] };
  const client = {
    getSession: async () => {
      throw new Error("not used");
    },
    streamEvents: () => {
      throw new Error("the card must not open a stream per sub-session");
    },
    listHumanInputRequests: async (_workspaceId: string, sessionId: string) =>
      state.requests?.[sessionId] ?? [],
    submitHumanInputResponse: async (
      _workspaceId: string,
      sessionId: string,
      requestId: string,
      response: SubmitHumanInputResponseRequest,
    ) => {
      calls.submitted.push({ sessionId, requestId, response });
      const answered = (state.requests?.[sessionId] ?? []).find((item) => item.id === requestId)!;
      state.requests = { ...state.requests, [sessionId]: [] };
      return { ...answered, status: "answered" };
    },
    listEventPage: async (_workspaceId: string, sessionId: string) => ({
      events: state.events?.[sessionId] ?? [],
    }),
    sendApprovalDecision: async (
      _workspaceId: string,
      sessionId: string,
      body: { approvalId: string; decision: string },
    ) => {
      calls.decisions.push({ sessionId, ...body });
      state.events = { ...state.events, [sessionId]: [] };
      return {};
    },
    getToolActionReview: async (_workspaceId: string, sessionId: string, approvalId: string) => {
      calls.reviews.push({ sessionId, approvalId });
      return {
        version: 1,
        id: approvalId,
        actionDigest: "saved-action",
        revision: "revision-1",
        status: "pending",
        title: "Update project",
        effects: [],
        samples: [],
        fields: [],
        moreFields: 0,
        reason: "Review this change.",
        createdAt: "2026-10-23T06:00:00.000Z",
        updatedAt: "2026-10-23T06:00:00.000Z",
        approveLabel: "Approve action",
        availableActions: ["approve", "reject"],
        detailsAvailable: false,
      };
    },
    getToolReviewDetails: async () => {
      throw new Error("no details");
    },
  };
  return { client: client as unknown as DescendantRequestsProps["client"], calls };
}

async function render(
  props: Partial<DescendantRequestsProps> & Pick<DescendantRequestsProps, "client" | "waiting">,
) {
  mounted = await renderComponent(
    createElement(DescendantRequests, {
      workspaceId: WORKSPACE,
      parentSessionId: PARENT,
      ...props,
    }),
  );
  await flush(0);
  await flush(0);
}

function container(): HTMLElement {
  return mounted!.container;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container().querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
}

function setNativeValue(element: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
    element,
    value,
  );
  const reactPropsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = (element as unknown as Record<string, Record<string, unknown>>)[reactPropsKey!]!;
  (props.onChange as (event: { target: typeof element }) => void)({ target: element });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await flush(0);
}

function link(label: string): HTMLAnchorElement | undefined {
  return [...container().querySelectorAll("a")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
}

function answerField(root: HTMLElement = container()): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>('[data-human-input-question="summary"] textarea');
}

describe("descendant request model", () => {
  test("lists every waiting descendant, the longest-waiting first", () => {
    const nodes = [
      node(summary("a", { requiresActionSince: "2026-10-23T06:05:00.000Z" }), [
        node(summary("a1", { requiresActionSince: "2026-10-23T06:01:00.000Z" })),
        node(summary("a2", { status: "running" })),
      ]),
      node(summary("b", { archived: true })),
      node(summary("c", { admissionBlock: { code: "machine_offline" } as never })),
      node(summary("d", { status: "idle" }), [
        node(summary("d1", { requiresActionSince: "2026-10-23T06:03:00.000Z" })),
      ]),
    ];
    expect(waitingDescendants(nodes).map((session) => session.id)).toEqual(["a1", "d1", "a"]);
    expect([...lineageSessionIds(nodes)].sort()).toEqual(
      ["a", "a1", "a2", "b", "c", "d", "d1"].sort(),
    );
  });

  test("a list hint matters only when it names this tree or asks for a full reconcile", () => {
    const ids = new Set(["parent", "child"]);
    expect(hintTouchesTree({ available: true, sessionIds: ["other", "child"] }, ids)).toBe(true);
    expect(hintTouchesTree({ available: true, sessionIds: ["other"] }, ids)).toBe(false);
    expect(hintTouchesTree({ available: true, sessionIds: null }, ids)).toBe(true);
    expect(hintTouchesTree({ available: false, sessionIds: null }, ids)).toBe(false);
    expect(hintTouchesTree(null, ids)).toBe(false);
  });

  test("rebuilds open approvals and where each request was raised", () => {
    sequence = 0;
    const asked = event("session.humanInput.requested", {
      request: { id: "request-1", questions: [question] },
    });
    const raised = event("session.requiresAction", {
      approvals: [{ id: "approval-1", name: "github.merge" }],
    });
    const open = descendantRequestActivity([raised, asked]);
    expect(open.approvals.map((approval) => approval.id)).toEqual(["approval-1"]);
    expect(open.approvalSequence).toBe(raised.sequence);
    expect(open.requestSequences.get("request-1")).toBe(asked.sequence);

    const decided = event("user.approvalDecision", { approvalId: "approval-1" }, { turnId: null });
    const closed = descendantRequestActivity([asked, raised, decided]);
    expect(closed.approvals).toEqual([]);
    expect(closed.approvalSequence).toBeNull();
  });

  test("notices the parent agent's answer or steer once its call has run", () => {
    // The runtime's shapes: the created event names the tool, its output
    // carries only the call id (packages/runtime/src/run-events.ts).
    const created = (id: string, name: string, args: unknown = {}) =>
      event("agent.toolCall.created", { id, name, arguments: args, raw: {} });
    const output = (id: string) => event("agent.toolCall.output", { id, output: "ok" });
    const feed = [
      created("call-answer", "opengeni__session_human_input_respond"),
      created("call-steer", "session_steer"),
      created(
        "call-invoke",
        "tool_invoke",
        JSON.stringify({ name: "opengeni__session_human_input_respond", arguments: {} }),
      ),
      created("call-spawn", "opengeni__session_create"),
      created("call-other-invoke", "tool_invoke", { name: "read_file" }),
    ];
    const ids = subSessionResponseCallIds(feed);
    expect([...ids].sort()).toEqual(["call-answer", "call-invoke", "call-steer"]);
    expect(isSubSessionResponseOutput(output("call-answer"), ids)).toBe(true);
    expect(isSubSessionResponseOutput(output("call-steer"), ids)).toBe(true);
    expect(isSubSessionResponseOutput(output("call-invoke"), ids)).toBe(true);
    expect(isSubSessionResponseOutput(output("call-spawn"), ids)).toBe(false);
    expect(isSubSessionResponseOutput(output("call-other-invoke"), ids)).toBe(false);
    // The call itself has not run yet.
    expect(isSubSessionResponseOutput(feed[0]!, ids)).toBe(false);
  });

  test("knows whether a descendant runs", () => {
    expect(descendantsRunning([node(summary("a", { status: "idle" }))])).toBe(false);
    expect(
      descendantsRunning([
        node(summary("a", { status: "idle" }), [node(summary("a1", { status: "running" }))]),
      ]),
    ).toBe(true);
  });

  test("counts sub-sessions in the collapsed line", () => {
    expect(subSessionsNeedYouLabel(1)).toBe("1 sub-session needs you");
    expect(subSessionsNeedYouLabel(3)).toBe("3 sub-sessions need you");
  });
});

describe("DescendantRequests", () => {
  test("renders nothing when no sub-session waits", async () => {
    const { client } = fakeClient({});
    await render({ client, waiting: [] });
    expect(container().querySelector("[data-descendant-requests]")).toBeNull();
  });

  test("answers a sub-session's question in place, on the sub-session", async () => {
    const child = summary("child", { title: "Review PR #4418" });
    const { client, calls } = fakeClient({ requests: { child: [request("child")] } });
    let resolved = 0;
    await render({ client, waiting: [child], onResolved: () => (resolved += 1) });

    expect(container().textContent).toContain("Review PR #4418 is asking");
    expect(container().textContent).toContain("Which branch should I review?");
    // One waiting sub-session shows its request directly, without a stack line.
    expect(container().querySelector("[data-descendant-requests-toggle]")).toBeNull();

    await act(async () => setNativeValue(answerField()!, "feature/login"));
    await click(button("Send answers")!);

    expect(calls.submitted).toHaveLength(1);
    expect(calls.submitted[0]!.sessionId).toBe("child");
    expect(calls.submitted[0]!.requestId).toBe("request-1");
    expect(JSON.stringify(calls.submitted[0]!.response)).toContain("feature/login");
    expect(resolved).toBe(1);
    // Answered: the card says nothing while the tree catches up.
    expect(container().querySelector("[data-descendant-request]")).toBeNull();

    // The sub-session's log moves on before its status does: still nothing,
    // not a "needs you" line for the wait just answered.
    await mounted!.rerender(
      createElement(DescendantRequests, {
        client,
        workspaceId: WORKSPACE,
        parentSessionId: PARENT,
        waiting: [{ ...child, lastSequence: child.lastSequence + 1 }],
      }),
    );
    await flush(0);
    await flush(0);
    expect(container().querySelector("[data-descendant-request]")).toBeNull();
  });

  test("shares an unsent answer with the sub-session's own page", async () => {
    const child = summary("child");
    const { client } = fakeClient({ requests: { child: [request("child")] } });
    await render({ client, waiting: [child] });
    await act(async () => setNativeValue(answerField()!, "half-typed answer"));
    await mounted!.unmount();
    mounted = null;

    // The sub-session's page renders the same request with its own form.
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: request("child"),
        onSubmit: () => undefined,
        autoFocus: false,
      }),
    );
    expect(answerField()!.value).toBe("half-typed answer");
  });

  test("decides a sub-session's approval on the sub-session", async () => {
    sequence = 0;
    const child = summary("child", { title: "Deploy worker" });
    const { client, calls } = fakeClient({
      events: {
        child: [
          event("session.requiresAction", {
            approvals: [{ id: "approval-1", name: "projects.update", arguments: {} }],
          }),
        ],
      },
    });
    let resolved = 0;
    await render({ client, waiting: [child], onResolved: () => (resolved += 1) });

    expect(container().textContent).toContain("Deploy worker needs approval");
    // The saved review is read from the sub-session, as its own page reads it.
    expect(container().textContent).toContain("Update project");
    expect(calls.reviews).toEqual([{ sessionId: "child", approvalId: "approval-1" }]);
    await click(button("Approve action")!);
    expect(calls.decisions).toEqual([
      { sessionId: "child", approvalId: "approval-1", decision: "approve" },
    ]);
    expect(resolved).toBe(1);
  });

  test("opens the sub-session where it asked", async () => {
    sequence = 0;
    const child = summary("child", { title: "Review PR #4418" });
    const asked = event(
      "session.humanInput.requested",
      { request: { id: "request-1", questions: [question] } },
      { sequence: 42 },
    );
    const { client } = fakeClient({
      requests: { child: [request("child")] },
      events: { child: [asked] },
    });
    await render({ client, waiting: [child] });
    expect(link("Open sub-session: Review PR #4418")?.getAttribute("href")).toBe(
      `/workspaces/${WORKSPACE}/sessions/child?at=42`,
    );
  });

  test("points to the sub-session when it waits on something only its page can take", async () => {
    const child = summary("child", { title: "Sign-in worker" });
    const { client } = fakeClient({});
    await render({ client, waiting: [child] });
    expect(container().textContent).toContain("Sign-in worker needs you");
    expect(link("Open sub-session: Sign-in worker")?.getAttribute("href")).toBe(
      `/workspaces/${WORKSPACE}/sessions/child`,
    );
  });

  test("stacks several waiting sub-sessions under one line that collapses", async () => {
    const first = summary("first", { title: "First worker" });
    const second = summary("second", { title: "Second worker" });
    const { client } = fakeClient({
      requests: { first: [request("first")], second: [request("second")] },
    });
    await render({ client, waiting: [first, second] });

    const toggle = () =>
      container().querySelector<HTMLButtonElement>("[data-descendant-requests-toggle]")!;
    expect(toggle().textContent).toContain("2 sub-sessions need you");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(container().querySelectorAll("[data-descendant-request]")).toHaveLength(2);
    // The first request is open; later ones start as compact bars.
    expect(
      answerField(container().querySelector<HTMLElement>('[data-descendant-request="first"]')!),
    ).not.toBeNull();
    expect(
      answerField(container().querySelector<HTMLElement>('[data-descendant-request="second"]')!),
    ).toBeNull();

    await click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(container().querySelectorAll("[data-descendant-request]")).toHaveLength(0);

    // Coming back to the parent keeps the stack collapsed.
    await mounted!.unmount();
    mounted = null;
    await render({ client, waiting: [first, second] });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  test("clears once the request is resolved elsewhere", async () => {
    const child = summary("child");
    const state = { requests: { child: [request("child")] } };
    const { client } = fakeClient(state);
    const props = {
      client,
      workspaceId: WORKSPACE,
      parentSessionId: PARENT,
    };
    await render({ ...props, waiting: [child] });
    expect(container().querySelector("[data-descendant-request]")).not.toBeNull();

    // The parent agent answered through session_human_input_respond: the tree
    // re-read shows the sub-session no longer waits.
    await mounted!.rerender(
      createElement(DescendantRequests, { ...props, waiting: [], refreshSignal: 1 }),
    );
    await flush(0);
    expect(container().querySelector("[data-descendant-requests]")).toBeNull();
  });

  test("re-reads a sub-session's requests when the parent signals a change", async () => {
    const child = summary("child");
    const state: { requests: Record<string, SessionHumanInputRequest[]> } = {
      requests: { child: [request("child")] },
    };
    const { client } = fakeClient(state);
    const props = {
      client,
      workspaceId: WORKSPACE,
      parentSessionId: PARENT,
      waiting: [child],
    };
    await render(props);
    expect(answerField()).not.toBeNull();

    state.requests = { child: [] };
    await mounted!.rerender(createElement(DescendantRequests, { ...props, refreshSignal: 1 }));
    await flush(0);
    await flush(0);
    expect(answerField()).toBeNull();
    // Settled elsewhere: the wait it showed is over, not "needs you" until
    // the tree catches up.
    expect(container().textContent).not.toContain("needs you");
    expect(container().querySelector("[data-descendant-request]")).toBeNull();
  });

  test("an approval settled elsewhere leaves no needs-you line either", async () => {
    sequence = 0;
    const child = summary("child", { title: "Deploy worker" });
    const state: { events: Record<string, SessionEvent[]> } = {
      events: {
        child: [
          event("session.requiresAction", {
            approvals: [{ id: "approval-1", name: "projects.update", arguments: {} }],
          }),
        ],
      },
    };
    const { client } = fakeClient(state);
    const props = { client, workspaceId: WORKSPACE, parentSessionId: PARENT, waiting: [child] };
    await render(props);
    expect(container().textContent).toContain("Deploy worker needs approval");

    state.events = { child: [] };
    await mounted!.rerender(
      createElement(DescendantRequests, {
        ...props,
        waiting: [{ ...child, lastSequence: child.lastSequence + 2 }],
      }),
    );
    await flush(0);
    await flush(0);
    expect(container().textContent).not.toContain("needs you");
    expect(container().querySelector("[data-descendant-request]")).toBeNull();
  });

  test("shows a sub-session's question and its approval together", async () => {
    sequence = 0;
    const child = summary("child", { title: "Release worker" });
    const { client } = fakeClient({
      requests: { child: [request("child")] },
      events: {
        child: [
          event("session.requiresAction", {
            approvals: [{ id: "approval-1", name: "projects.update", arguments: {} }],
          }),
        ],
      },
    });
    await render({ client, waiting: [child] });
    expect(container().textContent).toContain("Release worker is asking");
    expect(container().textContent).toContain("Release worker needs approval");
    expect(answerField()).not.toBeNull();
    expect(button("Approve action")).toBeDefined();
  });

  test("a lone sub-session left in the stack shows its request directly", async () => {
    const first = summary("first", { title: "First worker" });
    const second = summary("second", { title: "Second worker" });
    const { client } = fakeClient({
      requests: { first: [request("first")], second: [request("second")] },
    });
    const props = { client, workspaceId: WORKSPACE, parentSessionId: PARENT };
    await render({ ...props, waiting: [first, second] });
    const item = (id: string) =>
      container().querySelector<HTMLElement>(`[data-descendant-request="${id}"]`)!;
    expect(answerField(item("second"))).toBeNull();

    await mounted!.rerender(createElement(DescendantRequests, { ...props, waiting: [second] }));
    await flush(0);
    await flush(0);
    expect(container().querySelector("[data-descendant-requests-toggle]")).toBeNull();
    expect(answerField(item("second"))).not.toBeNull();
  });

  test("uses the sub-session page's form, with the same actions", async () => {
    const child = summary("child");
    const { client } = fakeClient({ requests: { child: [request("child")] } });
    await render({ client, waiting: [child] });
    const surface = container().querySelector<HTMLElement>("[data-descendant-request]")!;
    const parentButtons = [...surface.querySelectorAll("button")]
      .map((candidate) => candidate.textContent?.trim())
      .filter(Boolean);
    await mounted!.unmount();
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: request("child"),
        onSubmit: () => undefined,
        autoFocus: false,
      }),
    );
    const childButtons = [...container().querySelectorAll("button")]
      .map((candidate) => candidate.textContent?.trim())
      .filter(Boolean);
    expect(parentButtons).toEqual(childButtons);
  });
});

describe("HumanInputForm collapsed bar", () => {
  test("renders a deadline as text, not as an object", async () => {
    const pending = {
      ...request("child"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    mounted = await renderComponent(
      createElement(HumanInputForm, {
        request: pending,
        onSubmit: () => undefined,
        autoFocus: false,
        defaultCollapsed: true,
      }),
    );
    expect(container().textContent).not.toContain("[object Object]");
  });
});
