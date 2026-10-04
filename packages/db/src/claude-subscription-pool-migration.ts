import { createHmac } from "node:crypto";
import type postgres from "postgres";
import { ClaudeSubscriptionCredential } from "@opengeni/config";
import { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";

/** A closed maintenance conversion, never a runtime credential fallback. */
export const CLAUDE_POOL_MIGRATION_MARKER = "-- opengeni:claude-subscription-pool-copy-v1";

type LegacyCredential = {
  id: string;
  account_id: string;
  workspace_id: string | null;
  credential_encrypted: string;
  version: number;
  metadata: Record<string, unknown>;
  claude_usage_snapshot: unknown;
  allowed_model_ids: string[] | null;
  allowed_workspace_ids: string[] | null;
  allow_personal_workspaces: boolean;
  access_policy_version: number;
  access_policy_updated_by: string | null;
  access_policy_updated_at: Date | null;
  connected_by_subject_id: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  last_refresh_at: Date | null;
  last_error: string | null;
};

function credential(key: Uint8Array, row: LegacyCredential) {
  try {
    const plaintext = decryptEnvironmentValue(key, row.credential_encrypted);
    const value = row.workspace_id ? JSON.parse(plaintext).apiKey : plaintext;
    if (typeof value !== "string") throw new Error("missing credential");
    const bundle = value.trim().startsWith("{")
      ? JSON.parse(value)
      : {
          version: 1,
          token: value,
          identity: {
            accountUuid: "",
            deviceId: createHmac("sha256", key)
              .update("claude-device:" + (row.workspace_id ?? row.account_id))
              .digest("hex"),
          },
        };
    return ClaudeSubscriptionCredential.parse(bundle);
  } catch {
    // Neither schema-validation values nor encrypted/provider material may
    // escape through migration diagnostics.
    throw new Error("Claude subscription migration could not decode a legacy credential");
  }
}

export async function migrateClaudeSubscriptionPoolCredentials(
  tx: postgres.TransactionSql,
  encryptionKey: Uint8Array | undefined,
): Promise<void> {
  const rows = await tx<LegacyCredential[]>`
    SELECT id, account_id, workspace_id, credential_encrypted, version, metadata,
      claude_usage_snapshot, allowed_model_ids, allowed_workspace_ids,
      allow_personal_workspaces, access_policy_version, access_policy_updated_by,
      access_policy_updated_at, coalesce(updated_by_subject_id, created_by_subject_id) AS connected_by_subject_id,
      created_at, updated_at, expires_at, last_refresh_at, last_error
    FROM connections WHERE provider_domain = 'api.anthropic.com' AND kind = 'api_key'
      AND metadata->>'credentialRole' = 'claude_subscription' AND status = 'active'
      AND subject_id IS NULL AND authority_scope = 'workspace'
    UNION ALL
    SELECT id, account_id, NULL::uuid, credential_encrypted, version, '{}'::jsonb,
      claude_usage_snapshot, allowed_model_ids, allowed_workspace_ids,
      allow_personal_workspaces, access_policy_version, access_policy_updated_by,
      access_policy_updated_at, updated_by_subject_id, created_at, updated_at,
      NULL::timestamptz, NULL::timestamptz, NULL::text
    FROM organization_model_provider_connections
    WHERE provider_kind = 'claude_subscription' AND status = 'active'
    ORDER BY updated_at DESC, id DESC
  `;
  if (rows.length && encryptionKey?.length !== 32)
    throw new Error(
      "Claude subscription migration requires the existing environments encryption key",
    );

  for (const row of rows) {
    const secret = credential(encryptionKey!, row);
    const stored = encryptEnvironmentValue(encryptionKey!, JSON.stringify(secret));
    const providerAccountId =
      secret.identity.accountUuid ||
      (secret.oauth ? "oauth:" : "setup:") +
        createHmac("sha256", encryptionKey!).update(secret.token).digest("hex");
    const scope = row.workspace_id ? "workspace" : "organization";
    await tx`INSERT INTO claude_subscription_credentials (
      id, account_id, workspace_id, authority_scope, credential_encrypted, provider_account_id,
      label, account_email, plan_type, version, expires_at, last_refresh_at, last_error,
      allowed_model_ids, allowed_workspace_ids, allow_personal_workspaces, access_policy_version,
      access_policy_updated_by, access_policy_updated_at, connected_by_subject_id, created_at, updated_at
    ) VALUES (
      ${row.id}, ${row.account_id}, ${row.workspace_id}, ${scope}, ${stored}, ${providerAccountId},
      'Claude subscription', NULL, NULL, ${row.version},
      ${secret.oauth ? new Date(secret.oauth.expiresAt) : row.expires_at}, ${row.last_refresh_at}, ${row.last_error},
      ${row.allowed_model_ids}, ${row.allowed_workspace_ids}, ${row.allow_personal_workspaces}, ${row.access_policy_version},
      ${row.access_policy_updated_by}, ${row.access_policy_updated_at}, ${row.connected_by_subject_id}, ${row.created_at}, ${row.updated_at}
    )`;
    const usage = ClaudeSubscriptionUsage.safeParse(row.claude_usage_snapshot);
    if (usage.success && usage.data.credentialVersion === row.version)
      await tx`INSERT INTO claude_subscription_account_usage
        (credential_id, account_id, credential_version, snapshot, updated_at)
        VALUES (${row.id}, ${row.account_id}, ${row.version}, ${tx.json(usage.data)}, ${row.updated_at})`;
    // The legacy worker selected the newest active workspace connection.
    // Keep that pointer; importing older rows must not turn on rotation.
    await tx`INSERT INTO claude_rotation_settings
      (account_id, workspace_id, authority_scope, active_credential_id, rotation_enabled, created_at, updated_at)
      VALUES (${row.account_id}, ${row.workspace_id}, ${scope}, ${row.id}, false, ${row.created_at}, ${row.updated_at})
      ON CONFLICT DO NOTHING`;
  }
  await tx`UPDATE connections SET status = 'revoked', credential_encrypted = '', claude_usage_snapshot = NULL
    WHERE metadata->>'credentialRole' = 'claude_subscription'`;
  await tx`UPDATE organization_model_provider_connections SET status = 'revoked', credential_encrypted = '', claude_usage_snapshot = NULL
    WHERE provider_kind = 'claude_subscription'`;
}
