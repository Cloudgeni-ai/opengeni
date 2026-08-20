import { createHash } from "node:crypto";
import { dbSearchPath, getSettings } from "@opengeni/config";
import postgres from "postgres";

const REQUIRED_MIGRATIONS = [
  "0285_organization_tenancy_inventory.sql",
  "0291_resource_authority_classification_assertion.sql",
  "0297_session_ownership_classification_and_backfill.sql",
  "0298_organization_tenancy_parity.sql",
  "0300_tenancy_backfill_ledger.sql",
  "0301_session_snapshot_and_pin_visibility.sql",
  "0302_personal_workspace_session_ownership.sql",
  "0303_session_tenancy_product_activation.sql",
] as const;

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function numberAt(value: unknown, path: readonly string[]): number {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return Number.NaN;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "number" ? current : Number.NaN;
}

const REQUIRED_PARITY_LANES = [
  "connectionsLegacyUser",
  "workspaceWriterAdmissionsLegacyUnattributedInWindow",
  "workspaceWriterProcessesLegacyUnattributedInWindow",
  "documentsLegacyPersonalNullAuthority",
  "codexCredentialsUnattributedConnector",
  "workspaceMemberSubjectsWithoutMembershipAnchor",
  "sessionsAttributableButUnattributed",
  "connectionUseLegacyResolutionsInWindow",
] as const;

const REQUIRED_PARITY_GATES = [
  "membership_personal_workspace_pointer",
  "membership_personal_workspace_exclusive",
  "membership_personal_workspace_same_organization",
  "personal_workspace_has_no_membership_row",
  "authority_resource_single_owner",
  "grant_delegation_fence_complete",
  "grant_owner_membership_active",
  "grant_authority_live",
  "grant_session_fence_not_ahead",
  "session_owner_provenance_paired",
  "session_owner_subject_matches_membership",
  "session_owner_membership_same_organization",
  "login_binding_dispute_propagated",
  "identity_active_binding_owned",
  "user_scoped_resource_live_anchor",
] as const;

export function assertSessionTenancyActivationEvidence(inventory: unknown, parity: unknown): void {
  if (
    inventory === null ||
    typeof inventory !== "object" ||
    numberAt(inventory, ["schemaVersion"]) !== 1
  ) {
    throw new Error("Session tenancy activation inventory report is structurally invalid");
  }
  if (parity === null || typeof parity !== "object" || numberAt(parity, ["schemaVersion"]) !== 1) {
    throw new Error("Session tenancy activation parity report is structurally invalid");
  }
  const parityRecord = parity as Record<string, unknown>;
  const gates = parityRecord.gates;
  const lanes = parityRecord.lanes;
  if (gates === null || typeof gates !== "object" || lanes === null || typeof lanes !== "object") {
    throw new Error("Session tenancy activation parity report is structurally invalid");
  }
  const gateRecord = gates as Record<string, unknown>;
  const missingGates = REQUIRED_PARITY_GATES.filter((name) => !(name in gateRecord));
  const failedGates = Object.entries(gateRecord).filter(
    ([, gate]) => numberAt(gate, ["violations"]) !== 0,
  );
  const laneRecord = lanes as Record<string, unknown>;
  const missingLanes = REQUIRED_PARITY_LANES.filter((name) => !(name in laneRecord));
  const undrainedLanes = Object.entries(laneRecord).filter(
    ([, count]) => typeof count !== "number" || count !== 0,
  );
  if (
    missingGates.length > 0 ||
    failedGates.length > 0 ||
    missingLanes.length > 0 ||
    undrainedLanes.length > 0
  ) {
    throw new Error(
      `Session tenancy activation parity is not clean: ${[
        ...missingGates.map((name) => `missing-gate:${name}`),
        ...failedGates.map(([name]) => `gate:${name}`),
        ...missingLanes.map((name) => `missing-lane:${name}`),
        ...undrainedLanes.map(([name]) => `lane:${name}`),
      ].join(", ")}`,
    );
  }
}

function applicationRoles(): string[] {
  const raw = process.env.OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES?.trim();
  if (!raw) {
    throw new Error(
      "OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES must list every API/worker database login",
    );
  }
  const roles = raw.split(",").map((role) => role.trim());
  if (
    roles.length < 1 ||
    roles.length > 16 ||
    new Set(roles).size !== roles.length ||
    roles.some((role) => !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role))
  ) {
    throw new Error("OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES is invalid");
  }
  return roles;
}

async function main(): Promise<void> {
  const organizationId = argument("--organization-id");
  const activatedBy = argument("--activated-by");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    throw new Error("--organization-id <uuid> is required");
  }
  if (!activatedBy?.trim()) throw new Error("--activated-by <operator> is required");

  const settings = getSettings();
  if (!settings.organizationTenancyCanonicalActivationEnabled) {
    throw new Error("OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED=true is required");
  }
  const databaseUrl = process.env.OPENGENI_MIGRATIONS_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("OPENGENI_MIGRATIONS_DATABASE_URL is required");
  const roles = applicationRoles();
  const searchPath = dbSearchPath(settings);
  const sql = postgres(databaseUrl, {
    max: 1,
    ...(searchPath ? { connection: { search_path: searchPath } } : {}),
  });
  try {
    const result = await sql.begin(async (transaction) => {
      await transaction`select set_config('opengeni.account_id', ${organizationId}, true)`;
      const migrations = await transaction<{ name: string }[]>`
        select name from schema_migrations where name = any(${[...REQUIRED_MIGRATIONS]})
      `;
      const applied = new Set(migrations.map((row) => row.name));
      const missing = REQUIRED_MIGRATIONS.filter((name) => !applied.has(name));
      if (missing.length > 0) {
        throw new Error(`Session tenancy activation migrations are missing: ${missing.join(", ")}`);
      }
      const [inventoryRow] = await transaction<{ report: unknown }[]>`
        select inventory_organization_tenancy(${organizationId}::uuid) as report
      `;
      const [parityRow] = await transaction<{ report: unknown }[]>`
        select check_organization_tenancy_parity(${organizationId}::uuid, 10, 30) as report
      `;
      const inventory = inventoryRow?.report;
      const parity = parityRow?.report;
      assertSessionTenancyActivationEvidence(inventory, parity);
      const inventoryDigest = digest(inventory);
      const parityDigest = digest(parity);
      const [activation] = await transaction<
        Array<{
          accountId: string;
          activationVersion: number;
          activatedAt: Date;
          replay: boolean;
        }>
      >`
        select account_id as "accountId", activation_version as "activationVersion",
          activated_at as "activatedAt", replay
        from activate_session_tenancy_product(
          ${organizationId}::uuid, ${inventoryDigest}, ${parityDigest},
          ${activatedBy.trim()}, ${roles}::text[]
        )
      `;
      if (!activation) throw new Error("Session tenancy activation returned no receipt");
      return { ...activation, inventoryDigest, parityDigest };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
