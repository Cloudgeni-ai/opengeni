/**
 * Organization (Console) agents at runtime: what session create, the turn
 * worker and the publish "move running chats" workflow read and write.
 *
 * Organization agents and their versions are hidden by a restrictive RLS
 * policy unless the transaction sets `opengeni.org_agents_v1 = 1` (migration
 * 1502). That is a visibility rule, not a security boundary: callers check
 * permissions and reach before they use anything read here. Every helper sets
 * the setting for its own statements and restores the previous value.
 *
 * The management side (Console, deploys, tool servers, end-user logins) lives
 * in `organization-agents.ts`.
 */
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, withoutSessionRlsActor, type Database } from "./database";
import { parseOrgAgentRunsOnTarget, type OrgAgentRunsOnTarget } from "./organization-agent-compute";

/** The transaction setting that makes organization agents visible (migration 1502). */
export const ORG_AGENTS_VISIBILITY_SETTING = "opengeni.org_agents_v1";

/** Run `fn` with organization agents visible in this transaction, then restore the setting. */
export async function withOrgAgentsVisible<T>(tx: Database, fn: () => Promise<T>): Promise<T> {
  const [prior] = await rawRows<{ value: string }>(
    tx,
    sql`select coalesce(current_setting('opengeni.org_agents_v1', true), '') as value`,
  );
  await tx.execute(sql`select set_config('opengeni.org_agents_v1', '1', true)`);
  let completed = false;
  try {
    const result = await fn();
    completed = true;
    return result;
  } finally {
    const restore = tx.execute(
      sql`select set_config('opengeni.org_agents_v1', ${prior?.value ?? ""}, true)`,
    );
    if (completed) await restore;
    else await restore.catch(() => undefined);
  }
}

/**
 * A system read or write in a workspace (or, with `workspaceId: null`, the
 * account) with organization agents visible. The caller has already checked
 * the person's permission; the ambient session actor is not used.
 */
export async function withOrgAgentScope<T>(
  db: Database,
  scope: { accountId: string; workspaceId: string | null },
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return await withoutSessionRlsActor(() =>
    withRlsContext(db, { accountId: scope.accountId, workspaceId: scope.workspaceId }, (tx) =>
      withOrgAgentsVisible(tx, () => fn(tx)),
    ),
  );
}

/** A Postgres text[] literal, bound as one parameter (never interpolated into SQL). */
function pgTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

function pgUuidArray(values: readonly string[]): string {
  for (const value of values)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
      throw new Error("Invalid id");
  return `{${values.join(",")}}`;
}

export type OrgAgentRuntimeAgent = {
  id: string;
  accountId: string;
  key: string;
  name: string;
  managedBy: "console" | "code";
  /** The published version; null until the agent is published. */
  publishedVersion: number | null;
  /** The newest version. */
  currentVersion: number;
  archived: boolean;
};

export type OrgAgentRuntimeVersion = {
  agentId: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  /** `agent_revisions.config` (OrgAgentVersionConfig), unparsed. */
  config: unknown;
  /** `agent_revisions.tool_catalog` ({serverKey: [{name, description?}]}), unparsed. */
  toolCatalog: unknown;
  configHash: string | null;
  source: string | null;
  /**
   * The machine or sandbox environment `runsOn` named when the version was
   * saved (`agent_revisions.runs_on_target`), by id; null for a version saved
   * before Runs on pinned ids or without a machine/environment.
   */
  runsOnTarget: OrgAgentRunsOnTarget | null;
};

/** Where an organization agent can run: the workspace's managed marker and access row. */
export type OrgAgentWorkspaceReach = {
  /** `organization_managed_workspaces.source` for this workspace, or null. */
  managedSource: string | null;
  /** An `agent_workspace_access` row names this workspace. */
  access: boolean;
};

type AgentRow = {
  id: string;
  account_id: string;
  agent_key: string;
  name: string;
  managed_by: string;
  published_revision: number | null;
  current_revision: number;
  archived: boolean;
};

const AGENT_COLUMNS = sql`a.id::text as id, a.account_id::text as account_id, a.agent_key,
  a.name, a.managed_by, a.published_revision, a.current_revision,
  (a.archived_at is not null) as archived`;

function mapAgent(row: AgentRow): OrgAgentRuntimeAgent {
  return {
    id: row.id,
    accountId: row.account_id,
    key: row.agent_key,
    name: row.name,
    managedBy: row.managed_by === "code" ? "code" : "console",
    publishedVersion:
      row.published_revision === null || row.published_revision === undefined
        ? null
        : Number(row.published_revision),
    currentVersion: Number(row.current_revision),
    archived: Boolean(row.archived),
  };
}

type VersionRow = {
  agent_id: string;
  revision: number;
  name: string;
  description: string;
  instructions: string;
  config: unknown;
  tool_catalog: unknown;
  config_hash: string | null;
  source: string | null;
  runs_on_target: unknown;
};

const VERSION_COLUMNS = sql`r.agent_id::text as agent_id, r.revision, r.name, r.description,
  r.instructions, r.config, r.tool_catalog, r.config_hash, r.source, r.runs_on_target`;

function mapVersion(row: VersionRow): OrgAgentRuntimeVersion {
  return {
    agentId: row.agent_id,
    version: Number(row.revision),
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    config: row.config,
    toolCatalog: row.tool_catalog,
    configHash: row.config_hash,
    source: row.source,
    runsOnTarget: parseOrgAgentRunsOnTarget(row.runs_on_target),
  };
}

async function agentByRef(
  tx: Database,
  accountId: string,
  ref: { id: string } | { key: string },
  lock = false,
): Promise<OrgAgentRuntimeAgent | null> {
  const [row] = await rawRows<AgentRow>(
    tx,
    sql`select ${AGENT_COLUMNS}
      from agents a
      where a.account_id = ${accountId}::uuid and a.scope = 'organization'
        and ${"id" in ref ? sql`a.id = ${ref.id}::uuid` : sql`a.agent_key = ${ref.key}`}
      ${lock ? sql`for update` : sql``}`,
  );
  return row ? mapAgent(row) : null;
}

async function workspaceReach(
  tx: Database,
  input: { accountId: string; workspaceId: string; agentId: string | null },
): Promise<OrgAgentWorkspaceReach> {
  const [row] = await rawRows<{ managed_source: string | null; access: boolean }>(
    tx,
    sql`select
      (select m.source from organization_managed_workspaces m
        where m.account_id = ${input.accountId}::uuid
          and m.workspace_id = ${input.workspaceId}::uuid) as managed_source,
      ${
        input.agentId
          ? sql`exists (select 1 from agent_workspace_access w
              where w.account_id = ${input.accountId}::uuid
                and w.agent_id = ${input.agentId}::uuid
                and w.workspace_id = ${input.workspaceId}::uuid)`
          : sql`false`
      } as access`,
  );
  return { managedSource: row?.managed_source ?? null, access: Boolean(row?.access) };
}

/**
 * The organization agent a session create names (by id or key) and how it
 * reaches the workspace. `agent` is null when the organization has none.
 */
export async function readOrgAgentForSessionCreate(
  db: Database,
  input: { accountId: string; workspaceId: string; ref: { id: string } | { key: string } },
): Promise<{ agent: OrgAgentRuntimeAgent | null; reach: OrgAgentWorkspaceReach }> {
  return await withOrgAgentScope(db, input, async (tx) => {
    const agent = await agentByRef(tx, input.accountId, input.ref);
    const reach = await workspaceReach(tx, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      agentId: agent?.id ?? null,
    });
    return { agent, reach };
  });
}

/** One version of an organization agent, or null. */
export async function readOrgAgentVersion(
  db: Database,
  input: { accountId: string; workspaceId: string | null; agentId: string; version: number },
): Promise<OrgAgentRuntimeVersion | null> {
  return await withOrgAgentScope(db, input, (tx) => readOrgAgentVersionInTransaction(tx, input));
}

/** {@link readOrgAgentVersion} in a transaction that already shows organization agents. */
export async function readOrgAgentVersionInTransaction(
  tx: Database,
  input: { accountId: string; agentId: string; version: number },
): Promise<OrgAgentRuntimeVersion | null> {
  const [row] = await rawRows<VersionRow>(
    tx,
    sql`select ${VERSION_COLUMNS}
      from agent_revisions r
      where r.account_id = ${input.accountId}::uuid and r.workspace_id is null
        and r.agent_id = ${input.agentId}::uuid and r.revision = ${input.version}::integer`,
  );
  return row ? mapVersion(row) : null;
}

export type OrgToolServerRuntime = {
  id: string;
  key: string;
  name: string;
  url: string;
  authMode: "per_user" | "shared_key" | "none";
  /** encrypt(JSON of Record<string,string>); only for `shared_key`. */
  sharedHeadersEncrypted: string | null;
  /** `{tokenUrl, clientId, clientSecretEncrypted?}` for end-user OAuth refresh. */
  oauthRefresh: { tokenUrl: string; clientId: string; clientSecretEncrypted?: string } | null;
  version: number;
};

type ToolServerRow = {
  id: string;
  server_key: string;
  name: string;
  url: string;
  auth_mode: string;
  shared_headers_encrypted: string | null;
  oauth_refresh: unknown;
  version: number;
};

function mapToolServer(row: ToolServerRow): OrgToolServerRuntime {
  const refresh = row.oauth_refresh as Record<string, unknown> | null;
  return {
    id: row.id,
    key: row.server_key,
    name: row.name,
    url: row.url,
    authMode:
      row.auth_mode === "shared_key"
        ? "shared_key"
        : row.auth_mode === "none"
          ? "none"
          : "per_user",
    sharedHeadersEncrypted: row.shared_headers_encrypted,
    oauthRefresh:
      refresh &&
      typeof refresh === "object" &&
      typeof refresh["tokenUrl"] === "string" &&
      typeof refresh["clientId"] === "string"
        ? {
            tokenUrl: refresh["tokenUrl"],
            clientId: refresh["clientId"],
            ...(typeof refresh["clientSecretEncrypted"] === "string"
              ? { clientSecretEncrypted: refresh["clientSecretEncrypted"] }
              : {}),
          }
        : null,
    version: Number(row.version),
  };
}

/** The organization's tool servers with these keys (unknown keys are absent). */
export async function listOrgToolServersByKey(
  db: Database,
  input: { accountId: string; workspaceId: string | null; keys: readonly string[] },
): Promise<Map<string, OrgToolServerRuntime>> {
  if (input.keys.length === 0) return new Map();
  const rows = await withOrgAgentScope(db, input, (tx) =>
    rawRows<ToolServerRow>(
      tx,
      sql`select s.id::text as id, s.server_key, s.name, s.url, s.auth_mode,
          s.shared_headers_encrypted, s.oauth_refresh, s.version
        from organization_tool_servers s
        where s.account_id = ${input.accountId}::uuid
          and s.server_key = any(${pgTextArray(input.keys)}::text[])`,
    ),
  );
  return new Map(rows.map((row) => [row.server_key, mapToolServer(row)]));
}

export type InlineOrgAgentVersionResult =
  | {
      outcome: "created_agent" | "created_version" | "reused";
      agent: OrgAgentRuntimeAgent;
      version: OrgAgentRuntimeVersion;
    }
  | { outcome: "managed_in_console" | "archived"; agent: OrgAgentRuntimeAgent }
  | { outcome: "not_found" | "forbidden" };

/**
 * An inline `agent.config` on session create: the version of a code-managed
 * agent with this config hash, adding the agent (unknown key) or a version
 * (new hash) when `mayWrite`. Inline versions are never published.
 */
export async function saveInlineOrgAgentVersion(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    ref: { id: string } | { key: string };
    definition: { name: string; description: string; instructions: string; config: unknown };
    toolCatalog: unknown;
    configHash: string;
    /** The ids `runsOn` resolved to (`resolveOrgAgentRunsOnInAccount`). */
    runsOnTarget?: OrgAgentRunsOnTarget | null;
    subjectId: string | null;
    /** Whether the caller may write (create the agent or add a version). */
    mayWrite: boolean;
  },
): Promise<InlineOrgAgentVersionResult> {
  return await withOrgAgentScope(db, input, async (tx) => {
    let agent = await agentByRef(tx, input.accountId, input.ref, true);
    if (!agent) {
      if (!("key" in input.ref)) return { outcome: "not_found" as const };
      if (!input.mayWrite) return { outcome: "forbidden" as const };
      const inserted = await rawRows<{ id: string }>(
        tx,
        sql`insert into agents (account_id, workspace_id, scope, visibility, name, name_key,
            description, current_revision, origin, agent_key, managed_by, created_by_subject_id)
          values (${input.accountId}::uuid, null, 'organization', 'workspace',
            ${input.definition.name}, ${input.definition.name.trim().toLowerCase()},
            ${input.definition.description}, 1, 'app', ${input.ref.key}, 'code',
            ${input.subjectId})
          on conflict (account_id, agent_key) where agent_key is not null do nothing
          returning id::text as id`,
      );
      agent = await agentByRef(tx, input.accountId, input.ref, true);
      if (!agent) throw new Error("Organization agent create raced with a delete");
      if (inserted.length > 0) {
        const version = await insertInlineVersion(tx, input, agent.id, 1);
        return { outcome: "created_agent" as const, agent, version };
      }
    }
    if (agent.archived) return { outcome: "archived" as const, agent };
    if (agent.managedBy !== "code") return { outcome: "managed_in_console" as const, agent };
    const [existing] = await rawRows<VersionRow>(
      tx,
      sql`select ${VERSION_COLUMNS}
        from agent_revisions r
        where r.account_id = ${input.accountId}::uuid and r.workspace_id is null
          and r.agent_id = ${agent.id}::uuid and r.config_hash = ${input.configHash}
        order by r.revision desc limit 1`,
    );
    if (existing) return { outcome: "reused" as const, agent, version: mapVersion(existing) };
    if (!input.mayWrite) return { outcome: "forbidden" as const };
    const next = agent.currentVersion + 1;
    const version = await insertInlineVersion(tx, input, agent.id, next);
    await tx.execute(
      sql`update agents set current_revision = ${next}::integer, version = version + 1,
          updated_at = now()
        where account_id = ${input.accountId}::uuid and id = ${agent.id}::uuid`,
    );
    return {
      outcome: "created_version" as const,
      agent: { ...agent, currentVersion: next },
      version,
    };
  });
}

async function insertInlineVersion(
  tx: Database,
  input: {
    accountId: string;
    definition: { name: string; description: string; instructions: string; config: unknown };
    toolCatalog: unknown;
    configHash: string;
    runsOnTarget?: OrgAgentRunsOnTarget | null;
    subjectId: string | null;
  },
  agentId: string,
  revision: number,
): Promise<OrgAgentRuntimeVersion> {
  const [row] = await rawRows<VersionRow>(
    tx,
    sql`insert into agent_revisions as r (agent_id, account_id, workspace_id, revision, name,
        description, instructions, first_message, config, tool_catalog, source, config_hash,
        created_by_subject_id, runs_on_target)
      values (${agentId}::uuid, ${input.accountId}::uuid, null, ${revision}::integer,
        ${input.definition.name}, ${input.definition.description},
        ${input.definition.instructions}, '',
        ${JSON.stringify(input.definition.config)}::jsonb,
        ${JSON.stringify(input.toolCatalog ?? {})}::jsonb, 'inline', ${input.configHash},
        ${input.subjectId},
        ${input.runsOnTarget ? JSON.stringify(input.runsOnTarget) : null}::jsonb)
      returning ${VERSION_COLUMNS}`,
  );
  if (!row) throw new Error("Organization agent version insert returned nothing");
  return mapVersion(row);
}

/** The organization agent state a chat is pinned to. */
export type SessionOrgAgentState = {
  agentId: string;
  version: number;
  promptVersion: number | null;
  overrides: Record<string, { agent: unknown; chat: unknown }> | null;
};

/** The organization agent version a chat runs, or null for every other chat. */
export async function readSessionOrgAgentState(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<SessionOrgAgentState | null> {
  const [row] = await withoutSessionRlsActor(() =>
    withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, (tx) =>
      rawRows<{
        agent_id: string | null;
        agent_version: number | null;
        agent_prompt_version: number | null;
        agent_overrides: unknown;
      }>(
        tx,
        sql`select s.agent_id::text as agent_id, s.agent_version, s.agent_prompt_version,
            s.agent_overrides
          from sessions s
          where s.workspace_id = ${input.workspaceId}::uuid and s.id = ${input.sessionId}::uuid`,
      ),
    ),
  );
  if (!row || row.agent_version === null || row.agent_version === undefined || !row.agent_id)
    return null;
  return {
    agentId: row.agent_id,
    version: Number(row.agent_version),
    promptVersion:
      row.agent_prompt_version === null || row.agent_prompt_version === undefined
        ? null
        : Number(row.agent_prompt_version),
    overrides:
      row.agent_overrides && typeof row.agent_overrides === "object"
        ? (row.agent_overrides as SessionOrgAgentState["overrides"])
        : null,
  };
}

/** What a child chat records when its parent runs an organization agent. */
export type InheritedSessionOrgAgent = {
  agentId: string;
  version: number;
  /** Null unless the version's `workers.shareInstructions` is on: no agent layer. */
  promptVersion: number | null;
  overrides: Record<string, { agent: unknown; chat: unknown }> | null;
};

/** Whether a version config shares the agent's Instructions with worker chats. */
export function orgAgentConfigSharesInstructions(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const workers = (config as Record<string, unknown>)["workers"];
  return Boolean(
    workers &&
    typeof workers === "object" &&
    (workers as Record<string, unknown>)["shareInstructions"] === true,
  );
}

/**
 * The organization agent a child chat inherits from its parent, read in the
 * create transaction: the parent's agent and version, and the version's
 * Instructions only when it shares them with workers. Null when the parent
 * runs no organization agent (every other chat).
 */
export async function inheritedSessionOrgAgentInTransaction(
  tx: Database,
  input: { accountId: string; workspaceId: string; parentSessionId: string },
): Promise<InheritedSessionOrgAgent | null> {
  const [parent] = await rawRows<{
    agent_id: string | null;
    agent_version: number | null;
    agent_overrides: unknown;
  }>(
    tx,
    sql`select s.agent_id::text as agent_id, s.agent_version, s.agent_overrides
      from sessions s
      where s.workspace_id = ${input.workspaceId}::uuid
        and s.id = ${input.parentSessionId}::uuid`,
  );
  if (!parent?.agent_id || parent.agent_version === null || parent.agent_version === undefined)
    return null;
  const version = Number(parent.agent_version);
  const row = await withOrgAgentsVisible(tx, () =>
    readOrgAgentVersionInTransaction(tx, {
      accountId: input.accountId,
      agentId: parent.agent_id!,
      version,
    }),
  );
  return {
    agentId: parent.agent_id,
    version,
    promptVersion: row && orgAgentConfigSharesInstructions(row.config) ? version : null,
    overrides:
      parent.agent_overrides && typeof parent.agent_overrides === "object"
        ? (parent.agent_overrides as InheritedSessionOrgAgent["overrides"])
        : null,
  };
}

/** Keys of these organization agents, read in an existing scoped transaction. */
export async function readOrgAgentKeysInTransaction(
  tx: Database,
  accountId: string,
  agentIds: readonly string[],
): Promise<Map<string, string>> {
  if (agentIds.length === 0) return new Map();
  const rows = await withOrgAgentsVisible(tx, () =>
    rawRows<{ id: string; agent_key: string }>(
      tx,
      sql`select a.id::text as id, a.agent_key from agents a
        where a.account_id = ${accountId}::uuid and a.scope = 'organization'
          and a.id = any(${pgUuidArray(agentIds)}::uuid[])`,
    ),
  );
  return new Map(rows.map((row) => [row.id, row.agent_key]));
}

/* ------------------------------------------------------------- end-user logins */

export type EndUserToolCredentialRow = {
  id: string;
  kind: "headers" | "oauth";
  materialEncrypted: string;
  expiresAt: Date | null;
  refreshFailedAt: Date | null;
  version: number;
};

type CredentialRow = {
  id: string;
  kind: string;
  material_encrypted: string;
  expires_at: Date | string | null;
  refresh_failed_at: Date | string | null;
  version: number;
};

function mapCredential(row: CredentialRow): EndUserToolCredentialRow {
  return {
    id: row.id,
    kind: row.kind === "oauth" ? "oauth" : "headers",
    materialEncrypted: row.material_encrypted,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    refreshFailedAt: row.refresh_failed_at ? new Date(row.refresh_failed_at) : null,
    version: Number(row.version),
  };
}

const CREDENTIAL_COLUMNS = sql`c.id::text as id, c.kind, c.material_encrypted, c.expires_at,
  c.refresh_failed_at, c.version`;

/** One end user's stored login for an organization tool server in a workspace. */
export async function readEndUserToolCredential(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string; toolServerId: string },
): Promise<EndUserToolCredentialRow | null> {
  const [row] = await withoutSessionRlsActor(() =>
    withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, (tx) =>
      rawRows<CredentialRow>(
        tx,
        sql`select ${CREDENTIAL_COLUMNS}
          from end_user_tool_credentials c
          where c.account_id = ${input.accountId}::uuid
            and c.workspace_id = ${input.workspaceId}::uuid
            and c.end_user_subject_id = ${input.subjectId}
            and c.tool_server_id = ${input.toolServerId}::uuid`,
      ),
    ),
  );
  return row ? mapCredential(row) : null;
}

/**
 * Refresh one stored OAuth login under its row lock. Returns `locked` when
 * another worker holds the row (SKIP LOCKED): re-read it shortly. `refresh`
 * runs while the row is locked; it returns the new encrypted material and
 * expiry, or null when the provider refused (recorded in `refresh_failed_at`).
 * A row another worker already refreshed is returned as `current`.
 */
export async function refreshEndUserToolCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    credentialId: string;
    /** Refresh only while the stored expiry is before this. */
    refreshBefore: Date;
    refresh: (
      current: EndUserToolCredentialRow,
    ) => Promise<{ materialEncrypted: string; expiresAt: Date | null } | null>;
  },
): Promise<
  | { outcome: "locked" | "missing" }
  | { outcome: "refreshed" | "current" | "failed"; credential: EndUserToolCredentialRow }
> {
  return await withoutSessionRlsActor(() =>
    withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (tx) => {
        const [row] = await rawRows<CredentialRow>(
          tx,
          sql`select ${CREDENTIAL_COLUMNS}
          from end_user_tool_credentials c
          where c.account_id = ${input.accountId}::uuid
            and c.workspace_id = ${input.workspaceId}::uuid
            and c.id = ${input.credentialId}::uuid
          for update skip locked`,
        );
        if (!row) {
          const [exists] = await rawRows<{ found: number }>(
            tx,
            sql`select 1 as found from end_user_tool_credentials c
            where c.workspace_id = ${input.workspaceId}::uuid
              and c.id = ${input.credentialId}::uuid`,
          );
          return { outcome: exists ? ("locked" as const) : ("missing" as const) };
        }
        const current = mapCredential(row);
        if (!current.expiresAt || current.expiresAt > input.refreshBefore)
          return { outcome: "current" as const, credential: current };
        let refreshed: { materialEncrypted: string; expiresAt: Date | null } | null = null;
        try {
          refreshed = await input.refresh(current);
        } catch {
          refreshed = null;
        }
        if (!refreshed) {
          const [failed] = await rawRows<CredentialRow>(
            tx,
            sql`update end_user_tool_credentials c
            set refresh_failed_at = now(), updated_at = now()
            where c.workspace_id = ${input.workspaceId}::uuid
              and c.id = ${input.credentialId}::uuid
            returning ${CREDENTIAL_COLUMNS}`,
          );
          return { outcome: "failed" as const, credential: mapCredential(failed ?? row) };
        }
        const [updated] = await rawRows<CredentialRow>(
          tx,
          sql`update end_user_tool_credentials c
          set material_encrypted = ${refreshed.materialEncrypted},
            expires_at = ${refreshed.expiresAt ? refreshed.expiresAt.toISOString() : null}::timestamptz,
            refresh_failed_at = null, version = c.version + 1, updated_at = now(),
            last_used_at = now()
          where c.workspace_id = ${input.workspaceId}::uuid
            and c.id = ${input.credentialId}::uuid
          returning ${CREDENTIAL_COLUMNS}`,
        );
        if (!updated) throw new Error("End-user tool login refresh lost its row");
        return { outcome: "refreshed" as const, credential: mapCredential(updated) };
      },
    ),
  );
}

/** Record that these stored logins were used for a turn. */
export async function markEndUserToolCredentialsUsed(
  db: Database,
  input: { accountId: string; workspaceId: string; credentialIds: readonly string[] },
): Promise<void> {
  if (input.credentialIds.length === 0) return;
  await withoutSessionRlsActor(() =>
    withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, (tx) =>
      tx.execute(
        sql`update end_user_tool_credentials set last_used_at = now()
          where workspace_id = ${input.workspaceId}::uuid
            and id = any(${pgUuidArray(input.credentialIds)}::uuid[])`,
      ),
    ),
  );
}

/* ---------------------------------------------------------- publish: move chats */

export type OrgAgentPublishOperationRow = {
  id: string;
  accountId: string;
  agentId: string;
  fromVersion: number | null;
  toVersion: number;
  moveRunningChats: boolean;
  status: "pending" | "running" | "succeeded" | "failed";
  movedCount: number;
  failedCount: number;
};

export async function readOrgAgentPublishOperation(
  db: Database,
  input: { accountId: string; operationId: string },
): Promise<OrgAgentPublishOperationRow | null> {
  const [row] = await withOrgAgentScope(
    db,
    { accountId: input.accountId, workspaceId: null },
    (tx) =>
      rawRows<{
        id: string;
        account_id: string;
        agent_id: string;
        from_revision: number | null;
        to_revision: number;
        move_running_chats: boolean;
        status: string;
        moved_count: number;
        failed_count: number;
      }>(
        tx,
        sql`select o.id::text as id, o.account_id::text as account_id,
            o.agent_id::text as agent_id, o.from_revision, o.to_revision,
            o.move_running_chats, o.status, o.moved_count, o.failed_count
          from agent_publish_operations o
          where o.account_id = ${input.accountId}::uuid and o.id = ${input.operationId}::uuid`,
      ),
  );
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    agentId: row.agent_id,
    fromVersion: row.from_revision === null ? null : Number(row.from_revision),
    toVersion: Number(row.to_revision),
    moveRunningChats: Boolean(row.move_running_chats),
    status: row.status as OrgAgentPublishOperationRow["status"],
    movedCount: Number(row.moved_count),
    failedCount: Number(row.failed_count),
  };
}

/** Add to an operation's counts and, optionally, set its status. */
export async function updateOrgAgentPublishOperation(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    status?: "running" | "succeeded" | "failed";
    moved?: number;
    failed?: number;
  },
): Promise<void> {
  const finished = input.status === "succeeded" || input.status === "failed";
  await withOrgAgentScope(db, { accountId: input.accountId, workspaceId: null }, (tx) =>
    tx.execute(
      sql`update agent_publish_operations
        set moved_count = moved_count + ${input.moved ?? 0}::integer,
          failed_count = failed_count + ${input.failed ?? 0}::integer
          ${input.status ? sql`, status = ${input.status}` : sql``}
          ${finished ? sql`, finished_at = now()` : sql``}
        where account_id = ${input.accountId}::uuid and id = ${input.operationId}::uuid
          and status not in ('succeeded', 'failed')`,
    ),
  );
}

/** The agent's published version now (null when unpublished, archived or gone). */
export async function readOrgAgentPublishedVersion(
  db: Database,
  input: { accountId: string; agentId: string },
): Promise<number | null> {
  const agent = await withOrgAgentScope(
    db,
    { accountId: input.accountId, workspaceId: null },
    (tx) => agentByRef(tx, input.accountId, { id: input.agentId }),
  );
  return agent && !agent.archived ? agent.publishedVersion : null;
}

/**
 * Workspaces whose chats a publish may move: the organization's managed
 * workspaces (except its Console test workspace, whose chats try drafts) and
 * the workspaces the agent was added to.
 */
export async function listOrgAgentMoveWorkspaces(
  db: Database,
  input: { accountId: string; agentId: string },
): Promise<string[]> {
  const rows = await withOrgAgentScope(
    db,
    { accountId: input.accountId, workspaceId: null },
    (tx) =>
      rawRows<{ workspace_id: string }>(
        tx,
        sql`select m.workspace_id::text as workspace_id from organization_managed_workspaces m
            where m.account_id = ${input.accountId}::uuid and m.source <> 'console_test'
          union
          select w.workspace_id::text from agent_workspace_access w
            where w.account_id = ${input.accountId}::uuid and w.agent_id = ${input.agentId}::uuid
          order by 1`,
      ),
  );
  return rows.map((row) => row.workspace_id);
}

export type OrgAgentMoveCandidate = {
  sessionId: string;
  version: number;
  /** A turn is running or waits on a person (an approval or a question). */
  busy: boolean;
};

/** Chats in a workspace that run the agent on another version, in id order. */
export async function listOrgAgentMoveCandidates(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    agentId: string;
    toVersion: number;
    afterSessionId: string | null;
    limit: number;
  },
): Promise<OrgAgentMoveCandidate[]> {
  const rows = await withoutSessionRlsActor(() =>
    withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, (tx) =>
      rawRows<{ id: string; agent_version: number; busy: boolean }>(
        tx,
        sql`select s.id::text as id, s.agent_version,
            (s.active_turn_id is not null or s.status in ('running', 'requires_action')) as busy
          from sessions s
          where s.account_id = ${input.accountId}::uuid
            and s.workspace_id = ${input.workspaceId}::uuid
            and s.agent_id = ${input.agentId}::uuid
            and s.agent_version is not null
            and s.agent_version <> ${input.toVersion}::integer
            ${input.afterSessionId ? sql`and s.id > ${input.afterSessionId}::uuid` : sql``}
          order by s.id
          limit ${Math.max(1, Math.min(input.limit, 5_000))}`,
      ),
    ),
  );
  return rows.map((row) => ({
    sessionId: row.id,
    version: Number(row.agent_version),
    busy: Boolean(row.busy),
  }));
}
