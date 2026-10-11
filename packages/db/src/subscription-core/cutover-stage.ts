/**
 * The provider-neutral write half of a provider's drained cutover codec stage
 * (design docs/design/subscription-core-2026-10-07.md, 5.3 "Data mapping" and
 * "Personal authority generations"): given the provider-keyed plan
 * (`cutover-plan.ts`) and, per canonical connection, the canonical plaintext
 * and the adapter-mapped fields, it writes the connections, their personal
 * authorities at the owner's single cutover generation, workspace
 * assignments and policies, organization reach, quota rows and aliases, and
 * leaves the mapping, disposition and readability tables the provider's SQL
 * backfill reads. A later provider's cutover calls the same writer
 * with its own rows and adapter mapping.
 *
 * Runs only inside a cutover migration's owner window, after the provider's
 * receipt and registry row exist. Secrets never leave the caller's
 * transaction: nothing here logs, and a failure carries no statement values
 * (the caller maps it to a content-free error).
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "../environment-crypto";
import type { SubscriptionCutoverConnection } from "./cutover-plan";

/** One canonical connection with everything its provider's adapter mapped. */
export type SubscriptionCutoverStagedConnection<Row> = {
  connection: SubscriptionCutoverConnection<Row, string>;
  /** The canonical plaintext in the adapter's stored format. */
  plaintext: string;
  credentialFormat: string;
  version: number;
  refreshGeneration: number;
  allocatorVersion: number;
  label: string | null;
  accountEmail: string | null;
  planType: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  lastError: string | null;
  connectedBySubjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  providerState: Record<string, unknown>;
  quota: Record<string, unknown>;
  observedRefreshGeneration: number | null;
  quotaUpdatedAt: Date;
  selectionCount: number;
  lastSelectedAt: Date | null;
  extraCredits: {
    enabled: boolean;
    version: number;
    updatedBySubjectId: string | null;
    updatedAt: Date | null;
  };
};

/**
 * Create the stage's transaction-scoped output tables. `authority_generation`
 * of a personal row is the owner's single cutover generation.
 */
export async function createSubscriptionCutoverStageTables(
  tx: postgres.TransactionSql,
): Promise<void> {
  await tx`CREATE TEMP TABLE subscription_cutover_connection_map (
    legacy_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    ownership text NOT NULL,
    owner_membership_id uuid,
    authority_generation bigint,
    authority_active boolean NOT NULL,
    legacy_scope text NOT NULL,
    legacy_workspace_id uuid
  ) ON COMMIT DROP`;
  await tx`CREATE TEMP TABLE subscription_cutover_dispositions (
    account_id uuid NOT NULL,
    disposition text NOT NULL,
    count bigint NOT NULL
  ) ON COMMIT DROP`;
  await tx`CREATE TEMP TABLE subscription_cutover_readability (
    connection_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    source_digest text NOT NULL,
    target_digest text NOT NULL
  ) ON COMMIT DROP`;
}

/**
 * The owner's single cutover generation per (owner membership, provider)
 * (design 5.3 "Personal authority generations"): greater than every
 * `subscription_connection` authority generation the membership holds for
 * any provider and every generation of the provider's legacy resource kind.
 */
export async function mintSubscriptionCutoverPersonalGenerations(
  tx: postgres.TransactionSql,
  input: { legacyResourceKind: string; ownerMembershipIds: readonly string[] },
): Promise<Map<string, number>> {
  if (input.ownerMembershipIds.length === 0) return new Map();
  const rows = await tx<{ membership_id: string; generation: number | string }[]>`
    SELECT membership.id::text AS membership_id,
      1 + greatest(
        coalesce((SELECT max(authority.generation) FROM organization_user_resource_authorities authority
          WHERE authority.account_id = membership.account_id
            AND authority.organization_membership_id = membership.id
            AND authority.resource_kind = 'subscription_connection'), 0),
        coalesce((SELECT max(authority.generation) FROM organization_user_resource_authorities authority
          WHERE authority.account_id = membership.account_id
            AND authority.organization_membership_id = membership.id
            AND authority.resource_kind = ${input.legacyResourceKind}), 0)
      ) AS generation
    FROM organization_memberships membership
    WHERE membership.id = ANY(${[...input.ownerMembershipIds]}::uuid[])`;
  return new Map(rows.map((row) => [row.membership_id, Number(row.generation)]));
}

/** A content-free digest for the readability parity check; never the secret. */
function readabilityDigest(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Write every staged connection of one provider. The personal generation map
 * must hold every personal connection's owner; `legacyId(row)` names each
 * member row's legacy id, `legacyScope(row)` and `legacyWorkspaceId(row)` its
 * legacy scope and workspace.
 */
export async function writeSubscriptionCutoverConnections<Row>(
  tx: postgres.TransactionSql,
  input: {
    provider: string;
    encryptionKey: Uint8Array;
    staged: readonly SubscriptionCutoverStagedConnection<Row>[];
    personalGenerations: ReadonlyMap<string, number>;
    member: (row: Row) => { id: string; scope: string; workspaceId: string | null };
    now: Date;
  },
): Promise<void> {
  const { provider, encryptionKey, now } = input;
  const dispositions = new Map<string, number>();
  for (const staged of input.staged) {
    const connection = staged.connection;
    for (const disposition of connection.dispositions) {
      const key = `${connection.accountId}\u0000${disposition}`;
      dispositions.set(key, (dispositions.get(key) ?? 0) + 1);
    }
    const personal = connection.ownership === "personal";
    const generation = personal
      ? input.personalGenerations.get(connection.ownerMembershipId!)
      : null;
    if (personal && (generation === undefined || generation === null || generation < 1)) {
      throw new Error("personal cutover generation missing");
    }
    let authorityId: string | null = null;
    if (personal) {
      const [authority] = await tx<{ id: string }[]>`
        INSERT INTO organization_user_resource_authorities (
          account_id, organization_membership_id, resource_kind, resource_id,
          origin_workspace_id, generation, status, revoked_at
        ) VALUES (
          ${connection.accountId}::uuid, ${connection.ownerMembershipId}::uuid,
          'subscription_connection', ${connection.id}::uuid, ${connection.originWorkspaceId}::uuid,
          ${generation!}, ${connection.authorityActive ? "active" : "revoked"},
          ${connection.authorityActive ? null : now}
        ) RETURNING id::text`;
      authorityId = authority!.id;
    }
    await tx`
      INSERT INTO subscription_connections (
        id, account_id, provider, kind, provider_account_id, account_email, label, plan_type,
        credential_encrypted, credential_format, expires_at, last_refresh_at, refresh_generation,
        version, status, last_error, allocator_enabled, allocator_version, excluded_models,
        allowed_model_ids, ownership, owner_organization_membership_id, owner_subject_id,
        authority_id, authority_resource_kind, authority_generation, connected_by_subject_id,
        scope_kind, allow_personal_workspaces, managed_by_workspace_id, provider_state,
        provider_subject_id, created_at, updated_at, extra_credits_enabled,
        extra_credits_version, extra_credits_updated_by_subject_id, extra_credits_updated_at
      ) VALUES (
        ${connection.id}::uuid, ${connection.accountId}::uuid, ${provider}, 'subscription',
        ${connection.identity}, ${staged.accountEmail}, ${staged.label}, ${staged.planType},
        ${encryptEnvironmentValue(encryptionKey, staged.plaintext)}, ${staged.credentialFormat},
        ${staged.expiresAt}, ${staged.lastRefreshAt}, ${staged.refreshGeneration},
        ${staged.version}, ${connection.status}, ${staged.lastError},
        ${connection.allocatorEnabled}, ${staged.allocatorVersion}, '{}'::text[],
        ${connection.allowedModelIds}::text[], ${connection.ownership},
        ${connection.ownerMembershipId}::uuid, ${connection.ownerSubjectId}, ${authorityId}::uuid,
        ${personal ? "subscription_connection" : null}, ${personal ? generation! : null},
        ${staged.connectedBySubjectId}, ${connection.scopeKind},
        ${connection.allowPersonalWorkspaces}, ${connection.managedByWorkspaceId}::uuid,
        ${tx.json(staged.providerState as postgres.JSONValue)}, ${connection.providerSubjectId},
        ${staged.createdAt}, ${staged.updatedAt}, ${staged.extraCredits.enabled},
        ${staged.extraCredits.version}, ${staged.extraCredits.updatedBySubjectId},
        ${staged.extraCredits.updatedAt}
      )`;
    if (connection.autoAssignment) {
      await tx`INSERT INTO opengeni_private.subscription_core_auto_assignments AS auto (
          account_id, provider, connection_id, shared_workspaces, personal_workspaces,
          allocator_enabled, allowed_model_ids
        ) VALUES (
          ${connection.accountId}::uuid, ${provider}, ${connection.id}::uuid,
          ${connection.autoAssignment.sharedWorkspaces},
          ${connection.autoAssignment.personalWorkspaces},
          ${connection.autoAssignment.allocatorEnabled},
          ${connection.autoAssignment.allowedModelIds}::text[]
        )`;
    }
    for (const workspaceId of connection.workspaceIds) {
      await tx`INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
        VALUES (${connection.accountId}::uuid, ${connection.id}::uuid, ${workspaceId}::uuid)`;
    }
    for (const policy of connection.policies) {
      await tx`INSERT INTO subscription_connection_assignment_policies (
          account_id, connection_id, workspace_id, inference_pool, allocator_enabled,
          allowed_model_ids, excluded_models, managed_by_workspace_id, updated_at
        ) VALUES (
          ${connection.accountId}::uuid, ${connection.id}::uuid, ${policy.workspaceId}::uuid,
          ${policy.pool}, ${policy.allocatorEnabled}, ${policy.allowedModelIds}::text[],
          '{}'::text[], ${policy.managedByWorkspaceId}::uuid, ${now}
        )`;
    }
    await tx`INSERT INTO subscription_connection_quota (
        account_id, connection_id, quota, selection_count, last_selected_at,
        observed_refresh_generation, revision, updated_at
      ) VALUES (
        ${connection.accountId}::uuid, ${connection.id}::uuid,
        ${tx.json(staged.quota as postgres.JSONValue)}, ${staged.selectionCount},
        ${staged.lastSelectedAt}, ${staged.observedRefreshGeneration}, 1, ${staged.quotaUpdatedAt}
      )`;
    for (const row of connection.members) {
      const member = input.member(row);
      await tx`INSERT INTO subscription_cutover_connection_map (
          legacy_id, account_id, connection_id, ownership, owner_membership_id,
          authority_generation, authority_active, legacy_scope, legacy_workspace_id
        ) VALUES (
          ${member.id}::uuid, ${connection.accountId}::uuid, ${connection.id}::uuid,
          ${connection.ownership}, ${connection.ownerMembershipId}::uuid,
          ${personal ? generation! : null}, ${connection.authorityActive}, ${member.scope},
          ${member.workspaceId}::uuid
        )`;
      if (member.id !== connection.id) {
        await tx`INSERT INTO subscription_connection_aliases (
            account_id, provider, alias_connection_id, connection_id
          ) VALUES (${connection.accountId}::uuid, ${provider}, ${member.id}::uuid, ${connection.id}::uuid)`;
      }
    }
    // Readability parity: the stored target decrypts to the canonical secret.
    const [stored] = await tx<{ credential_encrypted: string }[]>`
      SELECT credential_encrypted FROM subscription_connections WHERE id = ${connection.id}::uuid`;
    let targetDigest = "unreadable";
    try {
      targetDigest = readabilityDigest(
        decryptEnvironmentValue(encryptionKey, stored!.credential_encrypted),
      );
    } catch {
      targetDigest = "unreadable";
    }
    await tx`INSERT INTO subscription_cutover_readability (
        connection_id, account_id, source_digest, target_digest
      ) VALUES (${connection.id}::uuid, ${connection.accountId}::uuid,
        ${readabilityDigest(staged.plaintext)}, ${targetDigest})`;
  }
  for (const [key, count] of dispositions) {
    const [accountId, disposition] = key.split("\u0000");
    await tx`INSERT INTO subscription_cutover_dispositions (account_id, disposition, count)
      VALUES (${accountId!}::uuid, ${disposition!}, ${count})`;
  }
}
