import type { XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceSubjectRls, type Database } from "./database";
import {
  listXaiSubscriptionAccountsMetadata,
  getXaiRotationSettings,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
} from "./xai-subscription";
import { connectionModelAllowed } from "./model-connection-access";

export type ConnectionModelRestrictions = Record<string, string[] | null>;

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
      resolveXaiProviderAccountAuthoritySnapshotForAcceptance(db, { workspaceId, subjectId }),
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
    "organization-gateway/": [],
    "organization-openrouter/": [],
  };
  await withWorkspaceSubjectRls(db, workspaceId, subjectId, async (tx) => {
    const rows = await rawRows<{ prefix: string; allowedModelIds: string[] | null }>(
      tx,
      sql`
      SELECT CASE provider_kind WHEN 'vercel_gateway' THEN 'organization-gateway/' ELSE 'organization-openrouter/' END AS prefix,
        allowed_model_ids AS "allowedModelIds" FROM organization_model_provider_connections WHERE status = 'active'
      UNION ALL
      SELECT CASE WHEN metadata->>'credentialRole' = 'vercel_ai_gateway' THEN 'workspace-gateway/' ELSE 'workspace-openrouter/' END,
        allowed_model_ids FROM connections WHERE workspace_id = ${workspaceId}::uuid AND subject_id IS NULL
        AND kind = 'api_key' AND status = 'active' AND metadata->>'credentialRole' IN ('vercel_ai_gateway', 'openrouter')`,
    );
    for (const row of rows) restrictions[row.prefix] = row.allowedModelIds;
  });
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
  },
): Promise<void> {
  const model = input.modelId;
  let query;
  if (model.startsWith("codex/") || model.startsWith("supergrok/")) {
    const codex = model.startsWith("codex/");
    const id = codex ? input.codexCredentialId : input.xaiCredentialId;
    if (!id) throw new Error("No subscription is available for this model");
    query = sql`SELECT allowed_model_ids AS models FROM ${sql.identifier(codex ? "codex_subscription_credentials" : "xai_subscription_credentials")} WHERE id = ${id}::uuid`;
  } else if (
    model.startsWith("organization-gateway/") ||
    model.startsWith("organization-openrouter/")
  ) {
    query = sql`SELECT allowed_model_ids AS models FROM organization_model_provider_connections
      WHERE provider_kind = ${model.startsWith("organization-gateway/") ? "vercel_gateway" : "openrouter"} AND status = 'active'`;
  } else if (model.startsWith("workspace-gateway/") || model.startsWith("workspace-openrouter/")) {
    query = sql`SELECT allowed_model_ids AS models FROM connections WHERE workspace_id = ${input.workspaceId}::uuid
      AND subject_id IS NULL AND kind = 'api_key' AND status = 'active'
      AND metadata->>'credentialRole' = ${model.startsWith("workspace-gateway/") ? "vercel_ai_gateway" : "openrouter"}`;
  } else return;
  const rows = await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, (tx) =>
    rawRows<{ models: string[] | null }>(tx, query),
  );
  if (!rows.some((row) => connectionModelAllowed(row.models, model)))
    throw new Error("This model is disabled for the selected connection or workspace");
}
