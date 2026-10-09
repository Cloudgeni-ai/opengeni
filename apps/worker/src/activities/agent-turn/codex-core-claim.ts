/**
 * Claim-time Codex cutover handling (M3 PR 1). An organization whose Codex
 * cutover row exists (enabled or disabled) must not have its turns read the
 * legacy Codex tables at claim: not the active-credential flag for its Codex
 * turns, and not the legacy Codex Apps designation for any turn.
 */
import { readSubscriptionProviderCutoverState, withRlsContext, type Database } from "@opengeni/db";

export type ClaimCodexCutoverState = "not_configured" | "disabled" | "enabled";

/** Same bound as the legacy active-credential read it stands in for. */
export const CLAIM_CODEX_CUTOVER_READ_ATTEMPTS = 3;
export const CLAIM_CODEX_CUTOVER_READ_RETRY_MS = 50;

/**
 * Read the account's Codex cutover row. Only a thrown (transient) read is
 * retried; a returned state is authoritative. Persistent failure surfaces
 * the error rather than guessing a state.
 */
export async function readClaimCodexCutoverState(
  db: Database,
  input: { accountId: string; workspaceId: string },
  options: { attempts?: number; retryMs?: number } = {},
): Promise<ClaimCodexCutoverState> {
  const attempts = options.attempts ?? CLAIM_CODEX_CUTOVER_READ_ATTEMPTS;
  const retryMs = options.retryMs ?? CLAIM_CODEX_CUTOVER_READ_RETRY_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await withRlsContext(
        db,
        { accountId: input.accountId, workspaceId: input.workspaceId },
        (scoped) =>
          readSubscriptionProviderCutoverState(scoped, {
            accountId: input.accountId,
            provider: "codex",
          }),
      );
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryMs * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The stored shared-core lease-busy chain, ignoring anything malformed. */
export function readSubscriptionLeaseBusyChain(
  metadata: Record<string, unknown> | null | undefined,
): { startedAt: number; executionGeneration: number } | undefined {
  const value = metadata?.subscriptionLeaseBusy;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const startedAt =
    typeof record.startedAt === "string" ? Date.parse(record.startedAt) : Number.NaN;
  const generation = record.executionGeneration;
  return Number.isFinite(startedAt) &&
    typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation > 0
    ? { startedAt, executionGeneration: generation }
    : undefined;
}

/** A cutover row of any state means no legacy Codex Apps credential. */
export function claimMayResolveLegacyCodexApps(input: {
  codexConnectedAppsEnabled: boolean;
  cutover: ClaimCodexCutoverState;
}): boolean {
  return input.codexConnectedAppsEnabled && input.cutover === "not_configured";
}

/**
 * The legacy active-credential flag is read only without a cutover row; with
 * an enabled cutover the shared core decides availability at placement.
 */
export function claimCodexActiveFromCutover(
  cutover: ClaimCodexCutoverState,
): "read_legacy" | boolean {
  return cutover === "not_configured" ? "read_legacy" : cutover === "enabled";
}
