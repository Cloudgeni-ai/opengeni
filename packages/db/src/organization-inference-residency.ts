import { eq, sql } from "drizzle-orm";

import { type Database, rawRows, setSubjectRlsContext, withRlsContext } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import * as schema from "./schema";

/**
 * EU-only inference (migration 1002). When on, every model call for the
 * organization's workspaces must run on an EU route. See
 * docs/organization-tenancy.md.
 */
export type OrganizationInferenceResidencyState = {
  organizationId: string;
  euOnly: boolean;
  /** 0 until the setting is first changed. */
  version: number;
  updatedAt: string | null;
};

/**
 * Who is changing the setting. Only `browser_person` (a signed-in owner or
 * admin using the app, never an agent acting for them or an API key) may turn
 * EU-only off; the database refuses an off change by any other kind.
 */
export type InferenceResidencyActorKind = "browser_person" | "agent" | "api_key";

export class InferenceResidencyChangeRefusedError extends Error {
  constructor(
    readonly reason:
      | "forbidden"
      | "version_conflict"
      | "operation_reused"
      | "invalid"
      | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "InferenceResidencyChangeRefusedError";
  }
}

/** The workspace is missing, or is not in the account the caller named. */
export class WorkspaceInferenceResidencyUnknownError extends Error {
  constructor() {
    super("The workspace's EU-only setting could not be read.");
    this.name = "WorkspaceInferenceResidencyUnknownError";
  }
}

const CHANGE_ROUTINE =
  "opengeni_private.update_organization_inference_residency_v1(uuid, text, text, boolean, bigint, uuid)";

/** The organization's EU-only inference setting. Readable by any member. */
export async function getOrganizationInferenceResidency(
  db: Database,
  accountId: string,
): Promise<OrganizationInferenceResidencyState> {
  return await withRlsContext(db, { accountId, workspaceId: null }, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.organizationInferenceResidency)
      .where(eq(schema.organizationInferenceResidency.accountId, accountId))
      .limit(1);
    return {
      organizationId: accountId,
      euOnly: row?.euOnly ?? false,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });
}

/**
 * Whether model calls for this workspace must stay in the EU. Today the
 * answer is the organization's setting, so every workspace of an EU-only
 * organization, Personal ones included, is EU-only. Callers ask about the
 * workspace so a per-workspace switch can be added here without changing them.
 *
 * The workspace's own account is read in the same scope: a workspace that is
 * missing, belongs to another account or is hidden from this scope throws
 * WorkspaceInferenceResidencyUnknownError, as does any failed read. Callers
 * must never treat an error as "not EU-only".
 */
export async function isWorkspaceEuOnly(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await isWorkspaceEuOnlyInScope(scopedDb, input),
  );
}

/**
 * `isWorkspaceEuOnly` inside a transaction already scoped to the workspace
 * (for example the worker's batched execution-input read). Same checks: a
 * workspace outside the scoped organization is an error, never "not EU-only".
 */
export async function isWorkspaceEuOnlyInScope(
  scopedDb: Database,
  input: { accountId: string; workspaceId: string },
): Promise<boolean> {
  const rows = await rawRows<{
    account_id: string;
    scoped_account_id: string | null;
    eu_only: boolean | null;
  }>(
    scopedDb,
    sql`select workspace.account_id::text as account_id,
        nullif(current_setting('opengeni.account_id', true), '') as scoped_account_id,
        residency.eu_only
      from workspaces workspace
      left join organization_inference_residency residency
        on residency.account_id = workspace.account_id
      where workspace.id = ${input.workspaceId}::uuid`,
  );
  const [row] = rows;
  if (
    rows.length !== 1 ||
    !row ||
    row.account_id.toLowerCase() !== input.accountId.toLowerCase() ||
    row.scoped_account_id?.toLowerCase() !== row.account_id.toLowerCase()
  ) {
    throw new WorkspaceInferenceResidencyUnknownError();
  }
  return row.eu_only === true;
}

/**
 * Whether the runtime may change the setting yet. 1002 withholds EXECUTE on
 * the change function until a later migration grants it (the previous release
 * rejects a runtime grant on a definer it doesn't know); until then the
 * setting stays off. A separate statement: EXECUTE is checked when a
 * statement starts.
 */
export async function inferenceResidencyChangeAvailable(
  db: Pick<Database, "execute">,
): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select has_function_privilege(to_regprocedure(${CHANGE_ROUTINE})::oid, 'EXECUTE')
      as granted`,
  );
  return row?.granted === true;
}

const REFUSALS: Record<string, [InferenceResidencyChangeRefusedError["reason"], string]> = {
  "42501": ["forbidden", "Only an owner or admin can change EU-only."],
  "40001": ["version_conflict", "The EU-only setting changed. Reload and try again."],
  "23505": ["operation_reused", "This operation id was already used for a different change."],
  "22023": ["invalid", "The EU-only change is invalid."],
};

/**
 * Change the setting through the database's change function, which checks
 * the actor's live owner/admin membership (or administering organization key)
 * and refuses turning EU-only off for anyone but an owner or admin person in a
 * browser. `expectedVersion` must match the current version. An operation id
 * is bound to its request: an exact replay returns the stored result, a
 * different request with the same id is refused.
 */
export async function updateOrganizationInferenceResidency(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    actorKind: InferenceResidencyActorKind;
    euOnly: boolean;
    expectedVersion: number;
    operationId: string;
  },
): Promise<OrganizationInferenceResidencyState & { changed: boolean; replayed: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      if (!(await inferenceResidencyChangeAvailable(scopedDb))) {
        throw new InferenceResidencyChangeRefusedError(
          "unavailable",
          "EU-only can't be changed yet.",
        );
      }
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      let result: unknown;
      try {
        const [row] = await rawRows<{ result: unknown }>(
          scopedDb,
          sql`select opengeni_private.update_organization_inference_residency_v1(
            ${input.organizationId}::uuid,
            ${input.actorSubjectId},
            ${input.actorKind},
            ${input.euOnly},
            ${input.expectedVersion}::bigint,
            ${input.operationId}::uuid
          ) as result`,
        );
        result = row?.result;
      } catch (error) {
        const refusal = REFUSALS[nestedPostgresSqlState(error) ?? ""];
        if (refusal) throw new InferenceResidencyChangeRefusedError(...refusal);
        throw error;
      }
      if (!result) throw new Error("EU-only change returned no result.");
      const state = result as {
        organizationId: string;
        euOnly: boolean;
        version: number | string;
        updatedAt: string | null;
        changed: boolean;
        replayed: boolean;
      };
      return {
        organizationId: state.organizationId,
        euOnly: state.euOnly,
        version: Number(state.version),
        updatedAt: state.updatedAt === null ? null : new Date(state.updatedAt).toISOString(),
        changed: state.changed,
        replayed: state.replayed,
      };
    },
  );
}
