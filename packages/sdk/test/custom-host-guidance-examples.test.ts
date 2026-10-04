import { describe, expect, test } from "bun:test";
import { markdownLanguage } from "@codemirror/lang-markdown";

import { OpenGeniApiError } from "../src/errors";
import type { SessionApprovalRequest, SessionEvent } from "../src/types";

const root = new URL("../../../", import.meta.url);
const reference = (name: string) =>
  new URL(`.agents/skills/opengeni-client/references/${name}.md`, root);
const uiGuide = await Bun.file(reference("product-shapes-and-ui")).text();
const errorGuide = await Bun.file(reference("compatibility-and-troubleshooting")).text();

// Execute the actual Markdown examples, not a hand-copied implementation.
// Use the repository's existing structured Markdown parser for fenced code.
async function example<T>(markdown: string, names: string[]): Promise<T> {
  const blocks: string[] = [];
  markdownLanguage.parser.parse(markdown).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      const text = node.node.getChild("CodeText");
      if (!text) return;
      const code = markdown.slice(text.from, text.to);
      if (names.some((name) => code.includes(`function ${name}(`))) blocks.push(code);
    },
  });
  for (const name of names) {
    expect(blocks.filter((code) => code.includes(`function ${name}(`))).toHaveLength(1);
  }
  const source = `${blocks.join("\n")}\nexport { ${names.join(", ")} };`;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as T;
}

type View = {
  reset(identityKey: string | null): void;
  begin(): { signal: AbortSignal; isCurrent(): boolean; finish(): void };
};
const identity = await example<{
  createIdentityBoundView(clearPrivateState: () => void): View;
  readForCurrentView(
    view: View,
    load: (signal: AbortSignal) => Promise<unknown>,
    render: (result: unknown) => void,
    showFailure: (message: string) => void,
  ): Promise<void>;
}>(uiGuide, ["createIdentityBoundView", "readForCurrentView"]);

const approvals = await example<{
  projectApprovalState(events: SessionEvent[]): {
    pending: SessionApprovalRequest[];
    decisions: { approvalId: string; decision: "approve" | "reject"; decisionEventId: string }[];
  };
  exactTitleProposal(approval: { arguments: unknown }): string | null;
}>(uiGuide, ["projectApprovalState", "exactTitleProposal"]);

const errors = await example<{
  assistantFailureNotice(
    error: unknown,
    options?: { decisionAccepted?: boolean },
  ): { state: "reconciling" | "refresh" | "failed"; message: string };
}>(errorGuide, ["assistantFailureNotice"]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const proposal: SessionApprovalRequest = {
  id: "original-tool-call",
  name: "articles__update_title",
  arguments: JSON.stringify({ path: { slug: "owned-record" }, body: { title: "Exact title" } }),
};
const event = (
  sequence: number,
  type: SessionEvent["type"],
  payload: unknown,
  turnId = "turn-A",
): SessionEvent => ({
  id: `event-${sequence}`,
  workspaceId: "workspace-A",
  sessionId: "session-A",
  sequence,
  type,
  payload,
  turnId,
  occurredAt: "2026-10-02T00:00:00.000Z",
});
const requested = (sequence = 1) =>
  event(sequence, "session.requiresAction", { approvals: [proposal] });

describe("custom host identity examples", () => {
  test("reset clears private state, aborts every request and fences A -> B -> A", () => {
    const privateState = {
      sessionId: "A-private-session",
      cursor: 42,
      cards: [proposal],
      timer: true,
    };
    let resets = 0;
    const view = identity.createIdentityBoundView(() => {
      privateState.sessionId = "";
      privateState.cursor = 0;
      privateState.cards = [];
      privateState.timer = false;
      resets += 1;
    });
    expect(() => view.begin()).toThrow("No authenticated view");
    view.reset("tenant:A:session-A");
    const first = view.begin();
    const second = view.begin();
    expect(first.isCurrent()).toBe(true);
    view.reset("tenant:B:session-B");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    view.reset("tenant:A:session-A");
    expect(first.isCurrent()).toBe(false);
    expect(privateState).toEqual({ sessionId: "", cursor: 0, cards: [], timer: false });
    expect(resets).toBe(3);
    view.reset(null);
    expect(() => view.begin()).toThrow("No authenticated view");
  });

  test("ignores late success and late failure when transport ignores abort", async () => {
    const view = identity.createIdentityBoundView(() => {});
    const lateSuccess = deferred<unknown>();
    const lateFailure = deferred<unknown>();
    const rendered: unknown[] = [];
    const notices: string[] = [];
    const render = (value: unknown) => rendered.push(value);
    const notice = (value: string) => notices.push(value);
    view.reset("A");
    const first = identity.readForCurrentView(view, () => lateSuccess.promise, render, notice);
    const second = identity.readForCurrentView(view, () => lateFailure.promise, render, notice);
    view.reset("B");
    await identity.readForCurrentView(view, async () => "B-only", render, notice);
    lateSuccess.resolve("A-private");
    lateFailure.reject(new Error("A-private provider detail"));
    await Promise.all([first, second]);
    expect(rendered).toEqual(["B-only"]);
    expect(notices).toEqual([]);
  });

  test("same-user session change and current-view failure stay correctly scoped", async () => {
    const view = identity.createIdentityBoundView(() => {});
    view.reset("A:session-1");
    const old = view.begin();
    view.reset("A:session-2");
    expect(old.isCurrent()).toBe(false);
    const notices: string[] = [];
    await identity.readForCurrentView(
      view,
      async () => {
        throw new Error("OpenGeni secret detail");
      },
      () => {},
      (text) => notices.push(text),
    );
    expect(notices).toEqual(["The assistant could not refresh."]);
  });
});

describe("custom host approval examples", () => {
  test.each(["approve", "reject"] as const)(
    "replay preserves original %s receipt and cannot recreate pending decision",
    (decision) => {
      const events = [
        requested(),
        event(2, "user.approvalDecision", { approvalId: proposal.id, decision }),
        requested(3),
      ];
      const projection = approvals.projectApprovalState(events);
      expect(projection.pending).toEqual([]);
      expect(projection.decisions).toEqual([
        { approvalId: proposal.id, decision, decisionEventId: "event-2" },
      ]);
      expect(approvals.projectApprovalState(events)).toEqual(projection); // reload, no new UI IDs
      events.push(
        event(4, "user.approvalDecision", {
          approvalId: proposal.id,
          decision: decision === "approve" ? "reject" : "approve",
        }),
      );
      expect(approvals.projectApprovalState(events).decisions).toEqual(projection.decisions);
    },
  );

  test("requires-action replaces pending set and settlement is owning-turn scoped", () => {
    const second = { ...proposal, id: "second-tool-call" };
    const events = [
      requested(),
      event(2, "session.requiresAction", { approvals: [second] }),
      event(3, "turn.cancelled", {}, "another-turn"),
    ];
    expect(approvals.projectApprovalState(events).pending).toEqual([second]);
    events.push(event(4, "future.additive.event", {}));
    events.push(event(5, "turn.completed", {}));
    events.push(event(6, "session.requiresAction", { approvals: [second] }));
    expect(approvals.projectApprovalState(events).pending).toEqual([]);
  });

  test("malformed/missing stable IDs fail closed instead of inventing UI IDs", () => {
    expect(
      approvals.projectApprovalState([
        event(1, "session.requiresAction", {
          approvals: [null, { name: "title" }, { id: "", name: "title" }, { id: "x", name: "" }],
        }),
      ]).pending,
    ).toEqual([]);
    expect(
      approvals.projectApprovalState([event(1, "session.requiresAction", { approvals: {} })])
        .pending,
    ).toEqual([]);
  });

  test("exact body.title is retained without trimming or unescaping", () => {
    const title = "  Literal <title>  ";
    for (const argumentsValue of [{ body: { title } }, JSON.stringify({ body: { title } })]) {
      expect(approvals.exactTitleProposal({ arguments: argumentsValue })).toBe(title);
    }
  });

  test.each([
    undefined,
    "invalid JSON",
    { title: "wrong top-level field" },
    { body: {} },
    { body: { title: " " } },
    { body: { title: 42 } },
    { body: { title: "title", admin: true } },
    { body: [] },
  ])("missing or unexpected proposal fails closed: %j", (argumentsValue) => {
    expect(approvals.exactTitleProposal({ arguments: argumentsValue })).toBeNull();
  });
});

describe("custom host error and reconciliation examples", () => {
  test("unknown upstream outcome requires reconciliation, not unchanged or raw error copy", () => {
    const cause = new OpenGeniApiError(503, "OpenGeni provider detail", { outcomeUnknown: true });
    const notice = errors.assistantFailureNotice(cause);
    expect(notice.state).toBe("reconciling");
    expect(notice.message).toContain("may have been accepted");
    expect(notice.message).not.toMatch(/OpenGeni|unchanged|provider detail/);
  });

  test("accepted decision then local save failure also requires reconciliation", () => {
    const notice = errors.assistantFailureNotice(new Error("mapping save failed"), {
      decisionAccepted: true,
    });
    expect(notice.state).toBe("reconciling");
    expect(notice.message).not.toContain("unchanged");
  });

  test("stale/no-pending conflict has safe host copy rather than SDK product branding", () => {
    const notice = errors.assistantFailureNotice(
      new OpenGeniApiError(409, "OpenGeni: no approval pending"),
    );
    expect(notice).toEqual({
      state: "refresh",
      message: "This request has changed. Refresh before deciding.",
    });
  });

  test("generic SDK initialization/configuration errors do not reach host notices", () => {
    expect(
      errors.assistantFailureNotice(new Error("OpenGeni config/private API key detail")),
    ).toEqual({
      state: "failed",
      message: "The assistant is unavailable. Please try again later.",
    });
  });

  test("canonical guidance retains full error boundary and no-blind-replay instructions", () => {
    expect(errorGuide).toContain("dynamic SDK import/initialization");
    expect(errorGuide).toContain("local persistence inside the route's error boundary");
    expect(errorGuide).toContain("persisted `clientEventId`");
    expect(errorGuide).toContain("authorized provider record to reconcile");
    expect(errorGuide).toContain("server-only");
  });
});

test("provider guidance retains negative host-endpoint authorization tests, not only tool allowlists", async () => {
  const canonical = await Bun.file(reference("data-tools-and-credentials")).text();
  const primary = await Bun.file(new URL("docs-site/integrate/your-data.mdx", root)).text();
  for (const text of [canonical, primary]) {
    expect(text).toContain("ordinary host login JWT");
    expect(text).toContain("separate signing key/token namespace");
    expect(text).toContain("issuer/audience");
    expect(text).toContain("account/password/admin APIs");
    expect(text).toContain("ordinary host endpoints");
  }
});
