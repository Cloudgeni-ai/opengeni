import type { Investigation } from "./core";

/** Agreement is not success when the run failed or its evidence is incomplete. */
export function scoreInvestigation(
  result: Investigation,
  expectedAnswer: string,
  requiredPaths: string[],
) {
  const paths = new Set(result.evidence.map((e) => e.path));
  const requiredPathRecall = requiredPaths.length
    ? requiredPaths.filter((p) => paths.has(p)).length / requiredPaths.length
    : null;
  const operationalSuccess = result.status !== "error" && result.status !== "budget_exhausted";
  const answerCorrect = operationalSuccess && result.answer === expectedAnswer;
  return {
    operationalSuccess,
    answerCorrect,
    strictEvidenceSuccess:
      answerCorrect &&
      (requiredPathRecall === null || requiredPathRecall === 1) &&
      result.coverage.unresolvedLocalPaths.length === 0,
    wrongDecisive: result.answer !== "indecisive" && result.answer !== expectedAnswer,
    requiredPathRecall,
  };
}
