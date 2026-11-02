import { describe, expect, test } from "bun:test";
import { CASES } from "./catalogue";
import { gradeCase } from "./grade";
import { INTEGRATIONS } from "./integrations";
import { parseReceipts, type EventLike } from "./receipts";
import { cellsFromConfig, selectCases, wilson } from "./run";
import type { EvalCase } from "./types";

const linearRead: EvalCase = {
  id: "linear.read.test",
  integration: "linear",
  kind: "read",
  prompt: "Which Linear issue is urgent?",
  expectAnswer: [/checkout times out/i],
};

function events(...items: Omit<EventLike, "sequence">[]): EventLike[] {
  return items.map((item, index) => ({ sequence: index + 1, ...item }));
}

const linearCall = (id: string, output: string) => [
  {
    type: "agent.toolCall.created",
    payload: {
      id,
      name: "mcp_abc__list_issues",
      arguments: "{}",
      toolFamily: "integration:mcp.linear.app",
    },
  },
  { type: "agent.toolCall.output", payload: { id, output } },
];

describe("gradeCase", () => {
  test("passes a read answered from the integration's tool", () => {
    const receipts = parseReceipts(
      events(...linearCall("c1", '{"issues":[]}'), {
        type: "agent.message.completed",
        payload: { text: "HAL-1 Checkout times out for Bluefin is In Progress." },
      }),
    );
    expect(gradeCase(linearRead, receipts)).toMatchObject({ pass: true });
  });

  test("calls an answer with the facts but no receipt hallucinated", () => {
    const receipts = parseReceipts(
      events({
        type: "agent.message.completed",
        payload: { text: "Checkout times out is urgent." },
      }),
    );
    expect(gradeCase(linearRead, receipts)).toMatchObject({
      pass: false,
      category: "hallucinated_result",
    });
  });

  test("reports no_tool when nothing ran", () => {
    const receipts = parseReceipts(
      events({ type: "agent.message.completed", payload: { text: "I can't tell." } }),
    );
    expect(gradeCase(linearRead, receipts)).toMatchObject({ pass: false, category: "no_tool" });
  });

  test("reports a missing card for a not-connected case", () => {
    const testCase: EvalCase = {
      id: "linear.not_connected.x",
      integration: "linear",
      kind: "not_connected",
      prompt: "?",
    };
    const receipts = parseReceipts(
      events({ type: "agent.message.completed", payload: { text: "Please connect Linear." } }),
    );
    expect(gradeCase(testCase, receipts)).toMatchObject({ pass: false, category: "missing_card" });
  });

  test("needs an approval before a write", () => {
    const testCase: EvalCase = {
      id: "linear.write.x",
      integration: "linear",
      kind: "write",
      prompt: "?",
    };
    const receipts = parseReceipts(
      events(...linearCall("c1", '{"id":"HAL-9"}'), {
        type: "agent.message.completed",
        payload: { text: "Created HAL-9." },
      }),
    );
    expect(gradeCase(testCase, receipts)).toMatchObject({
      pass: false,
      category: "approval_problem",
    });
  });

  test("a write the service does not have is a hallucinated success", () => {
    const testCase: EvalCase = {
      id: "linear.write.x",
      integration: "linear",
      kind: "write",
      prompt: "?",
    };
    const receipts = parseReceipts(
      events(
        {
          type: "session.requiresAction",
          payload: {
            approvals: [
              { id: "c1", name: "mcp_abc__create_issue", toolFamily: "integration:mcp.linear.app" },
            ],
          },
        },
        { type: "user.approvalDecision", payload: { approvalId: "c1", decision: "approve" } },
        ...linearCall("c1", '{"id":"HAL-9"}'),
        { type: "agent.message.completed", payload: { text: "Created HAL-9." } },
      ),
    );
    const grade = gradeCase(testCase, receipts, {
      ran: true,
      ok: false,
      detail: "Linear issue not found",
    });
    expect(grade.pass).toBe(false);
  });
});

describe("catalogue", () => {
  test("case ids are unique and integrations are known", () => {
    const ids = CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(INTEGRATIONS.map((spec) => spec.id));
    for (const testCase of CASES) expect(known.has(testCase.integration)).toBe(true);
  });

  test("every write names a verifier and carries the run marker", () => {
    for (const testCase of CASES.filter((item) => item.kind === "write")) {
      expect(testCase.verify).toBeTruthy();
      // A state change on a fixed fixture (Sentry resolve) needs no marker; the verifier resets it.
      if (testCase.verify !== "sentry_payment_issue_resolved")
        expect(testCase.prompt).toContain("{RUN}");
    }
  });

  test("selection skips integrations with a skip reason", () => {
    const skipped = INTEGRATIONS.filter((spec) => spec.skipReason).map((spec) => spec.id);
    for (const testCase of selectCases("all")) expect(skipped).not.toContain(testCase.integration);
    expect(selectCases("linear").every((testCase) => testCase.integration === "linear")).toBe(true);
  });
});

describe("grid", () => {
  test("cells cover every credit model and effort, not subscription models", () => {
    const cells = cellsFromConfig({
      allowedModels: ["a", "codex/b"],
      models: [
        { id: "a", cost: "credits", capabilities: { reasoning: { efforts: ["low", "high"] } } },
        { id: "codex/b", cost: "subscription", capabilities: { reasoning: { efforts: ["low"] } } },
      ],
    });
    expect(cells).toEqual([
      { model: "a", effort: "low" },
      { model: "a", effort: "high" },
    ]);
  });

  test("wilson interval brackets the rate", () => {
    const [low, high] = wilson(20, 24);
    expect(low).toBeLessThan(83);
    expect(high).toBeGreaterThan(83);
  });
});
