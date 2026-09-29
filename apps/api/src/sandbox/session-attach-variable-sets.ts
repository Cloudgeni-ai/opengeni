import type { Settings } from "@opengeni/config";
import {
  getScheduledScopedRigVersionMetadata,
  loadWorkspaceEnvironmentForRun,
  nestedPostgresSqlState,
  type Database,
} from "@opengeni/db";
import { ApiHttpError } from "../http/api-error";

export type SessionAttachVariableSetSession = {
  id: string;
  rigId?: string | null | undefined;
  rigVersionId?: string | null | undefined;
  variableSetIds?: readonly string[] | null | undefined;
  /** Legacy final-entry alias for projections that predate the plural field. */
  variableSetId?: string | null | undefined;
};

type VariableSetSource = "sandbox_environment_default" | "session_selection";

/**
 * Decrypted Variable Set values for a direct session attach (terminal, Files,
 * Git, desktop viewer), in the same order and precedence as the worker turn:
 * the frozen Sandbox Environment version defaults first, then the session's
 * own selection, so a box first warmed by an attach declares exactly the
 * environment the next turn declares.
 *
 * A Variable Set the session can no longer use (the database seam answers
 * 42501 and records a `variable_set.materialize.denied` fact) becomes a 403
 * instead of a bare 500. Every failure is logged with the session, set, source
 * and SQLSTATE, never a value.
 */
export async function loadSessionAttachVariableSetValues(
  db: Database,
  settings: Settings,
  input: {
    accountId: string;
    workspaceId: string;
    session: SessionAttachVariableSetSession;
    /** The authenticated route subject driving the attach; null records the
     *  legacy service sentinel on the materialization audit fact. */
    subjectId: string | null;
  },
): Promise<Record<string, string>> {
  const { accountId, workspaceId, session, subjectId } = input;
  const values: Record<string, string> = {};
  let defaultVariableSetIds: readonly string[] = [];
  if (session.rigId && session.rigVersionId) {
    try {
      const rigVersion = await getScheduledScopedRigVersionMetadata(
        db,
        { accountId, workspaceId, subjectId: subjectId ?? "session-attach" },
        session.rigId,
        session.rigVersionId,
      );
      defaultVariableSetIds = rigVersion?.version.defaultVariableSetIds ?? [];
    } catch (error) {
      logAttachFailure("sandbox environment lookup failed", error, {
        sessionId: session.id,
        rigId: session.rigId,
        rigVersionId: session.rigVersionId,
      });
      throw error;
    }
  }
  // Older persisted/test projections can omit the plural field. Preserve the
  // legacy final alias as the single explicit selection.
  const selectedVariableSetIds =
    session.variableSetIds ?? (session.variableSetId ? [session.variableSetId] : []);
  const ordered: Array<{ variableSetId: string; source: VariableSetSource }> = [
    ...defaultVariableSetIds.map((variableSetId) => ({
      variableSetId,
      source: "sandbox_environment_default" as const,
    })),
    ...selectedVariableSetIds.map((variableSetId) => ({
      variableSetId,
      source: "session_selection" as const,
    })),
  ];
  for (const { variableSetId, source } of ordered) {
    try {
      const loaded = await loadWorkspaceEnvironmentForRun(db, settings, {
        accountId,
        workspaceId,
        variableSetId,
        authority: { kind: "session_attach", sessionId: session.id, subjectId },
      });
      Object.assign(values, loaded?.values ?? {});
    } catch (error) {
      logAttachFailure("variable set materialization failed", error, {
        sessionId: session.id,
        variableSetId,
        source,
      });
      if (nestedPostgresSqlState(error) === "42501") {
        throw new ApiHttpError(403, {
          code: "forbidden",
          message:
            source === "sandbox_environment_default"
              ? "A default Variable Set of this session's Sandbox Environment is not available to this session."
              : "A Variable Set selected for this session is not available to this session.",
          retryable: false,
          details: { variableSetId, source },
        });
      }
      throw error;
    }
  }
  return values;
}

function logAttachFailure(message: string, error: unknown, context: Record<string, string>): void {
  const sqlState = nestedPostgresSqlState(error);
  console.warn(`[session-attach] ${message}`, {
    ...context,
    ...(sqlState ? { sqlState } : {}),
    error: rootCauseMessage(error),
  });
}

/** The innermost cause's message: the database's own reason rather than the
 *  query-builder wrapper that repeats the statement text. */
function rootCauseMessage(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    const cause = current instanceof Error ? current.cause : undefined;
    if (!(cause instanceof Error)) break;
    current = cause;
  }
  return current instanceof Error ? current.message : String(current);
}
