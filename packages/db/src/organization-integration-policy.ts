import {
  OrganizationIntegrationPolicy,
  UpdateOrganizationIntegrationPolicyRequest,
  assertOrganizationIntegrationAllowed,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  rawRows,
  rlsContextForWorkspace,
  setSubjectRlsContext,
  withRlsContext,
  type Database,
} from "./database";

export type OrganizationIntegrationPolicyScope = { accountId: string };
export type OrganizationIntegrationAcquisitionScope = { accountId: string; workspaceId: string };
const policyScope = z.object({
  accountId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
});
const acquisitionScope = policyScope.extend({
  workspaceId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
});
/** Trusted application adapter MUST verify canonical human/local organization-admin
 * provenance or accountScopedApiKeyWorkspaceAuthority (exact account + workspace:admin).
 * This callback is a server dependency, never deserialized request data. The returned
 * subject alone is NOT authentication. DB checks below are live authority fences only.
 */
export type AuthorizeOrganizationIntegrationPolicyAdministration = () => Promise<{
  accountId: string;
  subjectId: string;
}>;

async function requireReadCommitted(tx: Database): Promise<void> {
  const [isolation] = await rawRows<{ level: string }>(
    tx,
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (isolation?.level !== "read committed") {
    throw new Error("Organization integration policy requires read committed isolation");
  }
}

async function read(
  tx: Database,
  scope: OrganizationIntegrationPolicyScope,
): Promise<OrganizationIntegrationPolicy> {
  const [row] = await rawRows<{ policy: unknown }>(
    tx,
    sql`select jsonb_build_object('mode', mode, 'allowedIntegrationKeys', allowed_integration_keys, 'revision', revision) as policy from organization_integration_policies where account_id = ${scope.accountId}::uuid`,
  );
  return OrganizationIntegrationPolicy.parse(row?.policy ?? {});
}

export async function getOrganizationIntegrationPolicy(
  db: Database,
  inputScope: OrganizationIntegrationPolicyScope,
  authorize: AuthorizeOrganizationIntegrationPolicyAdministration,
): Promise<OrganizationIntegrationPolicy> {
  const scope = policyScope.parse(inputScope);
  const actor = await authorize();
  if (actor.accountId.toLowerCase() !== scope.accountId || !actor.subjectId)
    throw new Error("Canonical organization administrator required");
  return withRlsContext(
    db,
    { ...scope, workspaceId: null },
    async (tx) => {
      await requireReadCommitted(tx);
      await setSubjectRlsContext(tx, actor.subjectId);
      // Live authority only: no policy or organization advisory lock on reads.
      await tx.execute(
        sql`select opengeni_private.assert_organization_integration_policy_administrator(${scope.accountId}::uuid, ${actor.subjectId})`,
      );
      return read(tx, scope);
    },
    undefined,
    "none",
  );
}

/** Call before acquiring membership/workspace/credential locks in any enclosing
 * transaction. The SQL operation owns policy-exclusive -> membership -> admin
 * row order; it never locks a workspace and rejects acquisition-lock upgrades.
 */
export async function updateOrganizationIntegrationPolicy(
  db: Database,
  inputScope: OrganizationIntegrationPolicyScope,
  input: UpdateOrganizationIntegrationPolicyRequest,
  authorize: AuthorizeOrganizationIntegrationPolicyAdministration,
): Promise<OrganizationIntegrationPolicy> {
  const scope = policyScope.parse(inputScope);
  const request = UpdateOrganizationIntegrationPolicyRequest.parse(input);
  const actor = await authorize();
  if (actor.accountId.toLowerCase() !== scope.accountId || !actor.subjectId)
    throw new Error("Canonical organization administrator required");
  return withRlsContext(
    db,
    { ...scope, workspaceId: null },
    async (tx) => {
      await requireReadCommitted(tx);
      await setSubjectRlsContext(tx, actor.subjectId);
      const [row] = await rawRows<{ result: unknown }>(
        tx,
        sql`select opengeni_private.update_organization_integration_policy(${scope.accountId}::uuid, ${actor.subjectId}, ${JSON.stringify(request)}::jsonb) as result`,
      );
      return OrganizationIntegrationPolicy.parse(row?.result);
    },
    undefined,
    "none",
  );
}

/** Requires read committed isolation. The shared policy fence precedes EVERY
 * organization-membership, workspace/tenancy, and credential lock. In particular,
 * persistProviderOAuthConnection may take the membership fence inside acquire.
 * Policy writers take exclusive policy -> membership -> live administrator rows,
 * and never workspace rows. Ordinary connection lifecycle writers do not take
 * the policy fence. A caller passing an existing transaction must honor this
 * prefix. Never administer policy inside or after an acquisition in that transaction:
 * the SQL writer rejects shared-to-exclusive upgrades rather than risking deadlock.
 * All final persistence must use tx, never a separate connection. No automatic
 * retries: external effects cannot be rolled back. For slow external preparation,
 * preflight separately and use this guard for final persistence. Existing execution,
 * refresh, credential lifecycle, and cleanup do not belong behind this guard.
 */
export async function withOrganizationIntegrationAcquisition<T>(
  db: Database,
  inputScope: OrganizationIntegrationAcquisitionScope,
  integrationKeys: readonly (string | null)[],
  acquire: (tx: Database) => Promise<T>,
): Promise<T> {
  const requested = acquisitionScope.parse(inputScope);
  // Non-locking authoritative resolution before any new lock; repeat under the
  // policy fence below so a moved/deleted workspace cannot retain stale scope.
  const resolved = await rlsContextForWorkspace(db, requested.workspaceId);
  if (resolved.accountId !== requested.accountId)
    throw new Error("Organization integration policy workspace scope invalid");
  const scope = { accountId: resolved.accountId, workspaceId: requested.workspaceId };
  // Snapshot caller classification so mutation while awaiting cannot change checks.
  const keys = [...integrationKeys];
  if (!keys.length)
    throw new Error("Acquisition requires at least one trusted integration classification");
  return withRlsContext(
    db,
    scope,
    async (tx) => {
      await requireReadCommitted(tx);
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${`organization-integration-policy:${scope.accountId}`}, 0))`,
      );
      // No row lock here: the existing writer owns its canonical membership ->
      // workspace prefix. All policy checks and callback writes share this tx.
      const [workspace] = await rawRows(
        tx,
        sql`select id from workspaces where id = ${scope.workspaceId}::uuid and account_id = ${scope.accountId}::uuid`,
      );
      if (!workspace) throw new Error("Organization integration policy workspace scope invalid");
      const assert = async () => {
        const policy = await read(tx, scope);
        for (const key of keys) assertOrganizationIntegrationAllowed(policy, key);
      };
      await assert();
      const result = await acquire(tx);
      const [finalWorkspace] = await rawRows(
        tx,
        sql`select id from workspaces where id = ${scope.workspaceId}::uuid and account_id = ${scope.accountId}::uuid for key share`,
      );
      if (!finalWorkspace)
        throw new Error("Organization integration policy workspace scope changed before commit");
      await assert();
      return result;
    },
    undefined,
    "none",
  );
}
