/**
 * Console agents (organization agents, docs/agents.md "Console agents"):
 * management reads and writes for agents, their versions and publishes,
 * organization tool servers, and end users' stored tool logins.
 *
 * Organization agent rows (`agents.scope = 'organization'`) are hidden by a
 * restrictive policy unless the transaction sets `opengeni.org_agents_v1`
 * (migration 1505). Every function here that touches them runs in
 * {@link withOrgAgentsScope}; nothing else in the codebase sets it, so Slack
 * placement, Teams routing and the app's agent lists never see them. That is
 * a visibility rule, not authorization: callers check `agents:read`,
 * `agents:manage`, `tool_credentials:write` or organization administration
 * before calling. Every write records a Console audit row.
 *
 * Secrets (a tool server's shared key and OAuth client secret, end users'
 * logins) are encrypted with the environment-variable key and never returned
 * by the read functions here; only the explicit `read*Secrets` /
 * `decode*` helpers the runtime uses decrypt them.
 */
import { createHash } from "node:crypto";
import {
  canonicalOrgAgentDefinitionJson,
  OrgAgentDefinition,
  OrgAgentToolCatalog,
  OrgAgentVersionConfig,
  ORG_AGENT_CONFIG_MAX_BYTES,
  ORG_AGENTS_PER_ORGANIZATION_MAX,
  ORG_TOOL_SERVERS_PER_ORGANIZATION_MAX,
  type ApplyOrgAgentResponse,
  type ConsoleAuditAction,
  type CreateOrgToolServerRequest,
  type EndUserToolCredential,
  type OrgAgent,
  type OrgAgentDefinitionInput,
  type OrgAgentErrorCode,
  type OrgAgentManagedBy,
  type OrgAgentPublishOperation,
  type OrgAgentSessionEntry,
  type OrgAgentSessionOverrides,
  type OrgAgentSummary,
  type OrgAgentToolCatalog as OrgAgentToolCatalogValue,
  type OrgAgentVersion,
  type OrgAgentVersionSource,
  type OrgAgentUsageResponse,
  type OrgToolServer,
  type OrgToolServerAuthMode,
  type PutEndUserToolCredentialRequest,
  type UpdateOrgToolServerRequest,
  type WorkspaceOrgAgent,
} from "@opengeni/contracts";
import { sql, type SQL } from "drizzle-orm";
import {
  CONSOLE_MAX_WORKSPACE_READS,
  CONSOLE_REVIEWABLE_SESSION_SQL,
  consoleSessionSpendSql,
  decodeConsoleSessionCursor,
  encodeConsoleCursor,
  insertConsoleAuditEvent,
  readConsoleEndUsers,
} from "./console";
import {
  rawRows,
  withAccountRls,
  withoutSessionRlsActor,
  withRlsContext,
  type Database,
} from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import { orgAgentRunsOnProblem, resolveOrgAgentRunsOn } from "./organization-agent-compute";
import { nestedPostgresSqlState } from "./persistence-errors";

// ---------------------------------------------------------------------------
// Errors, actors, scope

export type OrgAgentErrorStatus = 403 | 404 | 409 | 422 | 429 | 503;

/** A refusal the API renders with `details.code` = {@link code}. */
export class OrgAgentError extends Error {
  readonly name = "OrgAgentError";
  constructor(
    readonly status: OrgAgentErrorStatus,
    readonly code: OrgAgentErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A secret must be stored but no encryption key is configured. */
export class OrgAgentEncryptionUnavailableError extends Error {
  readonly name = "OrgAgentEncryptionUnavailableError";
  constructor() {
    super("Storing tool logins needs OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY on this server.");
  }
}

/** Who made a change, for the Console audit log (`api_key:<id>` for keys). */
export type OrgAgentActor = { subjectId: string; label: string | null };

function notFound(): OrgAgentError {
  return new OrgAgentError(404, "agent_not_found", "Agent not found.");
}

function versionConflict(currentVersion: number): OrgAgentError {
  return new OrgAgentError(
    409,
    "agent_version_conflict",
    "The agent changed since you loaded it. Reload and try again.",
    { currentVersion },
  );
}

/**
 * Makes organization agent rows visible for the rest of the current
 * transaction (or savepoint) and returns the previous setting for
 * {@link restoreOrgAgentsVisibility}. For callers that already hold a scoped
 * transaction, such as the turn worker.
 */
export async function enableOrgAgentsVisibility(tx: Database): Promise<string> {
  const [row] = await rawRows<{ previous: string | null }>(
    tx,
    sql`with previous as materialized (
        select current_setting('opengeni.org_agents_v1', true) as value)
      select previous.value as previous, set_config('opengeni.org_agents_v1', '1', true) as applied
      from previous`,
  );
  return row?.previous ?? "";
}

export async function restoreOrgAgentsVisibility(tx: Database, previous: string): Promise<void> {
  if (previous === "1") return;
  await tx.execute(sql`select set_config('opengeni.org_agents_v1', ${previous}, true)`);
}

/**
 * Runs `fn` in the organization's RLS scope (or one of its workspaces) with
 * organization agent rows visible. Nested calls restore the previous setting
 * when they return, as the RLS scope itself does.
 */
export async function withOrgAgentsScope<T>(
  db: Database,
  scope: { accountId: string; workspaceId?: string | null },
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: scope.accountId, workspaceId: scope.workspaceId ?? null },
    async (tx) => {
      const previous = await enableOrgAgentsVisibility(tx);
      const value = await fn(tx);
      await restoreOrgAgentsVisibility(tx, previous);
      return value;
    },
  );
}

/** `sha256:` + hex sha256 of the canonical definition JSON. */
export function orgAgentConfigHash(definition: OrgAgentDefinitionInput): string {
  return `sha256:${createHash("sha256").update(canonicalOrgAgentDefinitionJson(definition)).digest("hex")}`;
}

async function audit(
  tx: Database,
  input: {
    accountId: string;
    actor: OrgAgentActor;
    action: ConsoleAuditAction;
    workspaceId?: string | null;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await insertConsoleAuditEvent(tx, {
    accountId: input.accountId,
    actorSubjectId: input.actor.subjectId,
    actorLabel: input.actor.label,
    action: input.action,
    workspaceId: input.workspaceId ?? null,
    sessionId: null,
    detail: input.detail,
  });
}

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A PostgreSQL array literal for a bound text[]/uuid[] parameter. */
function pgArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`).join(",")}}`;
}

async function lockKey(tx: Database, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// ---------------------------------------------------------------------------
// Agent rows and versions

type AgentRow = {
  id: string;
  agent_key: string;
  name: string;
  description: string;
  managed_by: OrgAgentManagedBy;
  published_revision: number | null;
  current_revision: number;
  version: number;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const AGENT_COLUMNS = sql.raw(`a.id::text as id, a.agent_key, a.name, a.description, a.managed_by,
  a.published_revision, a.current_revision, a.version, a.archived_at, a.created_at, a.updated_at`);

type RevisionRow = {
  revision: number;
  name: string;
  description: string;
  instructions: string;
  config: unknown;
  tool_catalog: unknown;
  source: OrgAgentVersionSource;
  config_hash: string;
  created_by_subject_id: string | null;
  created_at: Date | string;
  published_at: Date | string | null;
};

const REVISION_COLUMNS = sql.raw(`r.revision, r.name, r.description, r.instructions, r.config,
  r.tool_catalog, r.source, r.config_hash, r.created_by_subject_id, r.created_at,
  (select max(op.created_at) from agent_publish_operations op
    where op.account_id = r.account_id and op.agent_id = r.agent_id
      and op.to_revision = r.revision) as published_at`);

function mapSummary(row: AgentRow): OrgAgentSummary {
  return {
    id: row.id,
    key: row.agent_key,
    name: row.name,
    description: row.description,
    managedBy: row.managed_by,
    publishedVersion: row.published_revision,
    latestVersion: row.current_revision,
    rowVersion: row.version,
    archivedAt: isoOrNull(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapVersion(row: RevisionRow): OrgAgentVersion {
  const config = OrgAgentVersionConfig.safeParse(row.config ?? {});
  const catalog =
    row.tool_catalog === null ? null : OrgAgentToolCatalog.safeParse(row.tool_catalog);
  return {
    version: row.revision,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    // A stored config always parsed when it was saved; a newer release's
    // fields are kept as stored rather than failing the read.
    config: config.success ? config.data : (row.config as OrgAgentVersion["config"]),
    toolCatalog: catalog === null ? null : catalog.success ? catalog.data : null,
    source: row.source,
    configHash: row.config_hash,
    createdBySubjectId: row.created_by_subject_id,
    createdAt: iso(row.created_at),
    publishedAt: isoOrNull(row.published_at),
  };
}

async function selectAgentRow(
  tx: Database,
  accountId: string,
  ref: { id: string } | { key: string },
  options: { forUpdate?: boolean } = {},
): Promise<AgentRow | null> {
  const [row] = await rawRows<AgentRow>(
    tx,
    sql`select ${AGENT_COLUMNS} from agents a
      where a.account_id = ${accountId}::uuid and a.scope = 'organization'
        and ${"id" in ref ? sql`a.id = ${ref.id}::uuid` : sql`a.agent_key = ${ref.key}`}
      ${options.forUpdate ? sql`for update` : sql``}`,
  );
  return row ?? null;
}

async function selectRevision(
  tx: Database,
  accountId: string,
  agentId: string,
  revision: number,
): Promise<OrgAgentVersion | null> {
  const [row] = await rawRows<RevisionRow>(
    tx,
    sql`select ${REVISION_COLUMNS} from agent_revisions r
      where r.account_id = ${accountId}::uuid and r.agent_id = ${agentId}::uuid
        and r.workspace_id is null and r.revision = ${revision}`,
  );
  return row ? mapVersion(row) : null;
}

async function loadAgent(tx: Database, accountId: string, row: AgentRow): Promise<OrgAgent> {
  const published =
    row.published_revision === null
      ? null
      : await selectRevision(tx, accountId, row.id, row.published_revision);
  const draft =
    row.published_revision === null || row.current_revision > row.published_revision
      ? await selectRevision(tx, accountId, row.id, row.current_revision)
      : null;
  const access = await rawRows<{ workspace_id: string }>(
    tx,
    sql`select workspace_id::text as workspace_id from agent_workspace_access
      where account_id = ${accountId}::uuid and agent_id = ${row.id}::uuid
      order by workspace_id`,
  );
  return {
    ...mapSummary(row),
    published,
    draft,
    workspaceIds: access.map((entry) => entry.workspace_id),
  };
}

/** Locks the agent row for a write; archived agents are not found. */
async function lockLiveAgent(
  tx: Database,
  accountId: string,
  agentId: string,
  expectedVersion: number | undefined,
): Promise<AgentRow> {
  const row = await selectAgentRow(tx, accountId, { id: agentId }, { forUpdate: true });
  if (!row || row.archived_at !== null) throw notFound();
  if (expectedVersion !== undefined && expectedVersion !== row.version) {
    throw versionConflict(row.version);
  }
  return row;
}

async function bumpAgent(
  tx: Database,
  accountId: string,
  agentId: string,
  set: SQL | null,
): Promise<void> {
  await tx.execute(sql`update agents set ${set ? sql`${set}, ` : sql``}version = version + 1, updated_at = now()
    where account_id = ${accountId}::uuid and id = ${agentId}::uuid and scope = 'organization'`);
}

export async function listOrgAgents(
  db: Database,
  accountId: string,
  options: { includeArchived?: boolean } = {},
): Promise<OrgAgentSummary[]> {
  const rows = await withOrgAgentsScope(db, { accountId }, (tx) =>
    rawRows<AgentRow>(
      tx,
      sql`select ${AGENT_COLUMNS} from agents a
        where a.account_id = ${accountId}::uuid and a.scope = 'organization'
          ${options.includeArchived ? sql`` : sql`and a.archived_at is null`}
        order by lower(a.name), a.agent_key`,
    ),
  );
  return rows.map(mapSummary);
}

export async function getOrgAgent(
  db: Database,
  accountId: string,
  ref: { id: string } | { key: string },
  options: { includeArchived?: boolean } = {},
): Promise<OrgAgent | null> {
  return await withOrgAgentsScope(db, { accountId }, async (tx) => {
    const row = await selectAgentRow(tx, accountId, ref);
    if (!row || (row.archived_at !== null && !options.includeArchived)) return null;
    return await loadAgent(tx, accountId, row);
  });
}

export async function listOrgAgentVersions(
  db: Database,
  accountId: string,
  agentId: string,
): Promise<OrgAgentVersion[] | null> {
  return await withOrgAgentsScope(db, { accountId }, async (tx) => {
    const agent = await selectAgentRow(tx, accountId, { id: agentId });
    if (!agent) return null;
    const rows = await rawRows<RevisionRow>(
      tx,
      sql`select ${REVISION_COLUMNS} from agent_revisions r
        where r.account_id = ${accountId}::uuid and r.agent_id = ${agentId}::uuid
          and r.workspace_id is null
        order by r.revision desc`,
    );
    return rows.map(mapVersion);
  });
}

/** One version, or null when the agent or version does not exist. */
export async function getOrgAgentVersion(
  db: Database,
  accountId: string,
  agentId: string,
  version: number,
): Promise<OrgAgentVersion | null> {
  return await withOrgAgentsScope(db, { accountId }, async (tx) => {
    const agent = await selectAgentRow(tx, accountId, { id: agentId });
    if (!agent) return null;
    return await selectRevision(tx, accountId, agentId, version);
  });
}

// ---------------------------------------------------------------------------
// Validation shared by writes

/**
 * Refuses what a version cannot reference: unknown tool server keys, and a
 * Runs on machine or sandbox environment that is not this organization's
 * (Personal and workspace machines included).
 */
async function assertDefinitionReferences(
  tx: Database,
  accountId: string,
  definition: OrgAgentDefinition,
): Promise<void> {
  await assertToolServersExist(tx, accountId, definition);
  const problem = await orgAgentRunsOnProblem(tx, accountId, definition.config.runsOn);
  if (problem) throw new OrgAgentError(422, problem.code, problem.message);
}

/** Refuses tool server keys this organization does not have (422, `details.missing`). */
async function assertToolServersExist(
  tx: Database,
  accountId: string,
  definition: OrgAgentDefinition,
): Promise<void> {
  const keys = [...new Set(definition.config.toolServers.map((server) => server.server))];
  if (keys.length === 0) return;
  const rows = await rawRows<{ server_key: string }>(
    tx,
    sql`select server_key from organization_tool_servers
      where account_id = ${accountId}::uuid and server_key = any(${pgArray(keys)}::text[])`,
  );
  const known = new Set(rows.map((row) => row.server_key));
  const missing = keys.filter((key) => !known.has(key));
  if (missing.length > 0) {
    throw new OrgAgentError(
      422,
      "tool_server_not_found",
      `This organization has no tool server ${missing.map((key) => `'${key}'`).join(", ")}.`,
      { missing },
    );
  }
}

function assertConfigSize(definition: OrgAgentDefinition): void {
  if (Buffer.byteLength(JSON.stringify(definition.config)) > ORG_AGENT_CONFIG_MAX_BYTES) {
    throw new OrgAgentError(
      422,
      "agent_config_too_large",
      `An agent version's settings can be at most ${ORG_AGENT_CONFIG_MAX_BYTES} bytes.`,
    );
  }
}

/** The organization's shared workspaces among `workspaceIds`; refuses any other id. */
async function assertOrganizationWorkspaces(
  tx: Database,
  accountId: string,
  workspaceIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(workspaceIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return [];
  const rows = await rawRows<{ id: string }>(
    tx,
    sql`select w.id::text as id from workspaces w
      where w.account_id = ${accountId}::uuid and w.id = any(${pgArray(ids)}::uuid[])
        and w.id in (select workspace_id from list_organization_workspace_ids(${accountId}::uuid))`,
  );
  const known = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new OrgAgentError(
      422,
      "workspace_not_found",
      "An agent can be made available only in this organization's shared workspaces.",
      { missing },
    );
  }
  return ids;
}

function parseDefinition(input: OrgAgentDefinitionInput): OrgAgentDefinition {
  return OrgAgentDefinition.parse(input);
}

async function insertRevision(
  tx: Database,
  input: {
    accountId: string;
    agentId: string;
    revision: number;
    definition: OrgAgentDefinition;
    configHash: string;
    toolCatalog: OrgAgentToolCatalogValue | null;
    source: OrgAgentVersionSource;
    createdBySubjectId: string;
  },
): Promise<void> {
  // The machine or environment `runsOn` names now, saved by id with the version
  // (callers checked it already; an unresolved name stays null).
  const resolved = await resolveOrgAgentRunsOn(tx, input.accountId, input.definition.config.runsOn);
  const runsOnTarget = "target" in resolved ? resolved.target : null;
  await tx.execute(sql`insert into agent_revisions (agent_id, account_id, workspace_id, revision,
      name, description, instructions, created_by_subject_id, config, tool_catalog, source, config_hash,
      runs_on_target)
    values (${input.agentId}::uuid, ${input.accountId}::uuid, null, ${input.revision},
      ${input.definition.name}, ${input.definition.description}, ${input.definition.instructions},
      ${input.createdBySubjectId.slice(0, 1024)}, ${JSON.stringify(input.definition.config)}::jsonb,
      ${input.toolCatalog === null ? null : JSON.stringify(input.toolCatalog)}::jsonb,
      ${input.source}, ${input.configHash},
      ${runsOnTarget === null ? null : JSON.stringify(runsOnTarget)}::jsonb)`);
}

async function revisionWithHash(
  tx: Database,
  accountId: string,
  agentId: string,
  configHash: string,
): Promise<number | null> {
  const [row] = await rawRows<{ revision: number }>(
    tx,
    sql`select revision from agent_revisions
      where account_id = ${accountId}::uuid and agent_id = ${agentId}::uuid
        and workspace_id is null and config_hash = ${configHash}`,
  );
  return row?.revision ?? null;
}

// ---------------------------------------------------------------------------
// Create, update, drafts

type CreateInput = {
  accountId: string;
  actor: OrgAgentActor;
  key: string;
  definition: OrgAgentDefinitionInput;
  workspaceIds?: readonly string[];
  toolCatalog?: OrgAgentToolCatalogValue | null;
};

async function insertAgent(
  tx: Database,
  input: CreateInput & { managedBy: OrgAgentManagedBy; source: OrgAgentVersionSource },
): Promise<{ row: AgentRow; configHash: string }> {
  const definition = parseDefinition(input.definition);
  assertConfigSize(definition);
  // The per-key lock first (re-entrant for apply, which already holds it),
  // then the organization lock: the order apply and inline saves use, so a
  // Console create, a deploy and an inline save of one key serialize.
  await lockKey(tx, `org-agent-key:${input.accountId}:${input.key}`);
  await lockKey(tx, `org-agents:${input.accountId}`);
  if (await selectAgentRow(tx, input.accountId, { key: input.key })) {
    throw new OrgAgentError(
      409,
      "agent_key_taken",
      `An agent with key '${input.key}' already exists.`,
    );
  }
  const [count] = await rawRows<{ count: number }>(
    tx,
    sql`select count(*)::int as count from agents
      where account_id = ${input.accountId}::uuid and scope = 'organization'`,
  );
  if (num(count?.count) >= ORG_AGENTS_PER_ORGANIZATION_MAX) {
    throw new OrgAgentError(
      429,
      "organization_agent_limit_reached",
      `An organization keeps at most ${ORG_AGENTS_PER_ORGANIZATION_MAX} agents.`,
    );
  }
  await assertDefinitionReferences(tx, input.accountId, definition);
  const workspaceIds = await assertOrganizationWorkspaces(
    tx,
    input.accountId,
    input.workspaceIds ?? [],
  );
  const configHash = orgAgentConfigHash(definition);
  let row: AgentRow | undefined;
  try {
    [row] = await rawRows<AgentRow>(
      tx,
      sql`insert into agents as a (account_id, workspace_id, scope, agent_key, visibility,
          owner_subject_id, name, name_key, description, origin, current_revision, managed_by,
          created_by_subject_id)
        values (${input.accountId}::uuid, null, 'organization', ${input.key}, 'workspace', null,
          ${definition.name}, lower(btrim(${definition.name})), ${definition.description}, 'app', 1,
          ${input.managedBy}, ${input.actor.subjectId.slice(0, 1024)})
        returning ${AGENT_COLUMNS}`,
    );
  } catch (error) {
    if (nestedPostgresSqlState(error) === "23505") {
      throw new OrgAgentError(
        409,
        "agent_key_taken",
        `An agent with key '${input.key}' already exists.`,
      );
    }
    throw error;
  }
  if (!row) throw new Error("Organization agent insert returned no row");
  await insertRevision(tx, {
    accountId: input.accountId,
    agentId: row.id,
    revision: 1,
    definition,
    configHash,
    toolCatalog: input.toolCatalog ?? null,
    source: input.source,
    createdBySubjectId: input.actor.subjectId,
  });
  for (const workspaceId of workspaceIds) {
    await tx.execute(sql`insert into agent_workspace_access
        (agent_id, account_id, workspace_id, enabled_by_subject_id)
      values (${row.id}::uuid, ${input.accountId}::uuid, ${workspaceId}::uuid,
        ${input.actor.subjectId.slice(0, 1024)})`);
  }
  return { row, configHash };
}

/** Creates a Console agent with an unpublished version 1. */
export async function createOrgAgent(db: Database, input: CreateInput): Promise<OrgAgent> {
  return await withOrgAgentsScope(db, { accountId: input.accountId }, async (tx) => {
    const { row, configHash } = await insertAgent(tx, {
      ...input,
      managedBy: "console",
      source: "console",
    });
    await audit(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: "agent.created",
      detail: { agentId: row.id, key: row.agent_key, name: row.name, version: 1, configHash },
    });
    return await loadAgent(tx, input.accountId, row);
  });
}

/** Sets where the agent is available besides the organization's managed workspaces. */
export async function updateOrgAgent(
  db: Database,
  input: {
    accountId: string;
    agentId: string;
    actor: OrgAgentActor;
    expectedVersion: number;
    workspaceIds?: readonly string[];
    /**
     * Workspaces the caller cannot see (an organization key limited to some
     * workspaces): their access rows are kept as they are, and `workspaceIds`
     * replaces only the rest. Omitted, `workspaceIds` replaces the whole list.
     */
    keepWorkspace?: (workspaceId: string) => boolean;
  },
): Promise<OrgAgent> {
  return await withOrgAgentsScope(db, { accountId: input.accountId }, async (tx) => {
    await lockLiveAgent(tx, input.accountId, input.agentId, input.expectedVersion);
    const detail: Record<string, unknown> = { agentId: input.agentId };
    if (input.workspaceIds !== undefined) {
      const next = await assertOrganizationWorkspaces(tx, input.accountId, input.workspaceIds);
      const current = (
        await rawRows<{ workspace_id: string }>(
          tx,
          sql`select workspace_id::text as workspace_id from agent_workspace_access
            where account_id = ${input.accountId}::uuid and agent_id = ${input.agentId}::uuid`,
        )
      ).map((row) => row.workspace_id);
      const removed = current.filter(
        (id) => !next.includes(id) && !(input.keepWorkspace?.(id) ?? false),
      );
      const added = next.filter((id) => !current.includes(id));
      if (removed.length > 0) {
        await tx.execute(sql`delete from agent_workspace_access
          where account_id = ${input.accountId}::uuid and agent_id = ${input.agentId}::uuid
            and workspace_id = any(${pgArray(removed)}::uuid[])`);
      }
      for (const workspaceId of added) {
        await tx.execute(sql`insert into agent_workspace_access
            (agent_id, account_id, workspace_id, enabled_by_subject_id)
          values (${input.agentId}::uuid, ${input.accountId}::uuid, ${workspaceId}::uuid,
            ${input.actor.subjectId.slice(0, 1024)})
          on conflict do nothing`);
      }
      detail.workspacesAdded = added;
      detail.workspacesRemoved = removed;
    }
    await bumpAgent(tx, input.accountId, input.agentId, null);
    await audit(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: "agent.updated",
      detail,
    });
    const row = await selectAgentRow(tx, input.accountId, { id: input.agentId });
    return await loadAgent(tx, input.accountId, row!);
  });
}

/**
 * Saves a new version of a Console agent (the newest, unpublished until a
 * publish). A definition whose config hash equals an existing version saves
 * nothing and returns that version (`created: false`).
 */
export async function saveOrgAgentDraft(
  db: Database,
  input: {
    accountId: string;
    agentId: string;
    actor: OrgAgentActor;
    expectedVersion: number;
    definition: OrgAgentDefinitionInput;
    toolCatalog?: OrgAgentToolCatalogValue | null;
  },
): Promise<{ agent: OrgAgent; version: OrgAgentVersion; created: boolean }> {
  const definition = parseDefinition(input.definition);
  assertConfigSize(definition);
  const configHash = orgAgentConfigHash(definition);
  return await withOrgAgentsScope(db, { accountId: input.accountId }, async (tx) => {
    const row = await lockLiveAgent(tx, input.accountId, input.agentId, input.expectedVersion);
    if (row.managed_by === "code") {
      throw new OrgAgentError(
        409,
        "agent_managed_by_code",
        "This agent is managed by code. Deploy a change, or switch it to Console.",
      );
    }
    const existing = await revisionWithHash(tx, input.accountId, input.agentId, configHash);
    if (existing !== null) {
      return {
        agent: await loadAgent(tx, input.accountId, row),
        version: (await selectRevision(tx, input.accountId, input.agentId, existing))!,
        created: false,
      };
    }
    await assertDefinitionReferences(tx, input.accountId, definition);
    const revision = row.current_revision + 1;
    await insertRevision(tx, {
      accountId: input.accountId,
      agentId: input.agentId,
      revision,
      definition,
      configHash,
      toolCatalog: input.toolCatalog ?? null,
      source: "console",
      createdBySubjectId: input.actor.subjectId,
    });
    await bumpAgent(
      tx,
      input.accountId,
      input.agentId,
      sql`current_revision = ${revision}, name = ${definition.name},
        name_key = lower(btrim(${definition.name})), description = ${definition.description}`,
    );
    await audit(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: "agent.version_saved",
      detail: { agentId: input.agentId, key: row.agent_key, version: revision, configHash },
    });
    const updated = await selectAgentRow(tx, input.accountId, { id: input.agentId });
    return {
      agent: await loadAgent(tx, input.accountId, updated!),
      version: (await selectRevision(tx, input.accountId, input.agentId, revision))!,
      created: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Publish

type OperationRow = {
  id: string;
  agent_id: string;
  from_revision: number | null;
  to_revision: number;
  move_running_chats: boolean;
  status: OrgAgentPublishOperation["status"];
  moved_count: number;
  failed_count: number;
  failure_reason: string | null;
  created_by_subject_id: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
};

const OPERATION_COLUMNS = sql.raw(`id::text as id, agent_id::text as agent_id, from_revision,
  to_revision, move_running_chats, status, moved_count, failed_count, failure_reason,
  created_by_subject_id, created_at, finished_at`);

function mapOperation(row: OperationRow): OrgAgentPublishOperation {
  return {
    id: row.id,
    agentId: row.agent_id,
    fromVersion: row.from_revision,
    toVersion: row.to_revision,
    moveRunningChats: row.move_running_chats,
    status: row.status,
    movedCount: num(row.moved_count),
    failedCount: num(row.failed_count),
    failureReason: row.failure_reason,
    createdBySubjectId: row.created_by_subject_id,
    createdAt: iso(row.created_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

async function publishLocked(
  tx: Database,
  input: {
    accountId: string;
    row: AgentRow;
    actor: OrgAgentActor;
    version: number;
    moveRunningChats: boolean;
  },
): Promise<OrgAgentPublishOperation> {
  if (!(await selectRevision(tx, input.accountId, input.row.id, input.version))) {
    throw new OrgAgentError(
      404,
      "agent_version_not_found",
      `Version ${input.version} does not exist.`,
    );
  }
  await bumpAgent(tx, input.accountId, input.row.id, sql`published_revision = ${input.version}`);
  // An earlier move that never started (the API stopped before starting it)
  // will not run now: this publish decides the version. Publishes of one
  // agent are serialized by its row lock.
  await tx.execute(sql`update agent_publish_operations
    set status = 'failed', failure_reason = 'superseded', finished_at = now()
    where account_id = ${input.accountId}::uuid and agent_id = ${input.row.id}::uuid
      and status = 'pending'`);
  const [operation] = await rawRows<OperationRow>(
    tx,
    sql`insert into agent_publish_operations (account_id, agent_id, from_revision, to_revision,
        move_running_chats, status, created_by_subject_id, finished_at)
      values (${input.accountId}::uuid, ${input.row.id}::uuid, ${input.row.published_revision},
        ${input.version}, ${input.moveRunningChats},
        ${input.moveRunningChats ? "pending" : "succeeded"}, ${input.actor.subjectId.slice(0, 1024)},
        ${input.moveRunningChats ? null : sql`now()`})
      returning ${OPERATION_COLUMNS}`,
  );
  await audit(tx, {
    accountId: input.accountId,
    actor: input.actor,
    action: "agent.published",
    detail: {
      agentId: input.row.id,
      key: input.row.agent_key,
      fromVersion: input.row.published_revision,
      toVersion: input.version,
      rollback:
        input.row.published_revision !== null && input.version < input.row.published_revision,
      moveRunningChats: input.moveRunningChats,
      operationId: operation!.id,
    },
  });
  return mapOperation(operation!);
}

/**
 * Publishes a version (an older one is a rollback). Without
 * `moveRunningChats` the operation succeeds at once; with it the operation is
 * `pending` until the move workflow runs it.
 */
export async function publishOrgAgent(
  db: Database,
  input: {
    accountId: string;
    agentId: string;
    actor: OrgAgentActor;
    version: number;
    moveRunningChats: boolean;
    expectedVersion: number;
  },
): Promise<{ agent: OrgAgent; operation: OrgAgentPublishOperation }> {
  return await withOrgAgentsScope(db, { accountId: input.accountId }, async (tx) => {
    const row = await lockLiveAgent(tx, input.accountId, input.agentId, input.expectedVersion);
    if (row.managed_by === "code") {
      throw new OrgAgentError(
        409,
        "agent_managed_by_code",
        "This agent is managed by code. Publish it with a deploy, or switch it to Console.",
      );
    }
    const operation = await publishLocked(tx, { ...input, row });
    const updated = await selectAgentRow(tx, input.accountId, { id: input.agentId });
    return { agent: await loadAgent(tx, input.accountId, updated!), operation };
  });
}

export async function listOrgAgentPublishOperations(
  db: Database,
  accountId: string,
  agentId: string,
  limit = 50,
): Promise<OrgAgentPublishOperation[] | null> {
  return await withOrgAgentsScope(db, { accountId }, async (tx) => {
    if (!(await selectAgentRow(tx, accountId, { id: agentId }))) return null;
    const rows = await rawRows<OperationRow>(
      tx,
      sql`select ${OPERATION_COLUMNS} from agent_publish_operations
        where account_id = ${accountId}::uuid and agent_id = ${agentId}::uuid
        order by created_at desc, id desc limit ${Math.max(1, Math.min(limit, 200))}`,
    );
    return rows.map(mapOperation);
  });
}

export type OrgAgentPublishMoveFailure = "move_unavailable" | "move_start_failed";

/**
 * A `moveRunningChats` operation whose move could not start: marked `failed`
 * with the reason, unless the move already began. Returns the operation as it
 * is now (null when it is gone). The version stays published.
 */
export async function failPendingOrgAgentPublishOperation(
  db: Database,
  input: { accountId: string; operationId: string; reason: OrgAgentPublishMoveFailure },
): Promise<OrgAgentPublishOperation | null> {
  return await withOrgAgentsScope(db, { accountId: input.accountId }, async (tx) => {
    await tx.execute(sql`update agent_publish_operations
      set status = 'failed', failure_reason = ${input.reason}, finished_at = now()
      where account_id = ${input.accountId}::uuid and id = ${input.operationId}::uuid
        and status = 'pending'`);
    const [row] = await rawRows<OperationRow>(
      tx,
      sql`select ${OPERATION_COLUMNS} from agent_publish_operations
        where account_id = ${input.accountId}::uuid and id = ${input.operationId}::uuid`,
    );
    return row ? mapOperation(row) : null;
  });
}

// ---------------------------------------------------------------------------
// Code deploys (apply by key)

/**
 * The code deploy: creates a code-managed agent for an unknown key, saves a
 * version unless one with the same config hash exists (that version is
 * reused), and publishes it when asked. `dryRun` reports the same outcome
 * without writing. A Console-managed agent is refused (409
 * `agent_managed_in_console`). Applying to an archived code agent restores it.
 */
export async function applyOrgAgent(
  db: Database,
  input: {
    accountId: string;
    key: string;
    actor: OrgAgentActor;
    definition: OrgAgentDefinitionInput;
    publish: boolean;
    moveRunningChats: boolean;
    dryRun: boolean;
    expectedVersion?: number | undefined;
    toolCatalog?: OrgAgentToolCatalogValue | null;
  },
): Promise<ApplyOrgAgentResponse> {
  const definition = parseDefinition(input.definition);
  assertConfigSize(definition);
  const configHash = orgAgentConfigHash(definition);
  return await withOrgAgentsScope(db, { accountId: input.accountId }, async (tx) => {
    await lockKey(tx, `org-agent-key:${input.accountId}:${input.key}`);
    const existing = await selectAgentRow(
      tx,
      input.accountId,
      { key: input.key },
      { forUpdate: true },
    );
    if (!existing) {
      await assertDefinitionReferences(tx, input.accountId, definition);
      if (input.expectedVersion !== undefined) throw notFound();
      if (input.dryRun) {
        return {
          outcome: "created",
          dryRun: true,
          configHash,
          version: 1,
          published: input.publish,
          agent: null,
          operation: null,
        };
      }
      const { row } = await insertAgent(tx, {
        accountId: input.accountId,
        actor: input.actor,
        key: input.key,
        definition,
        toolCatalog: input.toolCatalog ?? null,
        managedBy: "code",
        source: "deploy",
      });
      const operation = input.publish
        ? await publishLocked(tx, {
            accountId: input.accountId,
            row,
            actor: input.actor,
            version: 1,
            moveRunningChats: input.moveRunningChats,
          })
        : null;
      await audit(tx, {
        accountId: input.accountId,
        actor: input.actor,
        action: "agent.deployed",
        detail: { agentId: row.id, key: input.key, outcome: "created", version: 1, configHash },
      });
      const created = await selectAgentRow(tx, input.accountId, { id: row.id });
      return {
        outcome: "created",
        dryRun: false,
        configHash,
        version: 1,
        published: operation !== null,
        agent: await loadAgent(tx, input.accountId, created!),
        operation,
      };
    }
    if (existing.managed_by === "console") {
      throw new OrgAgentError(
        409,
        "agent_managed_in_console",
        `Agent '${input.key}' is edited in Console. An owner can switch it to code first.`,
      );
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw versionConflict(existing.version);
    }
    const reused = await revisionWithHash(tx, input.accountId, existing.id, configHash);
    if (reused === null) await assertDefinitionReferences(tx, input.accountId, definition);
    const version = reused ?? existing.current_revision + 1;
    const outcome: ApplyOrgAgentResponse["outcome"] = reused === null ? "updated" : "unchanged";
    const needsPublish = input.publish && existing.published_revision !== version;
    if (input.dryRun) {
      return {
        outcome,
        dryRun: true,
        configHash,
        version,
        published: input.publish || existing.published_revision === version,
        agent: await loadAgent(tx, input.accountId, existing),
        operation: null,
      };
    }
    if (reused === null) {
      await insertRevision(tx, {
        accountId: input.accountId,
        agentId: existing.id,
        revision: version,
        definition,
        configHash,
        toolCatalog: input.toolCatalog ?? null,
        source: "deploy",
        createdBySubjectId: input.actor.subjectId,
      });
      await bumpAgent(
        tx,
        input.accountId,
        existing.id,
        sql`current_revision = ${version}, name = ${definition.name},
          name_key = lower(btrim(${definition.name})), description = ${definition.description},
          archived_at = null`,
      );
    } else if (existing.archived_at !== null) {
      await bumpAgent(tx, input.accountId, existing.id, sql`archived_at = null`);
    }
    let operation: OrgAgentPublishOperation | null = null;
    if (needsPublish) {
      const locked = await selectAgentRow(tx, input.accountId, { id: existing.id });
      operation = await publishLocked(tx, {
        accountId: input.accountId,
        row: locked!,
        actor: input.actor,
        version,
        moveRunningChats: input.moveRunningChats,
      });
    }
    if (reused === null || operation !== null || existing.archived_at !== null) {
      await audit(tx, {
        accountId: input.accountId,
        actor: input.actor,
        action: "agent.deployed",
        detail: { agentId: existing.id, key: input.key, outcome, version, configHash },
      });
    }
    const updated = await selectAgentRow(tx, input.accountId, { id: existing.id });
    return {
      outcome,
      dryRun: false,
      configHash,
      version,
      published: updated!.published_revision === version,
      agent: await loadAgent(tx, input.accountId, updated!),
      operation,
    };
  });
}

// ---------------------------------------------------------------------------
// Management, archive

/** Moves an agent between Console and code management. Callers check ownership. */
export async function setOrgAgentManagement(
  db: Database,
  input: {
    accountId: string;
    agentId: string;
    actor: OrgAgentActor;
    managedBy: OrgAgentManagedBy;
    expectedVersion: number;
  },
): Promise<OrgAgent> {
  return await withOrgAgentsScope(db, { accountId: input.accountId }, async (tx) => {
    const row = await lockLiveAgent(tx, input.accountId, input.agentId, input.expectedVersion);
    if (row.managed_by !== input.managedBy) {
      await bumpAgent(tx, input.accountId, input.agentId, sql`managed_by = ${input.managedBy}`);
      await audit(tx, {
        accountId: input.accountId,
        actor: input.actor,
        action: "agent.management_changed",
        detail: {
          agentId: input.agentId,
          key: row.agent_key,
          from: row.managed_by,
          to: input.managedBy,
        },
      });
    }
    const updated = await selectAgentRow(tx, input.accountId, { id: input.agentId });
    return await loadAgent(tx, input.accountId, updated!);
  });
}

/**
 * Archives an agent: new chats can no longer name it, and it leaves every
 * list. Its versions and chats are kept; a code deploy of a code agent's key
 * restores it.
 */
export async function archiveOrgAgent(
  db: Database,
  input: { accountId: string; agentId: string; actor: OrgAgentActor; expectedVersion: number },
): Promise<OrgAgent> {
  return await withOrgAgentsScope(db, { accountId: input.accountId }, async (tx) => {
    const row = await lockLiveAgent(tx, input.accountId, input.agentId, input.expectedVersion);
    await bumpAgent(tx, input.accountId, input.agentId, sql`archived_at = now()`);
    await audit(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: "agent.archived",
      detail: { agentId: input.agentId, key: row.agent_key },
    });
    const updated = await selectAgentRow(tx, input.accountId, { id: input.agentId });
    return await loadAgent(tx, input.accountId, updated!);
  });
}

// ---------------------------------------------------------------------------
// Reach and the Console test workspace

/**
 * Whether chats in `workspaceId` may use the organization agent: the
 * workspace is one the organization manages (Console test workspace
 * included), or the agent was made available there. Runs in the caller's
 * transaction (account context, or that workspace's context). It does not
 * check that the agent exists, is published or is not archived.
 */
export async function orgAgentReachableInWorkspace(
  tx: Database,
  input: { accountId: string; agentId: string; workspaceId: string },
): Promise<boolean> {
  const [row] = await rawRows<{ reachable: boolean }>(
    tx,
    sql`select (
        exists (select 1 from organization_managed_workspaces m
          where m.account_id = ${input.accountId}::uuid and m.workspace_id = ${input.workspaceId}::uuid)
        or exists (select 1 from agent_workspace_access x
          where x.account_id = ${input.accountId}::uuid and x.agent_id = ${input.agentId}::uuid
            and x.workspace_id = ${input.workspaceId}::uuid)
      ) as reachable`,
  );
  return row?.reachable === true;
}

/** Whether `workspaceId` is the organization's Console test workspace (drafts run only there). */
export async function isOrgAgentTestWorkspace(
  tx: Database,
  input: { accountId: string; workspaceId: string },
): Promise<boolean> {
  const [row] = await rawRows<{ found: number }>(
    tx,
    sql`select 1 as found from organization_managed_workspaces
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and source = 'console_test'`,
  );
  return !!row;
}

export async function findOrgAgentTestWorkspace(
  db: Database,
  accountId: string,
): Promise<string | null> {
  const [row] = await withAccountRls(db, accountId, (tx) =>
    rawRows<{ workspace_id: string }>(
      tx,
      sql`select workspace_id::text as workspace_id from organization_managed_workspaces
        where account_id = ${accountId}::uuid and source = 'console_test'
        order by created_at limit 1`,
    ),
  );
  return row?.workspace_id ?? null;
}

/**
 * The organization's Console test workspace, created (with `create`, in this
 * transaction) and marked `console_test` when it does not exist yet.
 */
export async function ensureOrgAgentTestWorkspace(
  db: Database,
  input: {
    accountId: string;
    actor: OrgAgentActor;
    create: (tx: Database) => Promise<{ id: string }>;
  },
): Promise<{ workspaceId: string; created: boolean }> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    await lockKey(tx, `org-agent-test-workspace:${input.accountId}`);
    const [existing] = await rawRows<{ workspace_id: string }>(
      tx,
      sql`select workspace_id::text as workspace_id from organization_managed_workspaces
        where account_id = ${input.accountId}::uuid and source = 'console_test'
        order by created_at limit 1`,
    );
    if (existing) return { workspaceId: existing.workspace_id, created: false };
    const workspace = await input.create(tx);
    await tx.execute(sql`select set_config('opengeni.account_id', ${input.accountId}, true),
      set_config('opengeni.workspace_id', '', true)`);
    await tx.execute(sql`insert into organization_managed_workspaces
        (account_id, workspace_id, source, marked_by_subject_id)
      values (${input.accountId}::uuid, ${workspace.id}::uuid, 'console_test',
        ${input.actor.subjectId.slice(0, 512)})`);
    await audit(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: "workspace.kind_changed",
      workspaceId: workspace.id,
      detail: { from: "team", to: "managed", source: "console_test" },
    });
    return { workspaceId: workspace.id, created: true };
  });
}

/** Published, live organization agents chats in this workspace can name. */
export async function listOrgAgentsForWorkspace(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<WorkspaceOrgAgent[]> {
  const rows = await withOrgAgentsScope(db, input, (tx) =>
    rawRows<{
      id: string;
      agent_key: string;
      name: string;
      description: string;
      managed_by: OrgAgentManagedBy;
      published_revision: number;
    }>(
      tx,
      sql`select a.id::text as id, a.agent_key, r.name, r.description, a.managed_by,
          a.published_revision
        from agents a
        join agent_revisions r on r.account_id = a.account_id and r.agent_id = a.id
          and r.workspace_id is null and r.revision = a.published_revision
        where a.account_id = ${input.accountId}::uuid and a.scope = 'organization'
          and a.archived_at is null and a.published_revision is not null
          and (
            exists (select 1 from organization_managed_workspaces m
              where m.account_id = a.account_id and m.workspace_id = ${input.workspaceId}::uuid)
            or exists (select 1 from agent_workspace_access x
              where x.account_id = a.account_id and x.agent_id = a.id
                and x.workspace_id = ${input.workspaceId}::uuid)
          )
        order by lower(r.name), a.agent_key`,
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    key: row.agent_key,
    name: row.name,
    description: row.description,
    managedBy: row.managed_by,
    publishedVersion: row.published_revision,
  }));
}

// ---------------------------------------------------------------------------
// Chats of an agent (Console reads)

/** Runs `fn` as the system sees the organization (no session actor), bounded. */
async function sessionReadScope<T>(
  db: Database,
  accountId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return await withoutSessionRlsActor(() =>
    withAccountRls(db, accountId, async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '20s', true)`);
      return await fn(tx);
    }),
  );
}

async function scopeWorkspace(tx: Database, workspaceId: string | null): Promise<void> {
  await tx.execute(sql`select set_config('opengeni.workspace_id', ${workspaceId ?? ""}, true)`);
}

/** Root chats running another version that a publish with `moveRunningChats` would move. */
export async function countOrgAgentMovableChats(
  db: Database,
  input: { accountId: string; agentId: string; toVersion: number; workspaceIds: readonly string[] },
): Promise<number> {
  let count = 0;
  await sessionReadScope(db, input.accountId, async (tx) => {
    for (const workspaceId of input.workspaceIds.slice(0, CONSOLE_MAX_WORKSPACE_READS)) {
      await scopeWorkspace(tx, workspaceId);
      const [row] = await rawRows<{ count: string }>(
        tx,
        sql`select count(*)::text as count from sessions s
          where s.account_id = ${input.accountId}::uuid and s.workspace_id = ${workspaceId}::uuid
            and s.agent_id = ${input.agentId}::uuid and s.agent_version is not null
            and s.agent_version <> ${input.toVersion}
            and s.parent_session_id is null and s.archived_at is null
            and s.content_archive_state is null
            and s.status not in ('failed', 'cancelled')`,
      );
      count += num(row?.count);
    }
  });
  return count;
}

/** The organization's workspaces an agent's chats can be in: managed ones and its access list. */
export async function listOrgAgentChatWorkspaces(
  db: Database,
  input: { accountId: string; agentId: string },
): Promise<{ managed: string[]; access: string[] }> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const managed = await rawRows<{ workspace_id: string }>(
      tx,
      sql`select workspace_id::text as workspace_id from organization_managed_workspaces
        where account_id = ${input.accountId}::uuid order by workspace_id`,
    );
    const access = await rawRows<{ workspace_id: string }>(
      tx,
      sql`select workspace_id::text as workspace_id from agent_workspace_access
        where account_id = ${input.accountId}::uuid and agent_id = ${input.agentId}::uuid
        order by workspace_id`,
    );
    return {
      managed: managed.map((row) => row.workspace_id),
      access: access.map((row) => row.workspace_id),
    };
  });
}

/** Overrides as Console may show them: never a login, no values at the `metadata` level. */
function presentableOverrides(
  value: unknown,
  includeContent: boolean,
): OrgAgentSessionOverrides | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result: OrgAgentSessionOverrides = {};
  for (const [setting, change] of Object.entries(value as Record<string, unknown>)) {
    if (!change || typeof change !== "object") continue;
    const { agent, chat } = change as { agent?: unknown; chat?: unknown };
    result[setting] = includeContent
      ? { agent: withoutHeaders(agent), chat: withoutHeaders(chat) }
      : { agent: null, chat: null };
  }
  return Object.keys(result).length > 0 ? result : null;
}

function withoutHeaders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutHeaders);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "headers")
      .map(([key, entry]) => [key, withoutHeaders(entry)]),
  );
}

type AgentSessionRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  status: string;
  agent_version: number;
  agent_overrides: unknown;
  owner_subject_id: string | null;
  created_by_subject_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  updated_us: string;
};

/** The end user a chat belongs to, by the same rule as Console's session list. */
function agentSessionEndUserSubject(row: AgentSessionRow): string | null {
  if (row.owner_subject_id?.startsWith("external_user:")) return row.owner_subject_id;
  if (row.created_by_subject_id?.startsWith("external_user:")) return row.created_by_subject_id;
  return null;
}

/**
 * Newest-first reviewable root chats of one agent across the given (managed)
 * workspaces, with what each chat changed. `includeContent` is false at the
 * `metadata` review level: no title and no override values.
 */
export async function listOrgAgentSessions(
  db: Database,
  input: {
    accountId: string;
    agentId: string;
    workspaceIds: readonly string[];
    limit: number;
    cursor: string | null;
    version?: number | undefined;
    includeContent: boolean;
  },
): Promise<{ sessions: OrgAgentSessionEntry[]; nextCursor: string | null }> {
  const cursor = input.cursor ? decodeConsoleSessionCursor(input.cursor) : null;
  return await sessionReadScope(db, input.accountId, async (tx) => {
    const candidates: AgentSessionRow[] = [];
    for (const workspaceId of input.workspaceIds.slice(0, CONSOLE_MAX_WORKSPACE_READS)) {
      await scopeWorkspace(tx, workspaceId);
      candidates.push(
        ...(await rawRows<AgentSessionRow>(
          tx,
          sql`select s.id::text as id, s.workspace_id::text as workspace_id, s.title, s.status,
              s.agent_version, s.agent_overrides, s.owner_subject_id, s.created_by_subject_id,
              s.created_at, s.updated_at,
              (extract(epoch from s.updated_at) * 1000000)::bigint::text as updated_us
            from sessions s
            where s.account_id = ${input.accountId}::uuid and s.workspace_id = ${workspaceId}::uuid
              and s.agent_id = ${input.agentId}::uuid and s.agent_version is not null
              and s.parent_session_id is null
              and ${CONSOLE_REVIEWABLE_SESSION_SQL("s")}
              ${input.version !== undefined ? sql`and s.agent_version = ${input.version}` : sql``}
              ${
                cursor
                  ? sql`and (s.updated_at, s.id) < (timestamptz 'epoch' + (${cursor.updatedUs} || ' microseconds')::interval, ${cursor.id}::uuid)`
                  : sql``
              }
            order by s.updated_at desc, s.id desc
            limit ${input.limit + 1}`,
        )),
      );
    }
    candidates.sort((left, right) => {
      const byTime = BigInt(right.updated_us) - BigInt(left.updated_us);
      if (byTime !== 0n) return byTime > 0n ? 1 : -1;
      return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
    });
    const page = candidates.slice(0, input.limit);
    const last = page.at(-1);
    // What each chat cost (the same debits Console's session list shows).
    const spend = new Map<string, number>();
    const byWorkspace = new Map<string, string[]>();
    for (const row of page) {
      byWorkspace.set(row.workspace_id, [...(byWorkspace.get(row.workspace_id) ?? []), row.id]);
    }
    for (const [workspaceId, ids] of byWorkspace) {
      await scopeWorkspace(tx, workspaceId);
      for (const row of await rawRows<{ id: string; spend: string }>(
        tx,
        consoleSessionSpendSql(input.accountId, workspaceId, ids),
      )) {
        spend.set(row.id, Math.max(0, num(row.spend)));
      }
    }
    await scopeWorkspace(tx, null);
    const endUsers = await readConsoleEndUsers(
      tx,
      input.accountId,
      page.map(agentSessionEndUserSubject).filter((value) => value !== null),
    );
    return {
      sessions: page.map((row) => {
        const subject = agentSessionEndUserSubject(row);
        const label = subject ? endUsers.get(subject) : undefined;
        return {
          id: row.id,
          workspaceId: row.workspace_id,
          title: input.includeContent ? row.title : null,
          status: row.status,
          agentVersion: row.agent_version,
          overrides: presentableOverrides(row.agent_overrides, input.includeContent),
          endUser: subject
            ? {
                subjectId: subject,
                externalId: label?.externalId ?? null,
                source: label?.source ?? null,
                displayName: label?.displayName ?? null,
                email: label?.email ?? null,
              }
            : null,
          costMicros: spend.get(row.id) ?? 0,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        };
      }),
      nextCursor:
        candidates.length > input.limit && last
          ? encodeConsoleCursor({ u: last.updated_us, i: last.id })
          : null,
    };
  });
}

/** Per-agent usage: root chats started in the window and their trees' metered cost, by version. */
export async function orgAgentUsage(
  db: Database,
  input: {
    accountId: string;
    agentId: string;
    workspaceIds: readonly string[];
    from: string;
    to: string;
  },
): Promise<OrgAgentUsageResponse> {
  const byVersion = new Map<number, { sessions: number; costMicros: number }>();
  await sessionReadScope(db, input.accountId, async (tx) => {
    for (const workspaceId of input.workspaceIds.slice(0, CONSOLE_MAX_WORKSPACE_READS)) {
      await scopeWorkspace(tx, workspaceId);
      const rows = await rawRows<{ id: string; agent_version: number }>(
        tx,
        sql`select s.id::text as id, s.agent_version from sessions s
          where s.account_id = ${input.accountId}::uuid and s.workspace_id = ${workspaceId}::uuid
            and s.agent_id = ${input.agentId}::uuid and s.agent_version is not null
            and s.parent_session_id is null
            and s.created_at >= ${input.from}::timestamptz and s.created_at < ${input.to}::timestamptz
          limit 10000`,
      );
      if (rows.length === 0) continue;
      const spend = new Map(
        (
          await rawRows<{ id: string; spend: string }>(
            tx,
            consoleSessionSpendSql(
              input.accountId,
              workspaceId,
              rows.map((row) => row.id),
            ),
          )
        ).map((row) => [row.id, num(row.spend)]),
      );
      for (const row of rows) {
        const entry = byVersion.get(row.agent_version) ?? { sessions: 0, costMicros: 0 };
        entry.sessions += 1;
        entry.costMicros += Math.max(0, spend.get(row.id) ?? 0);
        byVersion.set(row.agent_version, entry);
      }
    }
  });
  const versions = [...byVersion.entries()]
    .sort(([left], [right]) => right - left)
    .map(([version, entry]) => ({ version, ...entry }));
  return {
    from: input.from,
    to: input.to,
    sessions: versions.reduce((total, entry) => total + entry.sessions, 0),
    costMicros: versions.reduce((total, entry) => total + entry.costMicros, 0),
    byVersion: versions,
  };
}

// ---------------------------------------------------------------------------
// Organization tool servers

type ToolServerRow = {
  id: string;
  server_key: string;
  name: string;
  url: string;
  auth_mode: OrgToolServerAuthMode;
  shared_headers_encrypted: string | null;
  shared_header_names: string[] | null;
  oauth_refresh: unknown;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

const TOOL_SERVER_COLUMNS = sql.raw(`id::text as id, server_key, name, url, auth_mode,
  shared_headers_encrypted, shared_header_names, oauth_refresh, version, created_at, updated_at`);

type StoredOAuthRefresh = { tokenUrl: string; clientId: string; clientSecretEncrypted?: string };

function storedOAuthRefresh(value: unknown): StoredOAuthRefresh | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.tokenUrl !== "string" || typeof record.clientId !== "string") return null;
  return {
    tokenUrl: record.tokenUrl,
    clientId: record.clientId,
    ...(typeof record.clientSecretEncrypted === "string"
      ? { clientSecretEncrypted: record.clientSecretEncrypted }
      : {}),
  };
}

function mapToolServer(row: ToolServerRow): OrgToolServer {
  const oauth = storedOAuthRefresh(row.oauth_refresh);
  return {
    id: row.id,
    key: row.server_key,
    name: row.name,
    url: row.url,
    authMode: row.auth_mode,
    hasSharedKey: row.shared_headers_encrypted !== null,
    sharedHeaderNames: row.shared_header_names ?? [],
    oauthRefresh: oauth
      ? {
          tokenUrl: oauth.tokenUrl,
          clientId: oauth.clientId,
          hasClientSecret: oauth.clientSecretEncrypted !== undefined,
        }
      : null,
    rowVersion: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function requireKey(key: Uint8Array | null): Uint8Array {
  if (!key) throw new OrgAgentEncryptionUnavailableError();
  return key;
}

function encryptHeaders(key: Uint8Array | null, headers: Record<string, string>): string {
  return encryptEnvironmentValue(requireKey(key), JSON.stringify(headers));
}

function encryptOAuthRefresh(
  key: Uint8Array | null,
  input: { tokenUrl: string; clientId: string; clientSecret?: string | undefined },
): StoredOAuthRefresh {
  return {
    tokenUrl: input.tokenUrl,
    clientId: input.clientId,
    ...(input.clientSecret !== undefined
      ? { clientSecretEncrypted: encryptEnvironmentValue(requireKey(key), input.clientSecret) }
      : {}),
  };
}

function toolServerInvalid(message: string): OrgAgentError {
  return new OrgAgentError(422, "tool_server_invalid", message);
}

function toolServerNotFound(key: string): OrgAgentError {
  return new OrgAgentError(404, "tool_server_not_found", `No tool server '${key}'.`);
}

/** Where a URL's secrets go: its origin, or the raw value when it does not parse. */
function urlOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

export async function listOrgToolServers(
  db: Database,
  accountId: string,
): Promise<OrgToolServer[]> {
  const rows = await withAccountRls(db, accountId, (tx) =>
    rawRows<ToolServerRow>(
      tx,
      sql`select ${TOOL_SERVER_COLUMNS} from organization_tool_servers
        where account_id = ${accountId}::uuid order by server_key`,
    ),
  );
  return rows.map(mapToolServer);
}

async function selectToolServer(
  tx: Database,
  accountId: string,
  key: string,
  options: { forUpdate?: boolean; forShare?: boolean } = {},
): Promise<ToolServerRow | null> {
  const [row] = await rawRows<ToolServerRow>(
    tx,
    sql`select ${TOOL_SERVER_COLUMNS} from organization_tool_servers
      where account_id = ${accountId}::uuid and server_key = ${key}
      ${options.forUpdate ? sql`for update` : options.forShare ? sql`for share` : sql``}`,
  );
  return row ?? null;
}

export async function getOrgToolServer(
  db: Database,
  accountId: string,
  key: string,
): Promise<OrgToolServer | null> {
  const row = await withAccountRls(db, accountId, (tx) => selectToolServer(tx, accountId, key));
  return row ? mapToolServer(row) : null;
}

export async function createOrgToolServer(
  db: Database,
  input: {
    accountId: string;
    actor: OrgAgentActor;
    request: CreateOrgToolServerRequest;
    encryptionKey: Uint8Array | null;
  },
): Promise<OrgToolServer> {
  const request = input.request;
  if (request.sharedHeaders !== undefined && request.authMode !== "shared_key") {
    throw toolServerInvalid("Only a shared_key tool server keeps a shared key.");
  }
  const sharedHeaders =
    request.sharedHeaders !== undefined
      ? encryptHeaders(input.encryptionKey, request.sharedHeaders)
      : null;
  const sharedHeaderNames = Object.keys(request.sharedHeaders ?? {}).sort();
  const oauth = request.oauthRefresh
    ? encryptOAuthRefresh(input.encryptionKey, request.oauthRefresh)
    : null;
  return await withAccountRls(db, input.accountId, async (tx) => {
    await lockKey(tx, `org-tool-servers:${input.accountId}`);
    if (await selectToolServer(tx, input.accountId, request.key)) {
      throw new OrgAgentError(
        409,
        "tool_server_key_taken",
        `A tool server with key '${request.key}' already exists.`,
      );
    }
    const [count] = await rawRows<{ count: number }>(
      tx,
      sql`select count(*)::int as count from organization_tool_servers
        where account_id = ${input.accountId}::uuid`,
    );
    if (num(count?.count) >= ORG_TOOL_SERVERS_PER_ORGANIZATION_MAX) {
      throw new OrgAgentError(
        429,
        "organization_agent_limit_reached",
        `An organization keeps at most ${ORG_TOOL_SERVERS_PER_ORGANIZATION_MAX} tool servers.`,
      );
    }
    const [row] = await rawRows<ToolServerRow>(
      tx,
      sql`insert into organization_tool_servers (account_id, server_key, name, url, auth_mode,
          shared_headers_encrypted, shared_header_names, oauth_refresh, created_by_subject_id)
        values (${input.accountId}::uuid, ${request.key}, ${request.name.trim()}, ${request.url},
          ${request.authMode}, ${sharedHeaders}, ${pgArray(sharedHeaderNames)}::text[],
          ${oauth === null ? null : JSON.stringify(oauth)}::jsonb,
          ${input.actor.subjectId.slice(0, 1024)})
        returning ${TOOL_SERVER_COLUMNS}`,
    );
    await audit(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: "tool_server.created",
      detail: {
        toolServerId: row!.id,
        key: request.key,
        url: request.url,
        authMode: request.authMode,
        sharedHeaderNames,
      },
    });
    return mapToolServer(row!);
  });
}

export async function updateOrgToolServer(
  db: Database,
  input: {
    accountId: string;
    key: string;
    actor: OrgAgentActor;
    request: UpdateOrgToolServerRequest;
    encryptionKey: Uint8Array | null;
  },
): Promise<OrgToolServer> {
  const request = input.request;
  const sharedHeaders =
    request.sharedHeaders === undefined || request.sharedHeaders === null
      ? request.sharedHeaders
      : encryptHeaders(input.encryptionKey, request.sharedHeaders);
  const oauth = request.oauthRefresh;
  return await withAccountRls(db, input.accountId, async (tx) => {
    const current = await selectToolServer(tx, input.accountId, input.key, { forUpdate: true });
    if (!current) throw toolServerNotFound(input.key);
    if (request.expectedVersion !== current.version) {
      throw new OrgAgentError(
        409,
        "agent_version_conflict",
        "The tool server changed since you loaded it. Reload and try again.",
        { currentVersion: current.version },
      );
    }
    const authMode = request.authMode ?? current.auth_mode;
    if (typeof sharedHeaders === "string" && authMode !== "shared_key") {
      throw toolServerInvalid("Only a shared_key tool server keeps a shared key.");
    }
    // Secrets are bound to where they are sent. Pointing the server at another
    // origin drops its shared key (unless this request sets a new one) and
    // deletes every end user's stored login for it; pointing OAuth refresh at
    // another origin drops the client secret (unless re-supplied) and deletes
    // the stored OAuth logins, whose refresh tokens would go there.
    const nextUrl = request.url ?? current.url;
    const serverMoved = urlOrigin(nextUrl) !== urlOrigin(current.url);
    const currentOAuth = storedOAuthRefresh(current.oauth_refresh);
    // Leaving shared_key drops the shared key.
    const nextSharedHeaders =
      authMode !== "shared_key"
        ? null
        : sharedHeaders !== undefined
          ? sharedHeaders
          : serverMoved
            ? null
            : current.shared_headers_encrypted;
    const sharedKeyDropped =
      serverMoved &&
      sharedHeaders === undefined &&
      authMode === "shared_key" &&
      current.shared_headers_encrypted !== null;
    const nextHeaderNames =
      nextSharedHeaders === null
        ? []
        : request.sharedHeaders
          ? Object.keys(request.sharedHeaders).sort()
          : (current.shared_header_names ?? []);
    let nextOAuth: StoredOAuthRefresh | null = currentOAuth;
    let clientSecretDropped = false;
    if (oauth === null) nextOAuth = null;
    else if (oauth !== undefined) {
      // An omitted client secret keeps the stored one while the client and
      // the token endpoint's origin stay the same.
      const keep =
        oauth.clientSecret === undefined &&
        currentOAuth?.clientSecretEncrypted !== undefined &&
        currentOAuth.clientId === oauth.clientId &&
        urlOrigin(currentOAuth.tokenUrl) === urlOrigin(oauth.tokenUrl);
      clientSecretDropped =
        oauth.clientSecret === undefined &&
        currentOAuth?.clientSecretEncrypted !== undefined &&
        !keep;
      nextOAuth = {
        ...encryptOAuthRefresh(input.encryptionKey, oauth),
        ...(keep ? { clientSecretEncrypted: currentOAuth!.clientSecretEncrypted } : {}),
      };
    }
    // Setting a token endpoint where there was none also counts: stored
    // refresh tokens would start going there.
    const tokenUrlMoved =
      nextOAuth !== null && urlOrigin(nextOAuth.tokenUrl) !== urlOrigin(currentOAuth?.tokenUrl);
    const changed = Object.keys(request).filter(
      (field) =>
        field !== "expectedVersion" && request[field as keyof typeof request] !== undefined,
    );
    const [row] = await rawRows<ToolServerRow>(
      tx,
      sql`update organization_tool_servers set
          name = ${request.name?.trim() ?? current.name},
          url = ${nextUrl},
          auth_mode = ${authMode},
          shared_headers_encrypted = ${nextSharedHeaders},
          shared_header_names = ${pgArray(nextHeaderNames)}::text[],
          oauth_refresh = ${nextOAuth === null ? null : JSON.stringify(nextOAuth)}::jsonb,
          version = version + 1, updated_at = now()
        where account_id = ${input.accountId}::uuid and id = ${current.id}::uuid
        returning ${TOOL_SERVER_COLUMNS}`,
    );
    // The account context sees every workspace's logins (1505 policy). Turns
    // read the server before its logins, and this runs in the same
    // transaction as the URL change, so no turn pairs a login with the new
    // origin.
    const removedLogins =
      serverMoved || tokenUrlMoved
        ? (
            await rawRows<{ id: string }>(
              tx,
              sql`delete from end_user_tool_credentials
                where account_id = ${input.accountId}::uuid
                  and tool_server_id = ${current.id}::uuid
                  ${serverMoved ? sql`` : sql`and kind = 'oauth'`}
                returning id::text as id`,
            )
          ).length
        : 0;
    await audit(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: "tool_server.updated",
      detail: {
        toolServerId: current.id,
        key: input.key,
        changed,
        ...(request.url !== undefined ? { url: request.url } : {}),
        ...(request.authMode !== undefined ? { authMode: request.authMode } : {}),
        sharedHeaderNames: nextHeaderNames,
        ...(serverMoved ? { urlOriginChanged: true } : {}),
        ...(tokenUrlMoved ? { tokenUrlOriginChanged: true } : {}),
        ...(sharedKeyDropped ? { sharedKeyDropped: true } : {}),
        ...(clientSecretDropped ? { clientSecretDropped: true } : {}),
        ...(serverMoved || tokenUrlMoved ? { endUserLoginsRemoved: removedLogins } : {}),
      },
    });
    return mapToolServer(row!);
  });
}

/**
 * Deletes a tool server and every end user's login for it. Versions that
 * name it keep the reference; their chats get it as unavailable.
 */
export async function deleteOrgToolServer(
  db: Database,
  input: { accountId: string; key: string; actor: OrgAgentActor; expectedVersion?: number },
): Promise<boolean> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const current = await selectToolServer(tx, input.accountId, input.key, { forUpdate: true });
    if (!current) return false;
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new OrgAgentError(
        409,
        "agent_version_conflict",
        "The tool server changed since you loaded it. Reload and try again.",
        { currentVersion: current.version },
      );
    }
    await tx.execute(sql`delete from organization_tool_servers
      where account_id = ${input.accountId}::uuid and id = ${current.id}::uuid`);
    await audit(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: "tool_server.deleted",
      detail: { toolServerId: current.id, key: input.key },
    });
    return true;
  });
}

/** A tool server with its decrypted secrets, for the runtime and the live tool list only. */
export type OrgToolServerWithSecrets = {
  server: OrgToolServer;
  sharedHeaders: Record<string, string> | null;
  oauthRefresh: { tokenUrl: string; clientId: string; clientSecret: string | null } | null;
};

export function decodeOrgToolServerSecrets(
  key: Uint8Array | null,
  row: { shared_headers_encrypted: string | null; oauth_refresh: unknown },
): Pick<OrgToolServerWithSecrets, "sharedHeaders" | "oauthRefresh"> {
  const oauth = storedOAuthRefresh(row.oauth_refresh);
  return {
    sharedHeaders:
      row.shared_headers_encrypted === null
        ? null
        : (JSON.parse(
            decryptEnvironmentValue(requireKey(key), row.shared_headers_encrypted),
          ) as Record<string, string>),
    oauthRefresh: oauth
      ? {
          tokenUrl: oauth.tokenUrl,
          clientId: oauth.clientId,
          clientSecret:
            oauth.clientSecretEncrypted === undefined
              ? null
              : decryptEnvironmentValue(requireKey(key), oauth.clientSecretEncrypted),
        }
      : null,
  };
}

export async function readOrgToolServersWithSecrets(
  tx: Database,
  input: { accountId: string; keys: readonly string[]; encryptionKey: Uint8Array | null },
): Promise<OrgToolServerWithSecrets[]> {
  if (input.keys.length === 0) return [];
  const rows = await rawRows<ToolServerRow>(
    tx,
    sql`select ${TOOL_SERVER_COLUMNS} from organization_tool_servers
      where account_id = ${input.accountId}::uuid and server_key = any(${pgArray([...input.keys])}::text[])`,
  );
  return rows.map((row) => ({
    server: mapToolServer(row),
    ...decodeOrgToolServerSecrets(input.encryptionKey, row),
  }));
}

export async function getOrgToolServerWithSecrets(
  db: Database,
  input: { accountId: string; key: string; encryptionKey: Uint8Array | null },
): Promise<OrgToolServerWithSecrets | null> {
  const [server] = await withAccountRls(db, input.accountId, (tx) =>
    readOrgToolServersWithSecrets(tx, { ...input, keys: [input.key] }),
  );
  return server ?? null;
}

// ---------------------------------------------------------------------------
// End users' tool logins

/** The decrypted shape of `end_user_tool_credentials.material_encrypted`. */
export type EndUserToolCredentialMaterial =
  | { kind: "headers"; headers: Record<string, string> }
  | { kind: "oauth"; accessToken: string; refreshToken?: string; tokenType: string };

export function encodeEndUserToolCredentialMaterial(
  key: Uint8Array | null,
  material: EndUserToolCredentialMaterial,
): string {
  return encryptEnvironmentValue(requireKey(key), JSON.stringify(material));
}

export function decodeEndUserToolCredentialMaterial(
  key: Uint8Array | null,
  stored: string,
): EndUserToolCredentialMaterial {
  return JSON.parse(
    decryptEnvironmentValue(requireKey(key), stored),
  ) as EndUserToolCredentialMaterial;
}

type CredentialRow = {
  kind: "headers" | "oauth";
  expires_at: Date | string | null;
  refresh_failed_at: Date | string | null;
  updated_at: Date | string;
  last_used_at: Date | string | null;
};

function mapCredential(toolServerKey: string, row: CredentialRow): EndUserToolCredential {
  return {
    toolServerKey,
    kind: row.kind,
    expiresAt: isoOrNull(row.expires_at),
    refreshFailedAt: isoOrNull(row.refresh_failed_at),
    updatedAt: iso(row.updated_at),
    lastUsedAt: isoOrNull(row.last_used_at),
  };
}

function workspaceNotManaged(): OrgAgentError {
  return new OrgAgentError(
    422,
    "workspace_not_managed",
    "End users' tool logins are stored only in workspaces the organization manages.",
  );
}

type CredentialTarget = {
  accountId: string;
  workspaceId: string;
  endUserSubjectId: string;
  toolServerKey: string;
};

/**
 * The workspace must be managed by the organization, and the server must
 * exist. A write holds the server row (FOR SHARE) so a concurrent change of
 * its URL either sees this login and deletes it, or happens first.
 */
async function credentialServer(
  tx: Database,
  input: CredentialTarget,
  options: { forWrite?: boolean } = {},
): Promise<ToolServerRow> {
  const [managed] = await rawRows<{ found: number }>(
    tx,
    sql`select 1 as found from organization_managed_workspaces
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
  );
  if (!managed) throw workspaceNotManaged();
  const server = await selectToolServer(tx, input.accountId, input.toolServerKey, {
    forShare: options.forWrite === true,
  });
  if (!server) throw toolServerNotFound(input.toolServerKey);
  return server;
}

export async function putEndUserToolCredential(
  db: Database,
  input: CredentialTarget & {
    actor: OrgAgentActor;
    credential: PutEndUserToolCredentialRequest;
    encryptionKey: Uint8Array | null;
  },
): Promise<EndUserToolCredential> {
  const credential = input.credential;
  const material: EndUserToolCredentialMaterial =
    credential.kind === "headers"
      ? { kind: "headers", headers: credential.headers }
      : {
          kind: "oauth",
          accessToken: credential.accessToken,
          ...(credential.refreshToken !== undefined
            ? { refreshToken: credential.refreshToken }
            : {}),
          tokenType: credential.tokenType ?? "Bearer",
        };
  const encrypted = encodeEndUserToolCredentialMaterial(input.encryptionKey, material);
  const expiresAt = credential.kind === "oauth" ? (credential.expiresAt ?? null) : null;
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const server = await credentialServer(tx, input, { forWrite: true });
      // The workspace's managed marker is the foreign key's target: if it is
      // removed after the check above, the insert's foreign key fails, which
      // is a refusal, never a server error. (A row lock here would need an
      // UPDATE policy the workspace context doesn't have.)
      const [row] = await rawRows<CredentialRow>(
        tx,
        sql`insert into end_user_tool_credentials (account_id, workspace_id, end_user_subject_id,
            tool_server_id, kind, material_encrypted, expires_at)
          values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.endUserSubjectId},
            ${server.id}::uuid, ${credential.kind}, ${encrypted}, ${expiresAt}::timestamptz)
          on conflict (account_id, workspace_id, end_user_subject_id, tool_server_id) do update set
            kind = excluded.kind, material_encrypted = excluded.material_encrypted,
            expires_at = excluded.expires_at, refresh_failed_at = null,
            version = end_user_tool_credentials.version + 1, updated_at = now()
          returning kind, expires_at, refresh_failed_at, updated_at, last_used_at`,
      ).catch((error: unknown) => {
        if (nestedPostgresSqlState(error) === "23503") throw workspaceNotManaged();
        throw error;
      });
      await audit(tx, {
        accountId: input.accountId,
        actor: input.actor,
        action: "tool_credential.written",
        workspaceId: input.workspaceId,
        detail: {
          toolServerKey: input.toolServerKey,
          endUserSubjectId: input.endUserSubjectId,
          kind: credential.kind,
        },
      });
      return mapCredential(input.toolServerKey, row!);
    },
  );
}

/** The stored login's metadata (never its material), or null. */
export async function getEndUserToolCredential(
  db: Database,
  input: CredentialTarget,
): Promise<EndUserToolCredential | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const server = await credentialServer(tx, input);
      const [row] = await rawRows<CredentialRow>(
        tx,
        sql`select kind, expires_at, refresh_failed_at, updated_at, last_used_at
          from end_user_tool_credentials
          where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
            and end_user_subject_id = ${input.endUserSubjectId} and tool_server_id = ${server.id}::uuid`,
      );
      return row ? mapCredential(input.toolServerKey, row) : null;
    },
  );
}

export async function deleteEndUserToolCredential(
  db: Database,
  input: CredentialTarget & { actor: OrgAgentActor },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const server = await credentialServer(tx, input);
      const deleted = await rawRows<{ id: string }>(
        tx,
        sql`delete from end_user_tool_credentials
          where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
            and end_user_subject_id = ${input.endUserSubjectId} and tool_server_id = ${server.id}::uuid
          returning id::text as id`,
      );
      if (deleted.length === 0) return false;
      await audit(tx, {
        accountId: input.accountId,
        actor: input.actor,
        action: "tool_credential.deleted",
        workspaceId: input.workspaceId,
        detail: { toolServerKey: input.toolServerKey, endUserSubjectId: input.endUserSubjectId },
      });
      return true;
    },
  );
}
