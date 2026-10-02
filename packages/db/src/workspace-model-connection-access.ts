import { directModelConnectionSpec, isDirectModelId } from "@opengeni/contracts";
import {
  VERCEL_AI_GATEWAY_CONNECTION_DOMAIN,
  WORKSPACE_OPENROUTER_CONNECTION_DOMAIN,
} from "@opengeni/config";
import type { XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { connections } from "./schema";
import { rawRows, withWorkspaceSubjectRls, type Database } from "./database";
import {
  listXaiSubscriptionAccountsMetadata,
  getXaiRotationSettings,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
} from "./xai-subscription";
import { connectionModelAllowed } from "./model-connection-access";

export type ConnectionModelRestrictions = Record<string, string[] | null>;

/** Metadata-only read under the caller's workspace and subject RLS scope. */
async function listDirectModelConnections(db: Database, workspaceId: string, subjectId: string) {
  return await withWorkspaceSubjectRls(db, workspaceId, subjectId, async (tx) =>
    tx
      .select({
        id: connections.id,
        version: connections.version,
        subjectId: connections.subjectId,
        kind: connections.kind,
        status: connections.status,
        providerDomain: connections.providerDomain,
        metadata: connections.metadata,
      })
      .from(connections)
      .where(
        and(
          eq(connections.workspaceId, workspaceId),
          isNull(connections.subjectId),
          eq(connections.kind, "api_key"),
          eq(connections.status, "active"),
          sql`${connections.metadata}->>'credentialRole' IN ('direct_openai', 'direct_azure_openai')`,
        ),
      ),
  );
}

/** Public model-id restrictions only. Never returns connection or private owner identifiers. */
export async function getWorkspaceConnectionModelRestrictions(
  db: Database,
  workspaceId: string,
  subjectId: string,
  codex: ReadonlyArray<{
    status: string;
    allocatorEnabled: boolean;
    allowedModelIds?: string[] | null;
  }>,
  authoritySnapshot?: XaiProviderAccountAuthoritySnapshotV1,
): Promise<ConnectionModelRestrictions> {
  const [xai, xaiAuthority] = await Promise.all([
    listXaiSubscriptionAccountsMetadata(db, { workspaceId, subjectId }),
    authoritySnapshot ??
      resolveXaiProviderAccountAuthoritySnapshotForAcceptance(db, {
        workspaceId,
        subjectId,
      }),
  ]);
  const xaiRotation = await getXaiRotationSettings(db, {
    workspaceId,
    subjectId,
    authoritySnapshot: xaiAuthority,
  });
  const union = (rows: Array<{ allowedModelIds?: string[] | null }>) =>
    rows.some((row) => row.allowedModelIds == null)
      ? null
      : [...new Set(rows.flatMap((row) => row.allowedModelIds ?? []))];
  const restrictions: ConnectionModelRestrictions = {
    "codex/": union(codex.filter((row) => row.status === "active" && row.allocatorEnabled)),
    "supergrok/": union(
      xai.filter(
        (row) =>
          row.scope === xaiAuthority.scope &&
          row.status === "active" &&
          row.allocatorEnabled &&
          (xaiRotation?.rotationEnabled || row.id === xaiRotation?.activeCredentialId),
      ),
    ),
    "workspace-gateway/": [],
    "workspace-openrouter/": [],
    "workspace-anthropic/": [],
    "workspace-claude-subscription/": [],
    "organization-gateway/": [],
    "organization-openrouter/": [],
    "organization-anthropic/": [],
    "organization-claude-subscription/": [],
  };
  await withWorkspaceSubjectRls(db, workspaceId, subjectId, async (tx) => {
    const rows = await rawRows<{
      prefix: string;
      allowedModelIds: string[] | null;
    }>(
      tx,
      sql`
      SELECT CASE provider_kind WHEN 'vercel_gateway' THEN 'organization-gateway/' WHEN 'anthropic' THEN 'organization-anthropic/' WHEN 'claude_subscription' THEN 'organization-claude-subscription/' ELSE 'organization-openrouter/' END AS prefix,
        allowed_model_ids AS "allowedModelIds" FROM organization_model_provider_connections WHERE status = 'active'
      UNION ALL
      SELECT CASE metadata->>'credentialRole' WHEN 'vercel_ai_gateway' THEN 'workspace-gateway/' WHEN 'anthropic' THEN 'workspace-anthropic/' WHEN 'claude_subscription' THEN 'workspace-claude-subscription/' ELSE 'workspace-openrouter/' END,
        allowed_model_ids FROM (
        SELECT DISTINCT ON (metadata->>'credentialRole') * FROM connections WHERE workspace_id = ${workspaceId}::uuid AND subject_id IS NULL
        AND kind = 'api_key' AND status = 'active'
        AND ((metadata->>'credentialRole' = 'vercel_ai_gateway' AND lower(provider_domain) = ${VERCEL_AI_GATEWAY_CONNECTION_DOMAIN})
          OR (metadata->>'credentialRole' = 'openrouter' AND lower(provider_domain) = ${WORKSPACE_OPENROUTER_CONNECTION_DOMAIN})
          OR (metadata->>'credentialRole' IN ('anthropic', 'claude_subscription') AND lower(provider_domain) = 'api.anthropic.com'))
        ORDER BY metadata->>'credentialRole', created_at DESC, id DESC
      ) selected`,
    );
    for (const row of rows) restrictions[row.prefix] = row.allowedModelIds;
  });
  for (const connection of await listDirectModelConnections(db, workspaceId, subjectId)) {
    const spec = directModelConnectionSpec(connection);
    if (spec) restrictions[`${spec.providerId}/`] = [spec.modelId];
  }
  return restrictions;
}

export function modelAllowedByConnections(
  restrictions: ConnectionModelRestrictions,
  modelId: string,
): boolean {
  const prefix = Object.keys(restrictions).find((candidate) => modelId.startsWith(candidate));
  return prefix === undefined || connectionModelAllowed(restrictions[prefix], modelId);
}

/** Authoritative turn gate after allocation, including pins and recovered leases. */
export async function assertModelConnectionAllowsTurn(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    modelId: string;
    codexCredentialId?: string | null;
    xaiCredentialId?: string | null;
    workspaceProviderConnectionId?: string;
  },
): Promise<void> {
  const model = input.modelId;
  let query;
  if (isDirectModelId(model)) {
    const connection = (
      await listDirectModelConnections(db, input.workspaceId, input.subjectId)
    ).find(
      (candidate) =>
        directModelConnectionSpec(candidate)?.modelId === model &&
        (!input.workspaceProviderConnectionId ||
          candidate.id === input.workspaceProviderConnectionId),
    );
    if (!connection)
      throw new Error(
        "This OpenAI or Azure OpenAI connection is no longer available; reconnect and select its model",
      );
    return;
  }
  if (model.startsWith("codex/") || model.startsWith("supergrok/")) {
    const codex = model.startsWith("codex/");
    const id = codex ? input.codexCredentialId : input.xaiCredentialId;
    if (!id) throw new Error("No subscription is available for this model");
    query = sql`SELECT allowed_model_ids AS models FROM ${sql.identifier(codex ? "codex_subscription_credentials" : "xai_subscription_credentials")} WHERE id = ${id}::uuid`;
  } else if (
    model.startsWith("organization-gateway/") ||
    model.startsWith("organization-openrouter/") ||
    model.startsWith("organization-anthropic/") ||
    model.startsWith("organization-claude-subscription/")
  ) {
    query = sql`SELECT allowed_model_ids AS models FROM organization_model_provider_connections
      WHERE provider_kind = ${model.startsWith("organization-gateway/") ? "vercel_gateway" : model.startsWith("organization-anthropic/") ? "anthropic" : model.startsWith("organization-claude-subscription/") ? "claude_subscription" : "openrouter"} AND status = 'active'`;
  } else if (
    model.startsWith("workspace-gateway/") ||
    model.startsWith("workspace-openrouter/") ||
    model.startsWith("workspace-anthropic/") ||
    model.startsWith("workspace-claude-subscription/")
  ) {
    const claude =
      model.startsWith("workspace-anthropic/") ||
      model.startsWith("workspace-claude-subscription/");
    query = sql`SELECT allowed_model_ids AS models FROM connections WHERE workspace_id = ${input.workspaceId}::uuid
      AND subject_id IS NULL AND kind = 'api_key' AND status = 'active'
      AND metadata->>'credentialRole' = ${model.startsWith("workspace-gateway/") ? "vercel_ai_gateway" : model.startsWith("workspace-anthropic/") ? "anthropic" : model.startsWith("workspace-claude-subscription/") ? "claude_subscription" : "openrouter"}
      AND lower(provider_domain) = ${claude ? "api.anthropic.com" : model.startsWith("workspace-gateway/") ? VERCEL_AI_GATEWAY_CONNECTION_DOMAIN : WORKSPACE_OPENROUTER_CONNECTION_DOMAIN}
      ${input.workspaceProviderConnectionId ? sql`AND id = ${input.workspaceProviderConnectionId}::uuid` : sql``}
      ORDER BY created_at DESC, id DESC LIMIT 1`;
  } else return;
  const rows = await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, (tx) =>
    rawRows<{ models: string[] | null }>(tx, query),
  );
  if (!rows.some((row) => connectionModelAllowed(row.models, model)))
    throw new Error("This model is disabled for the selected connection or workspace");
}
