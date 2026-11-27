import type { SharedQueryKey } from "../../hooks/shared-query";

/**
 * The organization's billing summary (`GET /v1/billing?accountId=`) in the
 * client's shared reads. The rail's credit row and the chat's credit notices
 * read this one key, so a page shows them from one request. It sits under the
 * credits prefix, so a credit change or a model-settings invalidation re-reads it.
 */
export function billingSummaryQueryKey(accountId: string): SharedQueryKey {
  return ["model-settings", "credits", accountId, "summary"];
}
