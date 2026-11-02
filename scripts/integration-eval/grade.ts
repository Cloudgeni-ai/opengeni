import type { EvalCase, Grade, FailureCategory, Receipts, ToolReceipt } from "./types";

/** `count`: how many matching objects the service holds, when the verifier can tell. */
export type Verification = { ran: boolean; ok: boolean | null; detail: string; count?: number };

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
  return receipts.tools.filter((tool) => tool.integration === testCase.integration);
}

function otherIntegrations(receipts: Receipts, testCase: EvalCase): string[] {
  return [
    ...new Set(
      receipts.tools
        .map((tool) => tool.integration)
        .filter((id): id is NonNullable<typeof id> => id !== null && id !== testCase.integration),
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
    const limited = receipts.tools.some(
      (tool) =>
        tool.integration === testCase.integration &&
        tool.errored &&
        /rate.?limit/i.test(tool.output ?? ""),
    );
    if (limited) return fail("tool_error", [...reasons, "rate limited by the service", missed]);
    return fail("incomplete_answer", [...reasons, missed]);
  }
  return { pass: true, category: null, reasons };
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
  const ok = own.filter((tool) => !tool.errored);

  if (testCase.kind === "identity") {
    if (own.length > 0 && ok.length === 0)
      return fail("tool_error", [...reasons, "every identity tool call failed"]);
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
    const approvals = receipts.approvals.filter(
      (approval) => approval.integration === testCase.integration,
    );
    if (approvals.length === 0 && testCase.approval !== "optional") {
      return fail("approval_problem", [...reasons, "no approval was requested for the write"]);
    }
    if (approvals.length === 0) reasons.push("no approval requested (policy allows the write)");
    if (approvals.some((approval) => approval.decision === null)) {
      return fail("approval_problem", [...reasons, "an approval was never decided"]);
    }
    if (testCase.decision === "reject") {
      if (verification?.ran && verification.ok === true) {
        return fail("approval_problem", [
          ...reasons,
          `the service changed after a denied approval: ${verification.detail}`,
        ]);
      }
      if (
        SUCCESS_CLAIM.test(receipts.finalAnswer) &&
        !/\b(?:not|denied|declined|rejected|cancel+ed)\b|n't\b/i.test(receipts.finalAnswer)
      ) {
        return fail("hallucinated_result", [...reasons, "answer claims the denied write happened"]);
      }
      if (!verification?.ran) reasons.push("verified from receipts only");
      return { pass: true, category: null, reasons: [...reasons, "denied write left no change"] };
    }
    const firstApproval = approvals.length
      ? Math.min(...approvals.map((approval) => approval.sequence))
      : 0;
    const after = own.filter(
      (tool) => tool.sequence >= firstApproval || tool.callId === approvals[0]?.approvalId,
    );
    const afterOk = after.filter((tool) => !tool.errored);
    if (afterOk.length === 0 && after.length > 0) {
      return fail("tool_error", [...reasons, "the approved write failed"]);
    }
    if (verification?.ran && verification.ok === false) {
      const claimed = SUCCESS_CLAIM.test(receipts.finalAnswer);
      return fail(claimed ? "hallucinated_result" : "tool_error", [
        ...reasons,
        `not found in the service: ${verification.detail}`,
      ]);
    }
    if (!verification?.ran) reasons.push("verified from receipts only");
    if ((verification?.count ?? 1) > 1) {
      return fail("approval_problem", [
        ...reasons,
        `one approved write applied ${verification!.count} times`,
      ]);
    }
    return answerChecks(testCase, receipts, reasons);
  }

  if (ok.length === 0)
    return fail("tool_error", [...reasons, `every ${testCase.integration} call failed`]);
  return answerChecks(testCase, receipts, reasons);
}
