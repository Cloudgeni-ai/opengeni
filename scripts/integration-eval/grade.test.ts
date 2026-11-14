import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CASES } from "./catalogue";
import { gradeCase } from "./grade";
import { INTEGRATIONS } from "./integrations";
import { parseReceipts, type EventLike } from "./receipts";
import {
  cellsFromConfig,
  countFlag,
  errorCode,
  gradeEvents,
  latestRecords,
  parseCells,
  selectCases,
  stalledOnCapacity,
  stoppedAtDeadline,
  wilson,
} from "./run";
import type { ApprovalAttempt, EvalCase, RunRecord } from "./types";

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

  test("a clarify case passes when the agent asks which system, and fails when it picks one", () => {
    const testCase: EvalCase = {
      id: "microsoft_dynamics.clarify.x",
      integration: "microsoft_dynamics",
      kind: "clarify",
      prompt: "Which of my opportunities close this month?",
      expectAnswer: [/which (crm|system)/i],
      forbidAnswer: [/[$€£]\s?\d/],
    };
    const asked = parseReceipts(
      events({
        type: "agent.message.completed",
        payload: { text: "Which CRM do you use: HubSpot, Salesforce or Dynamics?" },
      }),
    );
    expect(gradeCase(testCase, asked)).toMatchObject({ pass: true });
    const askedAndInvented = parseReceipts(
      events({
        type: "agent.message.completed",
        payload: { text: "Which CRM do you use? Acme renewal ($40,000) closes on the 28th." },
      }),
    );
    expect(gradeCase(testCase, askedAndInvented)).toMatchObject({
      pass: false,
      category: "hallucinated_result",
    });
    const card = {
      capabilityId: "api:microsoft-dynamics",
      capabilityName: "Microsoft Dynamics",
      providerDomain: "dynamics.com",
      integration: "microsoft_dynamics" as const,
      sequence: 1,
    };
    const picked = { ...asked, cards: [card] };
    expect(gradeCase(testCase, picked)).toMatchObject({ pass: false, category: "wrong_tool" });
    const silent = parseReceipts(
      events({ type: "agent.message.completed", payload: { text: "Let me look." } }),
    );
    expect(gradeCase(testCase, silent)).toMatchObject({
      pass: false,
      category: "incomplete_answer",
    });
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

  test("a sibling integration that serves the same data counts as the row's own", () => {
    const receipts = parseReceipts(
      events(
        {
          type: "agent.toolCall.created",
          payload: {
            id: "c1",
            name: "mcp_f00__drives_getitems",
            arguments: "{}",
            display: { connector: "SharePoint", providerDomain: "graph.microsoft.com" },
          },
        },
        { type: "agent.toolCall.output", payload: { id: "c1", output: '{"ok":true}' } },
        {
          type: "agent.message.completed",
          payload: { text: "The Kestrel runbook sets an RTO of 15 minutes." },
        },
      ),
    );
    expect(receipts.tools[0]?.integration).toBe("sharepoint");
    const oneDriveRead: EvalCase = {
      id: "onedrive.read.test",
      integration: "onedrive",
      kind: "read",
      prompt: "What RTO does my Kestrel runbook set?",
      expectAnswer: [/15 ?min/i],
    };
    expect(gradeCase(oneDriveRead, receipts, null)).toMatchObject({ category: "wrong_tool" });
    expect(gradeCase({ ...oneDriveRead, servedBy: ["sharepoint"] }, receipts, null).pass).toBe(
      true,
    );
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

  test("a read whose only call never returned is not a pass", () => {
    const pending = linearCall("c1", "")[0]!;
    const withFacts = parseReceipts(
      events(pending, {
        type: "agent.message.completed",
        payload: { text: "HAL-1 Checkout times out for Bluefin is In Progress." },
      }),
    );
    expect(gradeCase(linearRead, withFacts)).toMatchObject({
      pass: false,
      category: "hallucinated_result",
    });
    const withoutFacts = parseReceipts(
      events(pending, { type: "agent.message.completed", payload: { text: "No answer." } }),
    );
    expect(gradeCase(linearRead, withoutFacts)).toMatchObject({
      pass: false,
      category: "tool_error",
    });
    // Identity rows may answer from context; a call that never returned doesn't fail them.
    const identity: EvalCase = { ...linearRead, kind: "identity", expectAnswer: [/halcyon/i] };
    const identityAnswer = parseReceipts(
      events(pending, {
        type: "agent.message.completed",
        payload: { text: "You are connected to Halcyon Labs." },
      }),
    );
    expect(gradeCase(identity, identityAnswer)).toMatchObject({ pass: true });
  });

  test("an approval from a servedBy sibling counts as the row's own", () => {
    const receipts = parseReceipts(
      events(
        {
          type: "agent.toolCall.created",
          payload: {
            id: "w1",
            name: "mcp_f00__drives_putitem",
            arguments: "{}",
            display: { connector: "SharePoint", providerDomain: "graph.microsoft.com" },
          },
        },
        {
          type: "session.requiresAction",
          payload: {
            approvals: [
              {
                id: "w1",
                name: "mcp_f00__drives_putitem",
                display: { connector: "SharePoint", providerDomain: "graph.microsoft.com" },
              },
            ],
          },
        },
        { type: "user.approvalDecision", payload: { approvalId: "w1", decision: "approve" } },
        { type: "agent.toolCall.output", payload: { id: "w1", output: '{"id":"F1"}' } },
        { type: "agent.message.completed", payload: { text: "Saved the file." } },
      ),
    );
    const oneDriveWrite: EvalCase = {
      id: "onedrive.write.test",
      integration: "onedrive",
      kind: "write",
      prompt: "?",
      servedBy: ["sharepoint"],
    };
    expect(gradeCase(oneDriveWrite, receipts, null)).toMatchObject({ pass: true });
  });

  test("an owner-only row needs the workspace key's approve to get the owner-only refusal", () => {
    const ownerOnly: EvalCase = { ...writeCase, ownerOnlyApproval: true };
    const receipts = approvedWrite("approve", "Created HAL-9.");
    const found = { ran: true, ok: true, detail: "HAL-9", count: 1 };
    const tried = (status: number, code?: string): ApprovalAttempt[] => [
      {
        approvalId: "c1",
        key: "workspace",
        decision: "approve",
        status,
        detail: "Only Ada Quill can approve this action.",
        ...(code ? { code } : {}),
      },
      { approvalId: "c1", key: "main", decision: "approve", status: 200 },
    ];
    expect(
      gradeCase(ownerOnly, receipts, found, tried(403, "APPROVAL_REQUIRES_ACCOUNT_OWNER")),
    ).toMatchObject({
      pass: true,
      reasons: expect.arrayContaining(["workspace key refused as not the owner (403)"]),
    });
    expect(gradeCase(ownerOnly, receipts, found, tried(200)).category).toBe("approval_problem");
    // A 403 for another reason (no access to the chat, wrong scope) proves nothing.
    expect(
      gradeCase(ownerOnly, receipts, found, tried(403, "WORKSPACE_ACCESS_DENIED")).category,
    ).toBe("harness_error");
    expect(gradeCase(ownerOnly, receipts, found, tried(500)).category).toBe("harness_error");
    expect(gradeCase(ownerOnly, receipts, found, tried(0)).category).toBe("harness_error");
    expect(gradeCase(ownerOnly, receipts, found, []).category).toBe("harness_error");
    // Rows without the flag ignore workspace attempts.
    expect(gradeCase(writeCase, receipts, found, tried(200)).pass).toBe(true);
  });

  test("the reason code is read from an API error body", () => {
    const body = JSON.stringify({
      error: {
        code: "forbidden",
        message: "Only Ada Quill can approve this action.",
        details: { code: "APPROVAL_REQUIRES_ACCOUNT_OWNER", accountOwnerLabel: "Ada Quill" },
      },
    });
    expect(errorCode(body)).toEqual({ code: "APPROVAL_REQUIRES_ACCOUNT_OWNER" });
    expect(errorCode('{"error":{"code":"forbidden","message":"no"}}')).toEqual({});
    expect(errorCode("Forbidden")).toEqual({});
  });

  test("a main key refused with 403 is a harness error", () => {
    const receipts = parseReceipts(
      events(created("c1"), approval("c1"), answer("Waiting for approval.")),
    );
    const attempts = [
      {
        approvalId: "c1",
        key: "main" as const,
        decision: "approve" as const,
        status: 403,
        detail: "Only Ada Quill can approve this action.",
      },
    ];
    expect(gradeCase(writeCase, receipts, null, attempts).category).toBe("harness_error");
  });

  test("a chat stopped after a main-key 403 is a harness error, not a timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-grade-"));
    try {
      const stopped = events(created("c1"), approval("c1"), {
        type: "turn.cancelled",
        payload: { reason: "integration eval run deadline" },
      });
      const attempts: ApprovalAttempt[] = [
        { approvalId: "c1", key: "main", decision: "approve", status: 403, detail: "Forbidden" },
      ];
      const graded = gradeEvents(
        writeCase,
        stopped as never,
        true,
        null,
        join(dir, "r.json"),
        true,
        attempts,
      );
      expect(graded.grade.category).toBe("harness_error");
      expect(
        gradeEvents(writeCase, stopped as never, true, null, join(dir, "t.json")).grade.category,
      ).toBe("timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an owner-only row with no approval reports the missing approval", () => {
    const ownerOnly: EvalCase = { ...writeCase, ownerOnlyApproval: true };
    const receipts = parseReceipts(
      events(created("c1"), output("c1", '{"id":"HAL-9"}'), answer("Created HAL-9.")),
    );
    expect(gradeCase(ownerOnly, receipts, null, [])).toMatchObject({
      category: "approval_problem",
      reasons: expect.arrayContaining(["no approval was requested for the write"]),
    });
  });

  test("an approved write through another tool than the row names is the wrong tool", () => {
    const receipts = parseReceipts(
      events(
        created("c1"),
        approval("c1"),
        decide("c1", "approve"),
        output("c1", '{"id":"HAL-9"}'),
        answer("Created HAL-9."),
      ),
    );
    const found = { ran: true, ok: true, detail: "HAL-9", count: 1 };
    expect(gradeCase({ ...writeCase, approvedTool: /__save_issue$/ }, receipts, found).pass).toBe(
      true,
    );
    expect(
      gradeCase({ ...writeCase, approvedTool: /__create_issue$/ }, receipts, found),
    ).toMatchObject({ pass: false, category: "wrong_tool" });
    // A wrong-tool approval wins over the owner-only check (the harness
    // rejects it, so no workspace attempt exists for the row's tool).
    expect(
      gradeCase(
        { ...writeCase, approvedTool: /__create_issue$/, ownerOnlyApproval: true },
        receipts,
        found,
        [],
      ).category,
    ).toBe("wrong_tool");
  });

  test("a plain-text rate-limit output is an errored, rate-limited call", () => {
    const receipts = parseReceipts(
      events(
        ...linearCall("c1", "Rate limit exceeded. Try again in 60 seconds."),
        ...linearCall("c2", "Notes: we discussed the rate limit for exports."),
      ),
    );
    expect(receipts.tools.map((tool) => [tool.errored, tool.rateLimited])).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  test("content blocks led by the runtime's MCP error block are an errored call", () => {
    const failed = JSON.stringify([
      { text: "The tool reported an error.", type: "text" },
      { text: "channel_not_found", type: "text" },
    ]);
    // The same lead text elsewhere (a message body quoting it) is not.
    const quoted = JSON.stringify([
      { text: "Posted.", type: "text" },
      { text: "The tool reported an error.", type: "text" },
    ]);
    const receipts = parseReceipts(
      events(...linearCall("c1", failed), ...linearCall("c2", quoted)),
    );
    expect(receipts.tools.map((tool) => tool.errored)).toEqual([true, false]);
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

  test("a chat stopped while waiting for model capacity is a capacity stall", () => {
    const status = (value: string, reason?: string) => ({
      type: "session.status.changed",
      payload: reason ? { status: value, reason } : { status: value },
    });
    const stalled = events(
      status("running"),
      status("waiting_capacity", "codex_capacity"),
      status("cancelled", "integration eval run deadline"),
    );
    expect(stalledOnCapacity(stalled)).toBe(true);
    expect(stalledOnCapacity(events(status("waiting_capacity"), status("running")))).toBe(false);
  });

  test("a chat the harness stopped at the deadline stays stopped on regrade", () => {
    const stopped = events(
      { type: "turn.started", payload: {} },
      { type: "turn.cancelled", payload: { reason: "integration eval run deadline" } },
    );
    expect(stoppedAtDeadline(stopped)).toBe(true);
    expect(stoppedAtDeadline(events({ type: "turn.cancelled", payload: {} }))).toBe(false);
  });
});
