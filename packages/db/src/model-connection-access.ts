import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  withRlsContext,
  withWorkspaceSubjectRls,
  setSubjectRlsContext,
  rawRows,
  type Database,
} from "./database";
import type { ProviderId } from "@opengeni/subscriptions";
import { SUBSCRIPTION_CORE_CODEX_PROVIDER } from "./subscription-core-codex-provider";
import { subscriptionCoreProvider } from "./subscription-core-providers";
import {
  readSubscriptionCoreConnectionAccess,
  SubscriptionCoreAccessForbiddenError,
  SubscriptionCoreAccessWorkspaceNotInOrganizationError,
  updateSubscriptionCoreConnectionAccess,
  type SubscriptionCoreAccess,
} from "./subscription-core/access";

export type ModelConnectionKind =
  | "codex"
  | "supergrok"
  | "vercel_gateway"
  | "openrouter"
  | "anthropic"
  | "claude_subscription"
  | "opper";
export type ModelConnectionAccess = {
  allowedModels: string[] | null;
  allowedWorkspaces: string[] | null;
  allowPersonalWorkspaces: boolean;
  /** Chosen people (organization membership ids); shared core connections only. */
  allowedPeople?: string[] | null | undefined;
  version: number;
};
export type ModelConnectionTarget = {
  accountId: string;
  workspaceId: string | null;
  subjectId: string;
  kind: ModelConnectionKind;
  connectionId: string;
};

/** A requested access policy names a workspace outside the organization's shared workspaces. */
export class ModelConnectionWorkspaceNotInOrganizationError extends Error {
  constructor() {
    super("A selected workspace is not in this organization");
    this.name = "ModelConnectionWorkspaceNotInOrganizationError";
  }
}

/** The viewer can read a connection's access but may not change it. */
export class ModelConnectionAccessForbiddenError extends Error {
  constructor() {
    super("You can't change what this account serves");
    this.name = "ModelConnectionAccessForbiddenError";
  }
}

export function connectionModelAllowed(
  allowedModels: readonly string[] | null | undefined,
  modelId: string,
): boolean {
  return allowedModels == null || allowedModels.includes(modelId);
}

/**
 * Replace a default only when it is outside the assigned pool. An assigned
 * paused/unhealthy default remains explicit intent: rotation-off must wait,
 * not silently change the billed subscription. Allocation checks health later.
 */
export function assignedConnectionDefault(
  preferred: string | null,
  accounts: readonly { id: string; status: string; allocatorEnabled: boolean }[],
): string | null {
  return accounts.some((account) => account.id === preferred)
    ? preferred
    : (accounts.find((account) => account.status === "active" && account.allocatorEnabled)?.id ??
        null);
}

function relation(target: ModelConnectionTarget): { table: SQLWrapper; condition: SQL } {
  if (target.kind === "codex") throw new Error("Codex access policies use the shared core");
  if (target.kind === "supergrok" || target.kind === "claude_subscription")
    return {
      table: sql.identifier(
        target.kind === "supergrok"
          ? "xai_subscription_credentials"
          : "claude_subscription_credentials",
      ),
      condition: sql`id = ${target.connectionId}::uuid AND account_id = ${target.accountId}::uuid AND ${
        target.workspaceId === null
          ? sql`authority_scope = 'organization'`
          : sql`workspace_id = ${target.workspaceId}::uuid AND authority_scope <> 'organization'`
      }`,
    };
  if (target.workspaceId === null)
    return {
      table: sql.identifier("organization_model_provider_connections"),
      condition: sql`account_id = ${target.accountId}::uuid AND provider_kind = ${target.kind} AND status = 'active'
        AND ${target.connectionId === "current" ? sql`true` : sql`id::text = ${target.connectionId}`}`,
    };
  return {
    table: sql.identifier("connections"),
    condition: sql`account_id = ${target.accountId}::uuid AND workspace_id = ${target.workspaceId}::uuid
      AND id = ${target.connectionId}::uuid AND subject_id IS NULL AND kind = 'api_key' AND status = 'active'
      AND metadata->>'credentialRole' = ${target.kind === "vercel_gateway" ? "vercel_ai_gateway" : target.kind}
      ${target.kind === "anthropic" ? sql`AND lower(provider_domain) = 'api.anthropic.com'` : sql``}
      ${target.kind === "opper" ? sql`AND lower(provider_domain) = 'api.opper.ai'` : sql``}`,
  };
}

async function scoped<T>(
  db: Database,
  target: ModelConnectionTarget,
  use: (db: Database) => Promise<T>,
) {
  if (target.workspaceId !== null)
    return await withWorkspaceSubjectRls(db, target.workspaceId, target.subjectId, use);
  return await withRlsContext(
    db,
    { accountId: target.accountId, workspaceId: null },
    async (tx) => {
      await setSubjectRlsContext(tx, target.subjectId);
      await tx.execute(
        sql`select get_organization_administration_overview(${target.accountId}::uuid, ${target.subjectId})`,
      );
      return await use(tx);
    },
  );
}

export async function getModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
): Promise<ModelConnectionAccess | null> {
  if (target.kind === "codex")
    return await getSubscriptionCoreCodexModelConnectionAccess(db, target);
  return await scoped(db, target, async (tx) => {
    const { table, condition } = relation(target);
    const [row] = await rawRows<ModelConnectionAccess>(
      tx,
      sql`SELECT
      allowed_model_ids AS "allowedModels", allowed_workspace_ids AS "allowedWorkspaces",
      allow_personal_workspaces AS "allowPersonalWorkspaces", access_policy_version AS version
      FROM ${table} WHERE ${condition} LIMIT 1`,
    );
    return row ?? null;
  });
}

/** The legacy policy shape; `allowedPeople` appears only when people are chosen. */
function legacyCorePolicy(access: SubscriptionCoreAccess): ModelConnectionAccess {
  const { allowedPeople, ...policy } = access.policy;
  return allowedPeople === null ? policy : { ...policy, allowedPeople };
}

function coreTarget(target: ModelConnectionTarget) {
  return {
    accountId: target.accountId,
    workspaceId: target.workspaceId,
    subjectId: target.subjectId,
    connectionId: target.connectionId,
  };
}

function codexTarget(target: ModelConnectionTarget) {
  if (target.kind !== "codex") throw new Error("Only Codex connections are on the core here");
  return target;
}

/**
 * A shared connection's access on the shared subscription core, for any
 * registered provider, with the workspaces that use it as their own and its
 * delegated manager (design 5.4). The organization route reads any
 * organization account, including one a shared workspace manages; the
 * workspace route only one that workspace manages.
 */
export async function readSubscriptionCoreModelConnectionAccess(
  db: Database,
  provider: ProviderId,
  target: ModelConnectionTarget,
): Promise<SubscriptionCoreAccess | null> {
  return await readSubscriptionCoreConnectionAccess(
    db,
    subscriptionCoreProvider(provider),
    coreTarget(target),
  );
}

/** A shared Codex connection's access on the shared subscription core. */
export async function readSubscriptionCoreCodexModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
): Promise<SubscriptionCoreAccess | null> {
  return await readSubscriptionCoreModelConnectionAccess(
    db,
    SUBSCRIPTION_CORE_CODEX_PROVIDER,
    codexTarget(target),
  );
}

/**
 * A shared connection's access policy on the shared subscription core, for
 * any registered provider, in the legacy shape. `allowedWorkspaces` is null
 * when every shared workspace, including ones created later, may use it.
 */
export async function getSubscriptionCoreModelConnectionAccess(
  db: Database,
  provider: ProviderId,
  target: ModelConnectionTarget,
): Promise<ModelConnectionAccess | null> {
  const access = await readSubscriptionCoreModelConnectionAccess(db, provider, target);
  return access ? legacyCorePolicy(access) : null;
}

/** A shared Codex connection's access policy on the shared subscription core. */
export async function getSubscriptionCoreCodexModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
): Promise<ModelConnectionAccess | null> {
  return await getSubscriptionCoreModelConnectionAccess(
    db,
    SUBSCRIPTION_CORE_CODEX_PROVIDER,
    codexTarget(target),
  );
}

/**
 * Save what a shared connection of any registered provider serves on the
 * core (`updateSubscriptionCoreConnectionAccess`). Null when the connection
 * is gone or its access changed since `policy.version` was read.
 */
export async function updateSubscriptionCoreModelConnectionAccess(
  db: Database,
  provider: ProviderId,
  target: ModelConnectionTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  const binding = subscriptionCoreProvider(provider);
  try {
    const access = await updateSubscriptionCoreConnectionAccess(
      db,
      binding,
      coreTarget(target),
      policy,
    );
    return access ? legacyCorePolicy(access) : null;
  } catch (error) {
    if (error instanceof SubscriptionCoreAccessWorkspaceNotInOrganizationError)
      throw new ModelConnectionWorkspaceNotInOrganizationError();
    if (error instanceof SubscriptionCoreAccessForbiddenError)
      throw new ModelConnectionAccessForbiddenError();
    throw error;
  }
}

/** Save what a shared Codex connection serves on the core. */
export async function updateSubscriptionCoreCodexModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  return await updateSubscriptionCoreModelConnectionAccess(
    db,
    SUBSCRIPTION_CORE_CODEX_PROVIDER,
    codexTarget(target),
    policy,
  );
}

export async function updateModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  if (target.kind === "codex") return null;
  if (policy.allowedPeople != null)
    throw new Error("Only accounts on the shared subscription core can be limited to people");
  return await scoped(db, target, async (tx) => {
    const { table, condition } = relation(target);
    if (target.workspaceId !== null && policy.allowedWorkspaces !== null)
      throw new Error("Workspace connections cannot assign other workspaces");
    if (target.workspaceId === null && policy.allowedWorkspaces !== null) {
      const allowed = await rawRows<{ workspace_id: string }>(
        tx,
        sql`select workspace_id from list_organization_workspace_ids(${target.accountId}::uuid)`,
      );
      const ids = new Set(allowed.map((row) => row.workspace_id));
      if (policy.allowedWorkspaces.some((id) => !ids.has(id)))
        throw new ModelConnectionWorkspaceNotInOrganizationError();
    }
    const [row] = await rawRows<ModelConnectionAccess>(
      tx,
      sql`UPDATE ${table} SET
      allowed_model_ids = ${policy.allowedModels === null ? sql`NULL` : sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(policy.allowedModels)}::jsonb))`}, allowed_workspace_ids = ${policy.allowedWorkspaces === null ? sql`NULL` : sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(policy.allowedWorkspaces)}::jsonb)::uuid)`},
      allow_personal_workspaces = ${policy.allowPersonalWorkspaces}, access_policy_version = access_policy_version + 1,
      access_policy_updated_by = ${target.subjectId}, access_policy_updated_at = now()
      WHERE ${condition} AND access_policy_version = ${policy.version}
      RETURNING allowed_model_ids AS "allowedModels", allowed_workspace_ids AS "allowedWorkspaces",
        allow_personal_workspaces AS "allowPersonalWorkspaces", access_policy_version AS version`,
    );
    return row ?? null;
  });
}
