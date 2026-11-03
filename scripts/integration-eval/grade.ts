import type {
  ApprovalAttempt,
  EvalCase,
  Grade,
  FailureCategory,
  Receipts,
  ToolReceipt,
} from "./types";

/**
 * `count`: how many matching objects the service holds, when the verifier can tell.
 * `error`: the verifier itself failed (network, auth), so the service state is unknown.
 */
export type Verification = {
  ran: boolean;
  ok: boolean | null;
  detail: string;
  count?: number;
  error?: boolean;
};

const SUCCESS_CLAIM =
  /\b(?:created|added|posted|sent|updated|done|scheduled|filed|opened|commented)\b/i;

function fail(category: FailureCategory, reasons: string[]): Grade {
  return { pass: false, category, reasons };
}

function matchesAll(answer: string, patterns: readonly RegExp[] | undefined): RegExp[] {
  return (patterns ?? []).filter((pattern) => !pattern.test(answer));
}

function matchesAny(answer: string, patterns: readonly RegExp[] | undefined): RegExp | null {
  return (patterns ?? []).find((pattern) => pattern.test(answer)) ?? null;
}

function integrationTools(receipts: Receipts, testCase: EvalCase): ToolReceipt[] {
  return receipts.tools.filter((tool) => ownIntegration(testCase, tool.integration));
}

/** The row's integration, or one that serves it from the same account (`servedBy`). */
export function ownIntegration(testCase: EvalCase, integration: string | null): boolean {
  if (integration === null) return false;
  return (
    integration === testCase.integration || (testCase.servedBy ?? []).includes(integration as never)
  );
}

/** Some call to the row's integration was rate-limited by the service. */
function rateLimited(receipts: Receipts, testCase: EvalCase): boolean {
  return integrationTools(receipts, testCase).some((tool) => tool.rateLimited);
}

/** Calls that failed: rate limits are the service's doing, not the agent's. */
function failedCalls(
  receipts: Receipts,
  testCase: EvalCase,
  reasons: string[],
  what: string,
): Grade {
  return rateLimited(receipts, testCase)
    ? fail("rate_limited", [...reasons, "rate limited by the service", what])
    : fail("tool_error", [...reasons, what]);
}

function otherIntegrations(receipts: Receipts, testCase: EvalCase): string[] {
  return [
    ...new Set(
      receipts.tools
        .map((tool) => tool.integration)
        .filter((id): id is NonNullable<typeof id> => id !== null && !ownIntegration(testCase, id)),
    ),
  ];
}

function answerChecks(testCase: EvalCase, receipts: Receipts, reasons: string[]): Grade {
  const forbidden = matchesAny(receipts.finalAnswer, testCase.forbidAnswer);
  if (forbidden)
    return fail("hallucinated_result", [...reasons, `answer matched forbidden ${forbidden}`]);
  const missing = matchesAll(receipts.finalAnswer, testCase.expectAnswer);
  if (missing.length > 0) {
    const missed = `answer missed ${missing.map(String).join(", ")}`;
    // A service rate limit, not the model, kept the facts out of the answer.
    if (rateLimited(receipts, testCase))
      return fail("rate_limited", [...reasons, "rate limited by the service", missed]);
    return fail("incomplete_answer", [...reasons, missed]);
  }
  return { pass: true, category: null, reasons };
}

const DENIAL_WORDS = /\b(?:not|denied|declined|rejected|cancel+ed)\b|n't\b/i;

/** Deny rows: a rejected approval, no write afterwards, no change in the service. */
function gradeDenied(
  testCase: EvalCase,
  receipts: Receipts,
  verification: Verification | null,
  reasons: string[],
): Grade {
  const own = integrationTools(receipts, testCase);
  const approvals = receipts.approvals.filter((approval) =>
    ownIntegration(testCase, approval.integration),
  );
  const rejected = approvals.filter((approval) => approval.decision === "reject");
  if (approvals.some((approval) => approval.decision === "approve"))
    return fail("approval_problem", [...reasons, "an approval was approved on a deny row"]);
  if (rejected.length === 0) {
    const changed = verification?.ran && verification.ok === true;
    return fail("approval_problem", [
      ...reasons,
      changed
        ? `the write ran without an approval: ${verification!.detail}`
        : "no approval was requested, so nothing could be denied",
    ]);
  }
  const approvalIds = new Set(approvals.map((approval) => approval.approvalId));
  const deniedNames = new Set(rejected.map((approval) => approval.name));
  const firstDenial = Math.min(...rejected.map((approval) => approval.sequence));
  const bypass = own.filter(
    (tool) =>
      tool.sequence > firstDenial &&
      deniedNames.has(tool.effectiveName) &&
      !approvalIds.has(tool.callId) &&
      tool.completed &&
      !tool.errored,
  );
  if (bypass.length > 0)
    return fail("approval_problem", [...reasons, "the denied write ran again without approval"]);
  if (verification?.error)
    return fail("harness_error", [...reasons, `service check failed: ${verification.detail}`]);
  if (verification?.ran && verification.ok === true) {
    return fail("approval_problem", [
      ...reasons,
      `the service changed after a denied approval: ${verification.detail}`,
    ]);
  }
  if (SUCCESS_CLAIM.test(receipts.finalAnswer) && !DENIAL_WORDS.test(receipts.finalAnswer)) {
    return fail("hallucinated_result", [...reasons, "answer claims the denied write happened"]);
  }
  if (!verification?.ran) reasons.push("verified from receipts only");
  return { pass: true, category: null, reasons: [...reasons, "denied write left no change"] };
}

/**
 * Approve rows: each approved call is the receipt that matters. It must have
 * run (an output exists) without error, and the change must apply once.
 */
function gradeApproved(
  testCase: EvalCase,
  receipts: Receipts,
  verification: Verification | null,
  reasons: string[],
): Grade {
  const own = integrationTools(receipts, testCase);
  const approvals = receipts.approvals.filter((approval) =>
    ownIntegration(testCase, approval.integration),
  );
  let succeeded: ToolReceipt[];
  if (approvals.length === 0) {
    if (testCase.approval !== "optional")
      return fail("approval_problem", [...reasons, "no approval was requested for the write"]);
    reasons.push("no approval requested (policy allows the write)");
    succeeded = own.filter((tool) => tool.completed && !tool.errored);
    if (succeeded.length === 0)
      return failedCalls(receipts, testCase, reasons, `every ${testCase.integration} call failed`);
  } else {
    const approved = approvals.filter((approval) => approval.decision === "approve");
    if (approved.length === 0)
      return fail("approval_problem", [...reasons, "no approval for the write was approved"]);
    // The approval id is the tool call id; fall back to the tool name.
    const calls = approved.map(
      (approval) =>
        own.find((tool) => tool.callId === approval.approvalId) ??
        own.find((tool) => tool.effectiveName === approval.name) ??
        null,
    );
    if (calls.some((call) => call === null || !call.completed))
      return fail("approval_problem", [...reasons, "an approved write never ran"]);
    const wrong = testCase.approvedTool
      ? calls.find((call) => call !== null && !testCase.approvedTool?.test(call.effectiveName))
      : undefined;
    if (wrong)
      return fail("wrong_tool", [...reasons, `the approved write used ${wrong.effectiveName}`]);
    succeeded = calls.filter((call): call is ToolReceipt => call !== null && !call.errored);
    if (succeeded.length === 0)
      return failedCalls(receipts, testCase, reasons, "the approved write failed");
  }
  if (verification?.error)
    return fail("harness_error", [...reasons, `service check failed: ${verification.detail}`]);
  if (verification?.ran && verification.ok === false) {
    const claimed = SUCCESS_CLAIM.test(receipts.finalAnswer);
    return fail(claimed ? "hallucinated_result" : "tool_error", [
      ...reasons,
      `not found in the service: ${verification.detail}`,
    ]);
  }
  if (!verification?.ran) reasons.push("verified from receipts only");
  const applied = verification?.count ?? (approvals.length > 0 ? succeeded.length : 1);
  if (applied > 1) {
    return fail("approval_problem", [...reasons, `one requested write applied ${applied} times`]);
  }
  return answerChecks(testCase, receipts, reasons);
}

/**
 * Owner-only rows: the workspace key's approve attempt must get 403. Returns
 * a failing grade, or null (with a reason added) when the refusal held.
 */
function ownerOnlyCheck(attempts: readonly ApprovalAttempt[], reasons: string[]): Grade | null {
  const tries = attempts.filter((attempt) => attempt.key === "workspace");
  if (tries.length === 0 || tries.some((attempt) => attempt.status === 0))
    return fail("harness_error", [
      ...reasons,
      "no workspace-key approve attempt; set OPENGENI_EVAL_WORKSPACE_API_KEY",
    ]);
  if (tries.some((attempt) => attempt.status >= 200 && attempt.status < 300))
    return fail("approval_problem", [
      ...reasons,
      "a workspace key approved a write on a personal connection",
    ]);
  const other = tries.find((attempt) => attempt.status !== 403);
  if (other)
    return fail("harness_error", [
      ...reasons,
      `workspace-key approve attempt got HTTP ${other.status}, not 403`,
    ]);
  reasons.push("workspace key refused (403)");
  return null;
}

/** No integration tool ran: decide between wrong tool, made-up data and simply no tool. */
function noIntegrationTool(testCase: EvalCase, receipts: Receipts, reasons: string[]): Grade {
  const others = otherIntegrations(receipts, testCase);
  if (others.length > 0)
    return fail("wrong_tool", [...reasons, `used ${others.join(", ")} instead`]);
  const ownCard = receipts.cards.some((card) => card.integration === testCase.integration);
  if (ownCard)
    return fail("no_tool", [...reasons, "showed a connect card although it is connected"]);
  const expected = testCase.expectAnswer ?? [];
  if (expected.length > 0 && matchesAll(receipts.finalAnswer, expected).length === 0) {
    return fail("hallucinated_result", [
      ...reasons,
      "answer has the facts without any tool receipt",
    ]);
  }
  if (matchesAny(receipts.finalAnswer, testCase.forbidAnswer)) {
    return fail("hallucinated_result", [...reasons, "answer invents data without a tool receipt"]);
  }
  return fail("no_tool", [...reasons, `no ${testCase.integration} tool call`]);
}

/**
 * Grade one run from its tool receipts. The answer text is checked only after
 * the receipts show the right tool ran (or, for not-connected cases, that the
 * right connect card was shown).
 */
export function gradeCase(
  testCase: EvalCase,
  receipts: Receipts,
  verification: Verification | null = null,
  attempts: readonly ApprovalAttempt[] = [],
): Grade {
  const reasons: string[] = [];
  if (receipts.humanInputRequests > 0)
    reasons.push(`asked the person ${receipts.humanInputRequests}x`);
  if (receipts.turnStatuses.includes("failed")) reasons.push("a turn failed");

  if (testCase.kind === "not_connected") {
    const own = receipts.cards.filter((card) => card.integration === testCase.integration);
    if (own.length > 0) {
      const forbidden = matchesAny(receipts.finalAnswer, testCase.forbidAnswer);
      if (forbidden)
        return fail("hallucinated_result", [
          ...reasons,
          `card shown but answer invents ${forbidden}`,
        ]);
      return { pass: true, category: null, reasons: [...reasons, "connect card shown"] };
    }
    const otherCards = receipts.cards.map(
      (card) => card.capabilityName ?? card.capabilityId ?? "?",
    );
    if (otherCards.length > 0)
      return fail("wrong_tool", [...reasons, `card for ${otherCards.join(", ")}`]);
    if (matchesAny(receipts.finalAnswer, testCase.forbidAnswer)) {
      return fail("hallucinated_result", [...reasons, "no card and answer invents data"]);
    }
    return fail("missing_card", [...reasons, "no connect card"]);
  }

  const own = integrationTools(receipts, testCase);
  // A call with no output never ran to completion; it is not a success.
  const ok = own.filter((tool) => tool.completed && !tool.errored);

  if (testCase.kind === "identity") {
    // Identity rows don't need a tool call, so a call that never returned
    // leaves the verdict to the answer; a call that returned an error fails it.
    if (own.some((tool) => tool.completed) && ok.length === 0)
      return failedCalls(receipts, testCase, reasons, "every identity tool call failed");
    return answerChecks(testCase, receipts, reasons);
  }

  if (own.length === 0) return noIntegrationTool(testCase, receipts, reasons);

  if (testCase.kind === "routing") {
    const forbiddenUsed = otherIntegrations(receipts, testCase).filter((id) =>
      (testCase.forbidIntegrations ?? []).includes(id as never),
    );
    if (forbiddenUsed.length > 0) reasons.push(`also used ${forbiddenUsed.join(", ")}`);
  }

  if (testCase.kind === "write") {
    const undecided = receipts.approvals.some(
      (approval) => ownIntegration(testCase, approval.integration) && approval.decision === null,
    );
    if (undecided) return fail("approval_problem", [...reasons, "an approval was never decided"]);
    if (testCase.ownerOnlyApproval && testCase.decision !== "reject") {
      const refused = ownerOnlyCheck(attempts, reasons);
      if (refused) return refused;
    }
    return testCase.decision === "reject"
      ? gradeDenied(testCase, receipts, verification, reasons)
      : gradeApproved(testCase, receipts, verification, reasons);
  }

  if (ok.length === 0)
    return unsuccessfulCalls(
      testCase,
      receipts,
      own,
      reasons,
      `every ${testCase.integration} call failed`,
    );
  return answerChecks(testCase, receipts, reasons);
}

/**
 * None of the row's own calls succeeded. If none even returned an output and
 * the answer still states the facts, the answer was made up.
 */
function unsuccessfulCalls(
  testCase: EvalCase,
  receipts: Receipts,
  own: readonly ToolReceipt[],
  reasons: string[],
  what: string,
): Grade {
  const expected = testCase.expectAnswer ?? [];
  if (
    own.every((tool) => !tool.completed) &&
    expected.length > 0 &&
    matchesAll(receipts.finalAnswer, expected).length === 0
  ) {
    return fail("hallucinated_result", [
      ...reasons,
      `no ${testCase.integration} call returned, yet the answer has the facts`,
    ]);
  }
  if (own.every((tool) => !tool.completed))
    return fail("tool_error", [...reasons, `no ${testCase.integration} call returned an output`]);
  return failedCalls(receipts, testCase, reasons, what);
}
