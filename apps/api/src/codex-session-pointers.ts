// The legacy Codex session pointers (`codexPinnedCredentialId`,
// `codexLastCredentialId`, and `codexCurrentSelection` when the Session
// carries it) of every Session a response returns, by the organization's
// Codex cutover disposition (M3 PR 2b; current selection M3 PR 3):
// - legacy (no cutover row): the session row's own values, unchanged;
// - core (enabled row): the session's core binding (explicit choice and bound
//   connection) and the active Codex turn's live core lease (or explicit
//   choice while it waits); a session without a Codex binding shows nulls;
// - maintenance (disabled row): nulls, never the legacy ids.
// A session read never fails because of Codex state: if the disposition or the
// bindings cannot be read, the pointers show nulls.
import {
  getSubscriptionCoreCodexCurrentSelections,
  getSubscriptionCoreCodexSessionPointers,
  readCodexCutoverDisposition,
  type Database,
} from "@opengeni/db";

type CodexPointerFields = {
  id: string;
  accountId: string;
  codexPinnedCredentialId: string | null;
  codexLastCredentialId: string | null;
  codexCurrentSelection?: { credentialId: string | null; waiting: boolean } | null | undefined;
};

/** Rewrites one Session's Codex pointer fields (identity for legacy sessions). */
export type CodexSessionPointerProjection = <T extends CodexPointerFields>(session: T) => T;

const unchanged: CodexSessionPointerProjection = (session) => session;

/**
 * Load the projection once for every Session a response returns (all from one
 * workspace). Legacy organizations pay one cutover-row read.
 */
export async function loadCodexSessionPointerProjection(
  db: Database,
  workspaceId: string,
  sessions: readonly CodexPointerFields[],
): Promise<CodexSessionPointerProjection> {
  const accountId = sessions[0]?.accountId;
  if (!accountId) return unchanged;
  let pointers: Map<string, { pinnedCredentialId: string | null; lastCredentialId: string | null }>;
  let selections: Map<string, { credentialId: string | null; waiting: boolean }>;
  try {
    const disposition = await readCodexCutoverDisposition(db, accountId, workspaceId);
    if (disposition === "legacy") return unchanged;
    const sessionIds = sessions.map((session) => session.id);
    [pointers, selections] =
      disposition === "core"
        ? await Promise.all([
            getSubscriptionCoreCodexSessionPointers(db, { accountId, workspaceId, sessionIds }),
            sessions.some((session) => session.codexCurrentSelection !== undefined)
              ? getSubscriptionCoreCodexCurrentSelections(db, {
                  accountId,
                  workspaceId,
                  sessionIds,
                })
              : Promise.resolve(new Map()),
          ])
        : [new Map(), new Map()];
  } catch (error) {
    console.warn("Codex session pointers unavailable; showing none", {
      workspaceId,
      error: error instanceof Error ? error.name : typeof error,
    });
    pointers = new Map();
    selections = new Map();
  }
  return <T extends CodexPointerFields>(session: T): T => {
    const pointer = pointers.get(session.id);
    return {
      ...session,
      codexPinnedCredentialId: pointer?.pinnedCredentialId ?? null,
      codexLastCredentialId: pointer?.lastCredentialId ?? null,
      // A field the Session does not carry stays absent.
      ...(session.codexCurrentSelection === undefined
        ? {}
        : { codexCurrentSelection: selections.get(session.id) ?? null }),
    };
  };
}
