/**
 * One `audit_events` row for each Opengeni Console sign-in handoff the
 * Console host completes or refuses. Sign-in belongs to no organization or
 * workspace, so the row has neither. The metadata holds identifiers and the
 * outcome only, never the code, verifier or session token.
 */
import type { Database } from "./database";
import { withLosslessContentWriteVersion } from "./lossless-json";
import * as schema from "./schema";

export const CONSOLE_SIGN_IN_HANDOFF_AUDIT_ACTION = "auth.console_sign_in_handoff";

export type ConsoleSignInHandoffAudit = {
  outcome: "signed_in" | "refused";
  /** Why a handoff was refused (`invalid_grant`, `state_mismatch`, ...); null when signed in. */
  reason: string | null;
  consoleOrigin: string;
  authUserId: string | null;
  /** Console's new Better Auth session. */
  authSessionId: string | null;
  /** The app session that approved the handoff. */
  sourceAuthSessionId: string | null;
  providerId: string | null;
};

export async function recordConsoleSignInHandoff(
  db: Database,
  input: ConsoleSignInHandoffAudit,
): Promise<void> {
  const metadata: Record<string, string> = {
    outcome: input.outcome,
    consoleOrigin: input.consoleOrigin,
  };
  if (input.reason) metadata.reason = input.reason;
  if (input.sourceAuthSessionId) metadata.sourceAuthSessionId = input.sourceAuthSessionId;
  if (input.providerId) metadata.providerId = input.providerId;
  await db.insert(schema.auditEvents).values(
    withLosslessContentWriteVersion(
      {
        accountId: null,
        workspaceId: null,
        subjectId: input.authUserId ? `user:${input.authUserId}` : null,
        action: CONSOLE_SIGN_IN_HANDOFF_AUDIT_ACTION,
        targetType: input.authSessionId ? "auth_session" : null,
        targetId: input.authSessionId,
        metadata,
      },
      "metadata",
      "metadataCodecVersion",
    ),
  );
}
