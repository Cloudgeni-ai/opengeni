import {
  OrganizationIntegrationPolicy,
  assertOrganizationIntegrationAllowed,
  type OrganizationConnectorLogin,
} from "@opengeni/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  rawRows,
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceRls,
  type Database,
} from "./database";
import * as schema from "./schema";

/**
 * Organization connectors (docs/design/ownership-and-reach.md, OR-11). An
 * organization owner or admin adds an MCP connector once and chooses which
 * workspaces it reaches; row security serves each workspace exactly the rows
 * that reach it (packages/db/drizzle/1175_organization_connectors.sql).
 *
 * Administration runs without a workspace, as the acting person, and the
 * database checks that person is a live organization owner or admin. Turning
 * one on (adding it, or saving it while active) holds the organization's
 * integration policy fence and must be allowed by that policy, as a
 * workspace's own MCP setup is.
 */
export type OrganizationConnectorRow = typeof schema.organizationConnectors.$inferSelect;
export type {
  OrganizationApiIntegrationDefinition,
  OrganizationMcpServerDefinition,
} from "./schema";

/** An API organization connector's reviewed definition; null for an MCP server. */
export function organizationApiIntegrationDefinition(
  row: Pick<OrganizationConnectorRow, "kind" | "customDefinition">,
): schema.OrganizationApiIntegrationDefinition | null {
  const definition = row.customDefinition;
  return row.kind === "api" && definition && "kind" in definition && definition.kind === "api"
    ? definition
    : null;
}

/** A trusted server callback that has already authenticated the acting person. */
export type AuthorizeOrganizationConnectorAdministration = () => Promise<{
  accountId: string;
  subjectId: string;
}>;

export class OrganizationConnectorWorkspaceNotInOrganizationError extends Error {
  constructor() {
    super("Every selected workspace must be a shared workspace of this organization");
    this.name = "OrganizationConnectorWorkspaceNotInOrganizationError";
  }
}

/** Integration policy key every MCP setup checks; the generic catalog proves no provider identity. */
const MCP_INTEGRATION_KEY = "custom:mcp";

/**
 * The integration policy key a connector is checked against, the same key a
 * workspace setup of it checks: every MCP server is `custom:mcp`; an API
 * integration is its curated definition id, or `custom:<protocol>`.
 */
export function organizationConnectorIntegrationKey(
  row: Pick<OrganizationConnectorRow, "kind" | "customDefinition">,
): string {
  const definition = organizationApiIntegrationDefinition(row);
  if (!definition) return MCP_INTEGRATION_KEY;
  return definition.definitionProvenance === "curated"
    ? definition.definitionId
    : `custom:${definition.protocol}`;
}

/** How turns sign in, read from what the setup stores. */
export function organizationConnectorLogin(
  config: Record<string, unknown>,
): OrganizationConnectorLogin {
  if (config.connectionRef && typeof config.connectionRef === "object") return "each_person";
  const headers = config.headersEncrypted;
  if (headers && typeof headers === "object" && Object.keys(headers).length > 0)
    return "organization_key";
  // An API integration's organization key: header, query or cookie placements.
  if (Array.isArray(config.placementsEncrypted) && config.placementsEncrypted.length > 0)
    return "organization_key";
  return "none";
}

/**
 * The names an organization key is sent under (headers, or an API
 * integration's header, query or cookie names). The encrypted values never
 * leave the database layer through this.
 */
export function organizationConnectorHeaderNames(config: Record<string, unknown>): string[] {
  if (Array.isArray(config.placementsEncrypted))
    return [
      ...new Set(
        config.placementsEncrypted.flatMap((placement) =>
          placement && typeof placement === "object" && typeof placement.name === "string"
            ? [placement.name as string]
            : [],
        ),
      ),
    ].sort();
  const headers = config.headersEncrypted;
  return headers && typeof headers === "object" ? Object.keys(headers).sort() : [];
}

async function withAdministrator<T>(
  db: Database,
  accountId: string,
  authorize: AuthorizeOrganizationConnectorAdministration,
  use: (tx: Database, subjectId: string) => Promise<T>,
): Promise<T> {
  const actor = await authorize();
  if (actor.accountId.toLowerCase() !== accountId.toLowerCase() || !actor.subjectId)
    throw new Error("Organization administrator required");
  return await withRlsContext(
    db,
    { accountId, workspaceId: null },
    async (tx) => {
      const [previous] = await rawRows<{ subject: string | null }>(
        tx,
        sql`select current_setting('opengeni.subject_id', true) as subject`,
      );
      await setSubjectRlsContext(tx, actor.subjectId);
      await tx.execute(
        sql`select opengeni_private.assert_organization_integration_policy_administrator(${accountId}::uuid, ${actor.subjectId})`,
      );
      const result = await use(tx, actor.subjectId);
      // withRlsContext restores account and workspace; restore the subject too.
      await tx.execute(
        sql`select set_config('opengeni.subject_id', ${previous?.subject ?? ""}, true)`,
      );
      return result;
    },
    undefined,
    "none",
  );
}

/**
 * Turning a connector on is an acquisition: hold the shared policy fence (the
 * policy writer takes it exclusively, before membership rows) and check the
 * policy under it.
 */
async function assertPolicyAllowsConnector(
  tx: Database,
  accountId: string,
  integrationKey: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${`organization-integration-policy:${accountId}`}, 0))`,
  );
  const [row] = await rawRows<{ policy: unknown }>(
    tx,
    sql`select jsonb_build_object('mode', mode, 'allowedIntegrationKeys', allowed_integration_keys, 'personalIntegrationSetup', personal_integration_setup, 'revision', revision) as policy from organization_integration_policies where account_id = ${accountId}::uuid`,
  );
  assertOrganizationIntegrationAllowed(
    OrganizationIntegrationPolicy.parse(row?.policy ?? {}),
    integrationKey,
  );
}

async function assertSharedWorkspaces(
  tx: Database,
  accountId: string,
  workspaceIds: readonly string[] | null,
): Promise<void> {
  if (workspaceIds === null || workspaceIds.length === 0) return;
  const rows = await rawRows<{ workspace_id: string }>(
    tx,
    sql`select workspace_id from list_organization_workspace_ids(${accountId}::uuid)`,
  );
  const shared = new Set(rows.map((row) => row.workspace_id.toLowerCase()));
  if (workspaceIds.some((id) => !shared.has(id.toLowerCase())))
    throw new OrganizationConnectorWorkspaceNotInOrganizationError();
}

function uuidArray(values: readonly string[] | null) {
  return values === null
    ? sql`NULL::uuid[]`
    : sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)::uuid)`;
}

/**
 * Checks the acting person is a live organization owner or admin, for work
 * that must not start otherwise (such as contacting a server before saving it).
 */
export async function assertOrganizationConnectorAdministrator(
  db: Database,
  scope: { accountId: string },
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<void> {
  await withAdministrator(db, scope.accountId, authorize, async () => undefined);
}

export async function listOrganizationConnectors(
  db: Database,
  scope: { accountId: string },
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<OrganizationConnectorRow[]> {
  return await withAdministrator(db, scope.accountId, authorize, async (tx) =>
    tx
      .select()
      .from(schema.organizationConnectors)
      .where(eq(schema.organizationConnectors.accountId, scope.accountId))
      .orderBy(asc(schema.organizationConnectors.createdAt), asc(schema.organizationConnectors.id)),
  );
}

export async function getOrganizationConnector(
  db: Database,
  scope: { accountId: string; connectorId: string },
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<OrganizationConnectorRow | null> {
  return await withAdministrator(db, scope.accountId, authorize, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.organizationConnectors)
      .where(
        and(
          eq(schema.organizationConnectors.accountId, scope.accountId),
          eq(schema.organizationConnectors.id, scope.connectorId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export type NewOrganizationConnector = {
  /** Defaults to "mcp". */
  kind?: "mcp" | "api";
  capabilityId: string;
  customDefinition: OrganizationConnectorRow["customDefinition"];
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  allowedWorkspaceIds: string[] | null;
  allowPersonalWorkspaces: boolean;
};

/** Unique per organization and capability: a second add of the same connector is a 23505. */
export async function insertOrganizationConnector(
  db: Database,
  scope: { accountId: string },
  input: NewOrganizationConnector,
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<OrganizationConnectorRow> {
  return await withAdministrator(db, scope.accountId, authorize, async (tx, subjectId) => {
    const kind = input.kind ?? "mcp";
    await assertPolicyAllowsConnector(
      tx,
      scope.accountId,
      organizationConnectorIntegrationKey({ kind, customDefinition: input.customDefinition }),
    );
    await assertSharedWorkspaces(tx, scope.accountId, input.allowedWorkspaceIds);
    const [row] = await tx
      .insert(schema.organizationConnectors)
      .values({
        accountId: scope.accountId,
        kind,
        capabilityId: input.capabilityId,
        customDefinition: input.customDefinition,
        config: input.config,
        metadata: input.metadata,
        status: "active",
        allowedWorkspaceIds: input.allowedWorkspaceIds,
        allowPersonalWorkspaces: input.allowPersonalWorkspaces,
        createdBySubjectId: subjectId,
        updatedBySubjectId: subjectId,
      })
      .returning();
    if (!row) throw new Error("Organization connector was not saved");
    return row;
  });
}

export type OrganizationConnectorChange = {
  expectedGeneration: number;
  allowedWorkspaceIds?: string[] | null;
  allowPersonalWorkspaces?: boolean;
  status?: "active" | "disabled";
  /** The complete new config, built from the row read at `expectedGeneration`. */
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

/** Null when the connector is gone or changed since `expectedGeneration`. */
export async function updateOrganizationConnector(
  db: Database,
  scope: { accountId: string; connectorId: string },
  change: OrganizationConnectorChange,
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<OrganizationConnectorRow | null> {
  return await withAdministrator(db, scope.accountId, authorize, async (tx, subjectId) => {
    const [current] = await tx
      .select({
        status: schema.organizationConnectors.status,
        kind: schema.organizationConnectors.kind,
        customDefinition: schema.organizationConnectors.customDefinition,
      })
      .from(schema.organizationConnectors)
      .where(
        and(
          eq(schema.organizationConnectors.accountId, scope.accountId),
          eq(schema.organizationConnectors.id, scope.connectorId),
        ),
      )
      .limit(1);
    if (!current) return null;
    // Saving a connector that stays (or becomes) active is an acquisition;
    // turning it off never needs the policy.
    if ((change.status ?? current.status) === "active")
      await assertPolicyAllowsConnector(
        tx,
        scope.accountId,
        organizationConnectorIntegrationKey(current),
      );
    if (change.allowedWorkspaceIds !== undefined)
      await assertSharedWorkspaces(tx, scope.accountId, change.allowedWorkspaceIds);
    const [row] = await rawRows<{ id: string }>(
      tx,
      sql`update organization_connectors set
        allowed_workspace_ids = ${change.allowedWorkspaceIds === undefined ? sql`allowed_workspace_ids` : uuidArray(change.allowedWorkspaceIds)},
        allow_personal_workspaces = ${change.allowPersonalWorkspaces === undefined ? sql`allow_personal_workspaces` : sql`${change.allowPersonalWorkspaces}`},
        status = ${change.status === undefined ? sql`status` : sql`${change.status}`},
        config = ${change.config === undefined ? sql`config` : sql`${JSON.stringify(change.config)}::jsonb`},
        metadata = ${change.metadata === undefined ? sql`metadata` : sql`${JSON.stringify(change.metadata)}::jsonb`},
        generation = generation + 1,
        updated_by_subject_id = ${subjectId},
        updated_at = now()
      where account_id = ${scope.accountId}::uuid and id = ${scope.connectorId}::uuid
        and generation = ${change.expectedGeneration}
      returning id`,
    );
    if (!row) return null;
    const [updated] = await tx
      .select()
      .from(schema.organizationConnectors)
      .where(eq(schema.organizationConnectors.id, row.id))
      .limit(1);
    return updated ?? null;
  });
}

/** False when the connector is already gone. Workspaces stop serving it at once. */
export async function deleteOrganizationConnector(
  db: Database,
  scope: { accountId: string; connectorId: string },
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<boolean> {
  return await withAdministrator(db, scope.accountId, authorize, async (tx) => {
    const deleted = await tx
      .delete(schema.organizationConnectors)
      .where(
        and(
          eq(schema.organizationConnectors.accountId, scope.accountId),
          eq(schema.organizationConnectors.id, scope.connectorId),
        ),
      )
      .returning({ id: schema.organizationConnectors.id });
    return deleted.length > 0;
  });
}

/**
 * The active organization connectors of one kind (MCP servers unless asked)
 * that reach `workspaceId`, whatever the workspace's own settings say
 * (callers apply "the workspace's own setup wins"). Row security decides
 * reach; this read only narrows to active rows of that kind.
 */
export async function listOrganizationConnectorsReachingWorkspace(
  db: Database,
  workspaceId: string,
  kind: "mcp" | "api" = "mcp",
): Promise<OrganizationConnectorRow[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
    scopedDb
      .select()
      .from(schema.organizationConnectors)
      .where(
        and(
          eq(schema.organizationConnectors.status, "active"),
          eq(schema.organizationConnectors.kind, kind),
        ),
      )
      .orderBy(asc(schema.organizationConnectors.capabilityId)),
  );
}
