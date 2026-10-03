import { createHash } from "node:crypto";
import { dbSearchPath, getSettings } from "@opengeni/config";
import postgres from "postgres";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../packages/db/src/lossless-json";

const REQUIRED_MIGRATIONS = [
  "0285_organization_tenancy_inventory.sql",
  "0291_resource_authority_classification_assertion.sql",
  "0292_truthful_tenancy_inventory_counters.sql",
  "0297_session_ownership_classification_and_backfill.sql",
  "0298_organization_tenancy_parity.sql",
  "0300_tenancy_backfill_ledger.sql",
  "0301_session_snapshot_and_pin_visibility.sql",
  "0302_personal_workspace_session_ownership.sql",
  "0303_session_tenancy_product_activation.sql",
  "0340_tenancy_backfill_activation_evidence.sql",
] as const;
export const FLEET_PREPARATION_MIGRATION = "0583_session_tenancy_operator_permission.sql";
// Rolling definitions alone cannot admit the irreversible fleet activation.
export const FLEET_MIGRATION = "0586_private_sessions_fleet_activation.sql";

export function requiredActivationMigrations(allOrganizations: boolean): readonly string[] {
  return allOrganizations
    ? [...REQUIRED_MIGRATIONS, FLEET_PREPARATION_MIGRATION, FLEET_MIGRATION]
    : REQUIRED_MIGRATIONS;
}

export function activationDatabaseUrl(databaseUrl: string): string {
  // Preserve the authority/path verbatim, including postgres-js multi-host URLs.
  // URL query parameters override connection options in the actual driver.
  const fragmentIndex = databaseUrl.indexOf("#");
  const fragment = fragmentIndex < 0 ? "" : databaseUrl.slice(fragmentIndex);
  const connectionUrl = fragmentIndex < 0 ? databaseUrl : databaseUrl.slice(0, fragmentIndex);
  const queryIndex = connectionUrl.indexOf("?");
  const authorityAndPath = queryIndex < 0 ? connectionUrl : connectionUrl.slice(0, queryIndex);
  const parameters = new URLSearchParams(queryIndex < 0 ? "" : connectionUrl.slice(queryIndex + 1));
  parameters.set("application_name", LOSSLESS_CONTENT_WRITER_APPLICATION_NAME);
  return `${authorityAndPath}?${parameters.toString()}${fragment}`;
}

export function activationConnectionOptions(searchPath?: string) {
  return {
    max: 1,
    connection: {
      // Use the same PgBouncer-compatible current-protocol identity as createDb.
      application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
      ...(searchPath ? { search_path: searchPath } : {}),
    },
  };
}

function argument(name: string, argv: readonly string[] = process.argv): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

export function activationScope(argv: readonly string[]): {
  organizationId: string | null;
  allOrganizations: boolean;
} {
  const organizationId = argument("--organization-id", argv);
  const allOrganizations = argv.includes("--all-organizations");
  if (
    allOrganizations === Boolean(organizationId) ||
    (organizationId !== null &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId))
  ) {
    throw new Error("Supply exactly one of --organization-id <uuid> or --all-organizations");
  }
  if (argv.includes("--enable-organization-private-sessions")) {
    throw new Error(
      "Activation preserves organization preferences; an owner or admin must opt in separately",
    );
  }
  return { organizationId, allOrganizations };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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

const REQUIRED_BACKFILL_RECEIPT_FAMILIES = [
  "organization_memberships",
  "sessions",
  "variable_sets",
  "rigs",
  "machines",
  "connections",
] as const;

export function assertSessionTenancyBackfillEvidence(evidence: unknown): void {
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    numberAt(evidence, ["schemaVersion"]) !== 1
  ) {
    throw new Error("Session tenancy activation backfill evidence is structurally invalid");
  }
  const record = evidence as Record<string, unknown>;
  const families = record.families;
  const receiptIds = record.receiptIds;
  const blockers = record.blockers;
  if (
    record.ready !== true ||
    families === null ||
    typeof families !== "object" ||
    !Array.isArray(receiptIds) ||
    receiptIds.length !== REQUIRED_BACKFILL_RECEIPT_FAMILIES.length ||
    !Array.isArray(blockers)
  ) {
    throw new Error(
      `Session tenancy activation backfill evidence is not settled: ${canonicalJson(
        blockers ?? [],
      )}`,
    );
  }
  const familyRecord = families as Record<string, unknown>;
  const missing = REQUIRED_BACKFILL_RECEIPT_FAMILIES.filter(
    (family) =>
      familyRecord[family] === null ||
      typeof familyRecord[family] !== "object" ||
      (familyRecord[family] as Record<string, unknown>).status !== "completed" ||
      (familyRecord[family] as Record<string, unknown>).blocker !== null,
  );
  if (missing.length > 0) {
    throw new Error(
      `Session tenancy activation backfill evidence is not settled: ${missing
        .map((family) => `family:${family}`)
        .join(", ")}`,
    );
  }
}

export function assertSessionTenancyActivationEvidence(inventory: unknown, parity: unknown): void {
  if (
    inventory === null ||
    typeof inventory !== "object" ||
    numberAt(inventory, ["schemaVersion"]) !== 2
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

export async function assertSessionTenancyApplicationRolesDrained(
  transaction: postgres.TransactionSql,
  roles: readonly string[],
): Promise<void> {
  if (
    roles.length < 1 ||
    roles.length > 16 ||
    new Set(roles).size !== roles.length ||
    roles.some((role) => !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role))
  ) {
    throw new Error("Session tenancy activation application roles are invalid");
  }
  const validRoles = await transaction<{ name: string }[]>`
    select rolname as name from pg_catalog.pg_roles
    where rolname = any(${[...roles]}::text[])
      and rolcanlogin and not rolsuper and not rolbypassrls
  `;
  if (validRoles.length !== roles.length) {
    throw new Error("Session tenancy activation requires exact restricted application login roles");
  }
  // Activity is cached for the transaction; every admission/final check must
  // discard that snapshot so an application reconnect cannot hide behind it.
  await transaction`select pg_catalog.pg_stat_clear_snapshot()`;
  const [activity] = await transaction<{ connected: boolean }[]>`
    select exists (
      select 1 from pg_catalog.pg_stat_activity activity
      where activity.datname = pg_catalog.current_database()
        and activity.usename = any(${[...roles]}::text[])
        and activity.pid <> pg_catalog.pg_backend_pid()
    ) as connected
  `;
  if (activity?.connected !== false) {
    throw new Error(
      "Session tenancy activation requires every application role session to be stopped",
    );
  }
}

export async function activateSessionTenancyTransaction(
  transaction: postgres.TransactionSql,
  options: {
    organizationId: string | null;
    allOrganizations: boolean;
    activatedBy: string;
    roles: string[];
  },
): Promise<unknown> {
  const { organizationId, allOrganizations, activatedBy, roles } = options;
  // SHARE fixes the exact existing population until the receipt
  // coverage check commits. Any failure rolls the entire cutover back.
  if (allOrganizations) await transaction`lock table managed_accounts in share mode`;
  const requiredMigrations = requiredActivationMigrations(allOrganizations);
  const migrations = await transaction<{ name: string }[]>`
    select name from schema_migrations where name = any(${[...requiredMigrations]})
  `;
  const applied = new Set(migrations.map((row) => row.name));
  const missing = requiredMigrations.filter((name) => !applied.has(name));
  if (missing.length > 0) {
    throw new Error(`Session tenancy activation migrations are missing: ${missing.join(", ")}`);
  }
  await assertSessionTenancyApplicationRolesDrained(transaction, roles);
  const organizations = allOrganizations
    ? await transaction<{ id: string }[]>`select id from managed_accounts order by id`
    : [{ id: organizationId! }];
  if (organizations.length === 0) {
    throw new Error(
      "No organizations exist to establish the first session-tenancy activation witness",
    );
  }
  const pending: Array<{
    id: string;
    inventoryDigest: string;
    parityDigest: string;
    backfillEvidence: unknown;
  }> = [];
  let alreadyActivated = 0;
  // Settle every pending org before the first immutable receipt. SQL rechecks
  // these exact evidence digests under its unchanged global drain/source fence.
  for (const { id } of organizations) {
    await transaction`select set_config('opengeni.account_id', ${id}, true)`;
    if (allOrganizations) {
      const [existing] = await transaction<{ activated: boolean }[]>`
        select session_tenancy_product_activated(${id}::uuid, 1) as activated
      `;
      if (existing?.activated) {
        alreadyActivated += 1;
        continue;
      }
    }
    const [inventoryRow] = await transaction<{ report: unknown }[]>`
      select inventory_organization_tenancy(${id}::uuid) as report
    `;
    const [parityRow] = await transaction<{ report: unknown }[]>`
      select check_organization_tenancy_parity(${id}::uuid, 10, 30) as report
    `;
    const [backfillRow] = await transaction<{ report: unknown }[]>`
      select check_tenancy_backfill_activation_evidence(${id}::uuid) as report
    `;
    assertSessionTenancyActivationEvidence(inventoryRow?.report, parityRow?.report);
    assertSessionTenancyBackfillEvidence(backfillRow?.report);
    pending.push({
      id,
      inventoryDigest: digest(inventoryRow?.report),
      parityDigest: digest(parityRow?.report),
      backfillEvidence: backfillRow?.report,
    });
  }
  const activations = [];
  for (const { id, inventoryDigest, parityDigest, backfillEvidence } of pending) {
    await transaction`select set_config('opengeni.account_id', ${id}, true)`;
    await transaction`select pg_catalog.pg_stat_clear_snapshot()`;
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
        ${id}::uuid, ${inventoryDigest}, ${parityDigest}, ${activatedBy.trim()}, ${roles}::text[]
      )
    `;
    if (!activation) throw new Error(`Session tenancy activation returned no receipt for ${id}`);
    activations.push({ ...activation, inventoryDigest, parityDigest, backfillEvidence });
  }
  if (!allOrganizations) {
    await assertSessionTenancyApplicationRolesDrained(transaction, roles);
    return activations[0];
  }
  // Activation is platform readiness, not consent. Preserve every existing
  // preference (including explicit opt-outs) without invoking the enable helper.
  for (const { id } of organizations) {
    await transaction`select set_config('opengeni.account_id', ${id}, true)`;
    const [verified] = await transaction<{ activated: boolean }[]>`
      select session_tenancy_product_activated(${id}::uuid, 1) as activated
    `;
    if (verified?.activated !== true) {
      throw new Error(`Session tenancy activation coverage missing for ${id}`);
    }
  }
  // Source-table locks from every new activation are still held. A live late
  // reconnect aborts this caller's transaction and rolls back all its receipts.
  // The replay-only fleet must prove the same drain even without new receipts.
  await assertSessionTenancyApplicationRolesDrained(transaction, roles);
  return {
    organizationCount: organizations.length,
    alreadyActivated,
    newlyActivated: activations.length,
    activations,
  };
}

async function main(): Promise<void> {
  const { organizationId, allOrganizations } = activationScope(process.argv);
  const activatedBy = argument("--activated-by");
  if (!activatedBy?.trim()) throw new Error("--activated-by <operator> is required");

  const settings = getSettings();
  if (!settings.organizationTenancyCanonicalActivationEnabled) {
    throw new Error("OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED=true is required");
  }
  const databaseUrl = process.env.OPENGENI_MIGRATIONS_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("OPENGENI_MIGRATIONS_DATABASE_URL is required");
  const roles = applicationRoles();
  const searchPath = dbSearchPath(settings);
  const sql = postgres(activationDatabaseUrl(databaseUrl), activationConnectionOptions(searchPath));
  try {
    const result = await sql.begin((transaction) =>
      activateSessionTenancyTransaction(transaction, {
        organizationId,
        allOrganizations,
        activatedBy,
        roles,
      }),
    );
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
