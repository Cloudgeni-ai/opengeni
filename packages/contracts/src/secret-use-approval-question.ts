/**
 * Browser/React Native-safe ids of secret approval cards. Deliberately free
 * of the zod runtime so session-only clients can tell an approval card from
 * an ordinary question; `secret-use-approvals.ts` re-exports these as the
 * canonical helpers.
 */

/** Question ids `secret-approval:<request uuid>` bind a card to a stored request. */
export const SECRET_USE_APPROVAL_QUESTION_PREFIX = "secret-approval:";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function secretUseApprovalQuestionId(approvalId: string): string {
  return `${SECRET_USE_APPROVAL_QUESTION_PREFIX}${approvalId}`;
}

/** The request id a question is bound to, or null for any other question. */
export function secretUseApprovalIdFromQuestionId(questionId: string): string | null {
  if (!questionId.startsWith(SECRET_USE_APPROVAL_QUESTION_PREFIX)) return null;
  const id = questionId.slice(SECRET_USE_APPROVAL_QUESTION_PREFIX.length).toLowerCase();
  return UUID_PATTERN.test(id) ? id : null;
}
