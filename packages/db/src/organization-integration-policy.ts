import {
  OrganizationIntegrationPolicy,
  UpdateOrganizationIntegrationPolicyRequest,
  assertOrganizationIntegrationAllowed,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";

export type OrganizationIntegrationPolicyScope = { accountId: string; workspaceId: string };
const policyScope = z.object({
  accountId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
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

async function fence(tx: Database, scope: OrganizationIntegrationPolicyScope): Promise<void> {
  const [isolation] = await rawRows<{ level: string }>(
    tx,
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (isolation?.level !== "read committed") {
    throw new Error("Organization integration policy requires read committed isolation");
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${scope.accountId}`}, 0))`,
  );
  const [workspace] = await rawRows(
    tx,
    sql`select id from workspaces where id = ${scope.workspaceId}::uuid and account_id = ${scope.accountId}::uuid for key share`,
  );
  if (!workspace) throw new Error("Organization integration policy workspace scope invalid");
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
): Promise<OrganizationIntegrationPolicy> {
  const scope = policyScope.parse(inputScope);
  return withRlsContext(
    db,
    scope,
    async (tx) => {
      await fence(tx, scope);
      return read(tx, scope);
    },
    undefined,
    "none",
  );
}

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
    scope,
    async (tx) => {
      await fence(tx, scope);
      await setSubjectRlsContext(tx, actor.subjectId);
      const [row] = await rawRows<{ result: unknown }>(
        tx,
        sql`select opengeni_private.update_organization_integration_policy(${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${actor.subjectId}, ${JSON.stringify(request)}::jsonb) as result`,
      );
      return OrganizationIntegrationPolicy.parse(row?.result);
    },
    undefined,
    "none",
  );
}

/** Requires read committed isolation. Call BEFORE any acquisition effects or workspace/credential row locks. When
 * passed an existing transaction, its caller must already follow that prefix order.
 * All final persistence must use tx, never a separate connection. No automatic
 * retries: external effects cannot be rolled back. For slow external preparation,
 * preflight separately and use this guard for final persistence. Existing execution,
 * refresh, credential lifecycle, and cleanup do not belong behind this guard.
 */
export async function withOrganizationIntegrationAcquisition<T>(
  db: Database,
  inputScope: OrganizationIntegrationPolicyScope,
  integrationKeys: readonly (string | null)[],
  acquire: (tx: Database) => Promise<T>,
): Promise<T> {
  const scope = policyScope.parse(inputScope);
  // Snapshot caller classification so mutation while awaiting cannot change checks.
  const keys = [...integrationKeys];
  if (!keys.length)
    throw new Error("Acquisition requires at least one trusted integration classification");
  return withRlsContext(
    db,
    scope,
    async (tx) => {
      await fence(tx, scope);
      const assert = async () => {
        const policy = await read(tx, scope);
        for (const key of keys) assertOrganizationIntegrationAllowed(policy, key);
      };
      await assert();
      const result = await acquire(tx);
      await assert();
      return result;
    },
    undefined,
    "none",
  );
}
