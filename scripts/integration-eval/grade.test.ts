import { describe, expect, test } from "bun:test";
import { CASES } from "./catalogue";
import { gradeCase } from "./grade";
import { INTEGRATIONS } from "./integrations";
import { parseReceipts, type EventLike } from "./receipts";
import { cellsFromConfig, countFlag, latestRecords, parseCells, selectCases, wilson } from "./run";
import type { EvalCase, RunRecord } from "./types";

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

  test("names the integration from the MCP server info when the call has no family", () => {
    const receipts = parseReceipts(
      events(
        {
          type: "agent.toolCall.created",
          payload: { id: "c1", name: "mcp_f00__list_issues", arguments: "{}" },
        },
        {
          type: "agent.toolCall.output",
          payload: {
            id: "c1",
            output:
              '{"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"linear"}},"content":[{"text":"HAL-5 Checkout times out"}]}',
          },
        },
        { type: "agent.message.completed", payload: { text: "HAL-5: Checkout times out." } },
      ),
    );
    expect(receipts.tools[0]?.integration).toBe("linear");
    expect(gradeCase(linearRead, receipts, null).pass).toBe(true);
  });

  test("names the integration from the call's display provider domain", () => {
    const receipts = parseReceipts(
      events(
        {
          type: "agent.toolCall.created",
          payload: {
            id: "c1",
            name: "mcp_f00__save_issue",
            arguments: "{}",
            display: { connector: "Linear", providerDomain: "mcp.linear.app" },
          },
        },
        { type: "agent.toolCall.output", payload: { id: "c1", output: '{"id":"HAL-9"}' } },
      ),
    );
    expect(receipts.tools[0]?.integration).toBe("linear");
  });

  test("a service rate limit that keeps facts out of the answer is excluded as rate_limited", () => {
    const receipts = parseReceipts(
      events(...linearCall("c1", '{"isError":true,"structuredContent":{"error":"rate_limited"}}'), {
        type: "agent.message.completed",
        payload: { text: "Linear is rate limited." },
      }),
    );
    const grade = gradeCase({ ...linearRead, kind: "routing" }, receipts, null);
    expect(grade.category).toBe("rate_limited");
  });

  test("a successful read that mentions a rate limit is not an error", () => {
    const receipts = parseReceipts(
      events(
        ...linearCall("c1", '{"issues":[{"title":"Raise the rate limit for exports"}]}'),
        ...linearCall("c2", '{"body":"Customer saw 403 Forbidden on the old endpoint"}'),
      ),
    );
    expect(receipts.tools.map((tool) => [tool.errored, tool.rateLimited])).toEqual([
      [false, false],
      [false, false],
    ]);
  });

  const writeCase: EvalCase = {
    id: "linear.write.y",
    integration: "linear",
    kind: "write",
    prompt: "?",
  };
  const approvedWrite = (decision: "approve" | "reject", answer: string) =>
    parseReceipts(
      events(
        {
          type: "session.requiresAction",
          payload: {
            approvals: [
              { id: "c1", name: "mcp_abc__save_issue", toolFamily: "integration:mcp.linear.app" },
            ],
          },
        },
        { type: "user.approvalDecision", payload: { approvalId: "c1", decision } },
        ...linearCall("c1", decision === "approve" ? '{"id":"HAL-9"}' : "Rejected by the user."),
        { type: "agent.message.completed", payload: { text: answer } },
      ),
    );

  test("a denied write passes only when the service has nothing", () => {
    const denied = { ...writeCase, decision: "reject" as const };
    const receipts = approvedWrite("reject", "I didn't create it because the request was denied.");
    expect(
      gradeCase(denied, receipts, { ran: true, ok: false, detail: "Linear issue not found" }).pass,
    ).toBe(true);
    const leaked = gradeCase(denied, receipts, { ran: true, ok: true, detail: "HAL-9", count: 1 });
    expect(leaked.category).toBe("approval_problem");
  });

  const approval = (id: string, name = "mcp_abc__save_issue") => ({
    type: "session.requiresAction",
    payload: { approvals: [{ id, name, toolFamily: "integration:mcp.linear.app" }] },
  });
  const decide = (id: string, decision: "approve" | "reject") => ({
    type: "user.approvalDecision",
    payload: { approvalId: id, decision },
  });
  const created = (id: string, name = "mcp_abc__save_issue") => ({
    type: "agent.toolCall.created",
    payload: { id, name, arguments: "{}", toolFamily: "integration:mcp.linear.app" },
  });
  const output = (id: string, text: string) => ({
    type: "agent.toolCall.output",
    payload: { id, output: text },
  });
  const answer = (text: string) => ({ type: "agent.message.completed", payload: { text } });

  test("an approved write that failed fails even if a later read succeeded", () => {
    const receipts = parseReceipts(
      events(
        created("c1"),
        approval("c1"),
        decide("c1", "approve"),
        output("c1", '{"isError":true,"content":[{"text":"team not found"}]}'),
        ...linearCall("c2", '{"issues":[]}'),
        answer("Created the issue."),
      ),
    );
    expect(gradeCase(writeCase, receipts, null)).toMatchObject({
      pass: false,
      category: "tool_error",
    });
  });

  test("an approved write that never ran is an approval problem", () => {
    const receipts = parseReceipts(
      events(created("c1"), approval("c1"), decide("c1", "approve"), {
        type: "turn.failed",
        payload: {},
      }),
    );
    expect(gradeCase(writeCase, receipts, null)).toMatchObject({
      pass: false,
      category: "approval_problem",
    });
  });

  test("a deny row fails when nothing was denied or the write was approved", () => {
    const denied = { ...writeCase, decision: "reject" as const, approval: "optional" as const };
    const ranWithoutApproval = parseReceipts(
      events(created("c1"), output("c1", '{"id":"HAL-9"}'), answer("Done.")),
    );
    expect(gradeCase(denied, ranWithoutApproval, null).category).toBe("approval_problem");
    const approved = approvedWrite("approve", "Created HAL-9.");
    expect(gradeCase(denied, approved, null).category).toBe("approval_problem");
  });

  test("a deny row fails when the denied tool runs again without approval", () => {
    const denied = { ...writeCase, decision: "reject" as const };
    const receipts = parseReceipts(
      events(
        created("c1"),
        approval("c1"),
        decide("c1", "reject"),
        output("c1", "Tool approval was rejected. This proposed tool call was not executed."),
        created("c2"),
        output("c2", '{"id":"HAL-9"}'),
        answer("I didn't create it."),
      ),
    );
    expect(gradeCase(denied, receipts, null).category).toBe("approval_problem");
  });

  test("a verifier error is a harness error, not a pass", () => {
    const receipts = approvedWrite("approve", "Created HAL-9.");
    const grade = gradeCase(writeCase, receipts, {
      ran: false,
      ok: null,
      detail: "verifier error: 502",
      error: true,
    });
    expect(grade.category).toBe("harness_error");
  });

  test("an approval is attributed from its display metadata without a matching call", () => {
    const receipts = parseReceipts(
      events({
        type: "session.requiresAction",
        payload: {
          approvals: [
            {
              id: "a1",
              name: "mcp_f00__save_issue",
              display: { providerDomain: "mcp.linear.app" },
            },
          ],
        },
      }),
    );
    expect(receipts.approvals[0]?.integration).toBe("linear");
  });

  test("an approved write applied twice is an approval problem", () => {
    const receipts = approvedWrite("approve", "Created HAL-9.");
    const grade = gradeCase(writeCase, receipts, {
      ran: true,
      ok: true,
      detail: "HAL-9",
      count: 2,
    });
    expect(grade.category).toBe("approval_problem");
    expect(
      gradeCase(writeCase, receipts, { ran: true, ok: true, detail: "HAL-9", count: 1 }).pass,
    ).toBe(true);
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

  test("cell specs select subscription models, every effort or the default", () => {
    const config = {
      models: [
        { id: "a", cost: "credits", capabilities: { reasoning: { efforts: ["low", "high"] } } },
        {
          id: "codex/b",
          cost: "subscription",
          capabilities: { reasoning: { efforts: ["low", "max"], defaultEffort: "low" } },
        },
      ],
    };
    expect(parseCells("subscription", config)).toEqual([
      { model: "codex/b", effort: "low" },
      { model: "codex/b", effort: "max" },
    ]);
    expect(parseCells("a@*,codex/b@default,a@medium", config)).toEqual([
      { model: "a", effort: "low" },
      { model: "a", effort: "high" },
      { model: "codex/b", effort: "low" },
      { model: "a", effort: "medium" },
    ]);
  });

  test("count flags fall back on bad input", () => {
    expect(countFlag("3", 1)).toBe(3);
    expect(countFlag("abc", 4)).toBe(4);
    expect(countFlag("0", 2)).toBe(2);
    expect(countFlag(undefined, 1)).toBe(1);
  });

  test("the newest record of a job wins", () => {
    const record = (runId: string, pass: boolean) =>
      ({
        runId,
        caseId: "linear.read.urgent",
        model: "m",
        effort: "low",
        repeat: 1,
        grade: { pass, category: pass ? null : "harness_error", reasons: [] },
      }) as unknown as RunRecord;
    expect(latestRecords([record("a", false), record("b", true)]).map((r) => r.runId)).toEqual([
      "b",
    ]);
  });

  test("wilson interval brackets the rate", () => {
    const [low, high] = wilson(20, 24);
    expect(low).toBeLessThan(83);
    expect(high).toBeGreaterThan(83);
  });
});
