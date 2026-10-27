/**
 * Credential profiles (1014): names and secret references that Opengeni adds
 * to the environment of every command an agent runs. The workspace has at
 * most one profile; a session can add one, which its child sessions inherit.
 * Nothing here holds or reads a secret value. Callers authorize the request
 * (permissions, session access) before these run.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";
import type { CredentialProfileEntryRow } from "./credential-profiles-schema";

export type CredentialProfileRow = typeof schema.credentialProfiles.$inferSelect;

/** How many ancestors a session's profile chain follows (same bound as the vault policy chain). */
const SESSION_CHAIN_MAX_DEPTH = 64;

export class CredentialProfileSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super("session not found");
    this.name = "CredentialProfileSessionNotFoundError";
  }
}

function profileWhere(workspaceId: string, sessionId: string | null) {
  return and(
    eq(schema.credentialProfiles.workspaceId, workspaceId),
    sessionId === null
      ? isNull(schema.credentialProfiles.sessionId)
      : eq(schema.credentialProfiles.sessionId, sessionId),
  );
}

/** The workspace profile (`sessionId` null) or one session's own profile. */
export async function getCredentialProfile(
  db: Database,
  input: { workspaceId: string; sessionId: string | null },
): Promise<CredentialProfileRow | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.credentialProfiles)
      .where(profileWhere(input.workspaceId, input.sessionId))
      .limit(1);
    return row ?? null;
  });
}

export type SaveCredentialProfileInput = {
  workspaceId: string;
  /** NULL: the workspace profile. */
  sessionId: string | null;
  entries: CredentialProfileEntryRow[];
  gitHelper: boolean | null;
  subjectId: string;
  /** The chat whose agent saves it, when an agent does. */
  updatedBySessionId?: string | null;
};

/**
 * Replace one level's profile. An empty profile (no entries, no git helper
 * setting) removes the row. Returns the stored row, or null when removed.
 */
export async function saveCredentialProfile(
  db: Database,
  input: SaveCredentialProfileInput,
): Promise<CredentialProfileRow | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [workspace] = await tx
      .select({ accountId: schema.workspaces.accountId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId))
      .limit(1);
    if (!workspace) throw new Error("credential profile: workspace not found");
    if (input.sessionId !== null) {
      const [session] = await tx
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        )
        .limit(1);
      if (!session) throw new CredentialProfileSessionNotFoundError(input.sessionId);
    }
    const where = profileWhere(input.workspaceId, input.sessionId);
    if (input.entries.length === 0 && input.gitHelper === null) {
      await tx.delete(schema.credentialProfiles).where(where);
      return null;
    }
    const values = {
      entries: input.entries,
      gitHelper: input.gitHelper,
      updatedBySubjectId: input.subjectId,
      updatedBySessionId: input.updatedBySessionId ?? null,
      updatedAt: sql`clock_timestamp()`,
    };
    const [updated] = await tx
      .update(schema.credentialProfiles)
      .set(values)
      .where(where)
      .returning();
    if (updated) return updated;
    const [inserted] = await tx
      .insert(schema.credentialProfiles)
      .values({
        accountId: workspace.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        ...values,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    // A concurrent first save won the insert: this save replaces it.
    const [raced] = await tx.update(schema.credentialProfiles).set(values).where(where).returning();
    if (!raced) throw new Error("credential profile: concurrent save could not be applied");
    return raced;
  });
}

export type CredentialProfileChainLink = {
  /** NULL for the workspace profile. */
  sessionId: string | null;
  entries: CredentialProfileEntryRow[];
  gitHelper: boolean | null;
};

/**
 * The profiles that apply to a session, outermost first: the workspace
 * profile, then each session from the root ancestor down to the session
 * itself. Levels without a profile are omitted.
 */
export async function listCredentialProfileChain(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<CredentialProfileChainLink[]> {
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const rows = await rawRows<{
      session_id: string | null;
      entries: CredentialProfileEntryRow[];
      git_helper: boolean | null;
      depth: number;
    }>(
      tx,
      sql`
        WITH RECURSIVE chain(id, parent_session_id, depth) AS (
          SELECT session_row.id, session_row.parent_session_id, 0
          FROM sessions session_row
          WHERE session_row.workspace_id = ${input.workspaceId}::uuid
            AND session_row.id = ${input.sessionId}::uuid
          UNION ALL
          SELECT parent.id, parent.parent_session_id, chain.depth + 1
          FROM chain
          JOIN sessions parent
            ON parent.id = chain.parent_session_id
           AND parent.workspace_id = ${input.workspaceId}::uuid
          WHERE chain.depth < ${SESSION_CHAIN_MAX_DEPTH}
        )
        SELECT profile.session_id, profile.entries, profile.git_helper, chain.depth
        FROM chain
        JOIN credential_profiles profile
          ON profile.workspace_id = ${input.workspaceId}::uuid
         AND profile.session_id = chain.id
        UNION ALL
        SELECT profile.session_id, profile.entries, profile.git_helper, ${SESSION_CHAIN_MAX_DEPTH + 1}
        FROM credential_profiles profile
        WHERE profile.workspace_id = ${input.workspaceId}::uuid
          AND profile.session_id IS NULL
        ORDER BY depth DESC
      `,
    );
    return rows.map((row) => ({
      sessionId: row.session_id,
      entries: Array.isArray(row.entries) ? row.entries : [],
      gitHelper: row.git_helper,
    }));
  });
}
