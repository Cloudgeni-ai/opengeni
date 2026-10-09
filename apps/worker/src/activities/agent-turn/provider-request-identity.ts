/** Temporal activity IDs repeat across workflows. Physical request custody is
 * account-wide, so use the durable execution attempt as the request namespace.
 * Recreating the same attempt's sequence deliberately repeats its identities:
 * the reservation fence must still reject an already admitted request.
 */
export function createAttemptRequestIdGenerator(
  attemptId: string,
  purpose: "codex" | "codex-title" | "xai" | "xai-title",
): () => string {
  let sequence = 0;
  return () => `${attemptId}:${purpose}:${++sequence}`;
}
