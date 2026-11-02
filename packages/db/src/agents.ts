/**
 * Agents: reads and writes (docs/agents.md).
 *
 * An agent row belongs to its HOME workspace, where its chats run. Its
 * Instructions and First message are immutable revisions in the same
 * workspace; where it answers in Slack is one `agent_slack_installs` row per
 * Slack installation, also home-owned.
 *
 * Until the contract step every write here also keeps the legacy rows in
 * step, in the same transaction, for older binaries and for rollback: a
 * `bot_templates` row for an agent that came from a bot template, and a
 * `slack_agents` row (owned by the Slack installation's own workspace, and
 * the target of `slack_channel_routes`) for every Slack availability. The
 * transaction sets `opengeni.agents_dual_write` so the legacy sync triggers of
 * migration 1234 stay out of the way. Because `slack_agents.id` is the agent
 * id, an agent is available in at most one Slack installation until the
 * contract step.
 *
 * Authorization (who may read, change or enable what) is decided by callers
 * from live grants. Reads filter Only me agents explicitly; nothing here
 * grants anything.
 */
import { agentInitialsAvatar, slackAgentNameKey, type SessionAvatar } from "@opengeni/contracts";
import { sql, type SQL } from "drizzle-orm";

import { rawRows, withRlsContext, withWorkspaceRls, type Database } from "./database";
import { nestedErrorRecords, nestedPostgresSqlState } from "./persistence-errors";

export type AgentHome = { accountId: string; workspaceId: string };
export type AgentVisibilityValue = "private" | "workspace";
export type AgentOriginValue = "slack_agent" | "bot_template" | "app" | "slack";

/** The current revision's content, read from the agent's home workspace. */
export type AgentContent = {
  instructions: string;
  firstMessage: string;
  createdBySubjectId: string | null;
  createdAt: Date;
};

export type AgentRecord = {
  id: string;
  accountId: string;
  workspaceId: string;
  visibility: AgentVisibilityValue;
  ownerSubjectId: string | null;
  name: string;
  description: string;
  /** As stored; read it back through the contract's schema. */
  avatar: unknown;
  memoryEnabled: boolean;
  memoryCollectionId: string | null;
  currentRevision: number;
  origin: AgentOriginValue;
  sourceSessionId: string | null;
  createdBySubjectId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  hasFirstMessage: boolean;
  /** Null in lists and where the revision is not readable. */
  content: AgentContent | null;
};

export type AgentSlackInstallRecord = {
  id: string;
  agentId: string;
  accountId: string;
  /** The agent's home workspace. */
  workspaceId: string;
  connectionId: string;
  slackTeamId: string;
  nameKey: string;
  open: boolean;
  enabledBySubjectId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The Slack installation's own workspace (where the installation binding,
   * routes and the legacy row live). Read from the legacy row until the
   * contract step; null if it is missing.
   */
  installWorkspaceId: string | null;
};

export type AgentRevisionRecord = {
  revision: number;
  name: string;
  description: string;
  instructions: string;
  firstMessage: string;
  createdBySubjectId: string | null;
  createdAt: Date;
};

type AgentRow = {
  id: string;
  account_id: string;
  workspace_id: string;
  visibility: string;
  owner_subject_id: string | null;
  name: string;
  description: string;
  avatar: unknown;
  memory_enabled: boolean;
  memory_collection_id: string | null;
  current_revision: number;
  origin: string;
  source_session_id: string | null;
  created_by_subject_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  has_first_message?: boolean | null;
  instructions?: string | null;
  first_message?: string | null;
  revision_created_by_subject_id?: string | null;
  revision_created_at?: Date | string | null;
};

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapAgent(row: AgentRow, withContent: boolean): AgentRecord {
  const content =
    withContent &&
    typeof row.instructions === "string" &&
    typeof row.first_message === "string" &&
    row.revision_created_at
      ? {
          instructions: row.instructions,
          firstMessage: row.first_message,
          createdBySubjectId: row.revision_created_by_subject_id ?? null,
          createdAt: date(row.revision_created_at),
        }
      : null;
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    visibility: row.visibility === "private" ? "private" : "workspace",
    ownerSubjectId: row.owner_subject_id,
    name: row.name,
    description: row.description,
    avatar: row.avatar ?? null,
    memoryEnabled: row.memory_enabled,
    memoryCollectionId: row.memory_collection_id,
    currentRevision: Number(row.current_revision),
    origin: row.origin as AgentOriginValue,
    sourceSessionId: row.source_session_id,
    createdBySubjectId: row.created_by_subject_id,
    version: Number(row.version),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    hasFirstMessage: content ? content.firstMessage.length > 0 : row.has_first_message === true,
    content,
  };
}

type InstallRow = {
  id: string;
  agent_id: string;
  account_id: string;
  workspace_id: string;
  connection_id: string;
  slack_team_id: string;
  name_key: string;
  open: boolean;
  enabled_by_subject_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  install_workspace_id: string | null;
};

function mapInstall(row: InstallRow): AgentSlackInstallRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    slackTeamId: row.slack_team_id,
    nameKey: row.name_key,
    open: row.open,
    enabledBySubjectId: row.enabled_by_subject_id,
    version: Number(row.version),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    installWorkspaceId: row.install_workspace_id,
  };
}

const AGENT_COLUMNS = sql.raw(`a.id::text as id, a.account_id::text as account_id,
  a.workspace_id::text as workspace_id, a.visibility, a.owner_subject_id, a.name, a.description,
  a.avatar, a.memory_enabled, a.memory_collection_id::text as memory_collection_id,
  a.current_revision, a.origin, a.source_session_id::text as source_session_id,
  a.created_by_subject_id, a.version, a.created_at, a.updated_at`);

const INSTALL_COLUMNS = sql.raw(`i.id::text as id, i.agent_id::text as agent_id,
  i.account_id::text as account_id, i.workspace_id::text as workspace_id,
  i.connection_id::text as connection_id, i.slack_team_id, i.name_key, i.open,
  i.enabled_by_subject_id, i.version, i.created_at, i.updated_at,
  s.workspace_id::text as install_workspace_id`);

/** The legacy row joined for the installation's own workspace. */
const INSTALL_LEGACY_JOIN = sql.raw(
  `left join slack_agents s on s.id = i.agent_id and s.connection_id = i.connection_id`,
);

/** A unique violation's constraint name, or null for any other error. */
function uniqueViolation(error: unknown): string | null {
  if (nestedPostgresSqlState(error) !== "23505") return null;
  for (const record of nestedErrorRecords(error)) {
    const constraint = record["constraint"] ?? record["constraint_name"];
    if (typeof constraint === "string" && constraint.length > 0) return constraint;
  }
  return "";
}

function isSlackNameClash(constraint: string | null): boolean {
  return (
    constraint === "agent_slack_installs_name_key_uq" || constraint === "slack_agents_name_key_uq"
  );
}

/** The legacy sync triggers stand aside for the rest of this transaction. */
async function markDualWrite(tx: Database): Promise<void> {
  await tx.execute(sql`select set_config('opengeni.agents_dual_write', '1', true)`);
}

/**
 * The avatar a legacy Slack agent row needs (it cannot be empty): the
 * agent's own, or its initials.
 */
export function legacySlackAgentAvatar(agent: {
  id: string;
  name: string;
  avatar: unknown;
}): SessionAvatar {
  const avatar = agent.avatar;
  if (avatar && typeof avatar === "object" && !Array.isArray(avatar)) {
    return avatar as SessionAvatar;
  }
  return agentInitialsAvatar(agent.name, agent.id);
}

function viewerFilter(viewerSubjectId: string | null): SQL {
  return viewerSubjectId === null
    ? sql`a.visibility = 'workspace'`
    : sql`(a.visibility = 'workspace' or a.owner_subject_id = ${viewerSubjectId})`;
}

// --- Reads ---------------------------------------------------------------

/**
 * The home workspace's agents a reader sees, oldest first: the shared ones
 * and the reader's own Only me ones. `yours` keeps those the reader made or
 * owns.
 */
export async function listAgents(
  db: Database,
  home: AgentHome,
  input: {
    viewerSubjectId: string | null;
    filter?: "all" | "yours";
    /** Also read each current revision's content. */
    withContent?: boolean;
  },
): Promise<AgentRecord[]> {
  if (input.filter === "yours" && input.viewerSubjectId === null) return [];
  return await withRlsContext(db, home, async (tx) => {
    const rows = await rawRows<AgentRow>(
      tx,
      sql`select ${AGENT_COLUMNS}, coalesce(r.first_message <> '', false) as has_first_message
          ${
            input.withContent
              ? sql`, r.instructions, r.first_message,
                  r.created_by_subject_id as revision_created_by_subject_id,
                  r.created_at as revision_created_at`
              : sql``
          }
        from agents a
        left join agent_revisions r on r.agent_id = a.id and r.revision = a.current_revision
        where a.account_id = ${home.accountId}::uuid
          and a.workspace_id = ${home.workspaceId}::uuid
          and ${viewerFilter(input.viewerSubjectId)}
          ${
            input.filter === "yours"
              ? sql`and (a.created_by_subject_id = ${input.viewerSubjectId}
                  or a.owner_subject_id = ${input.viewerSubjectId})`
              : sql``
          }
        order by a.created_at, a.id`,
    );
    return rows.map((row) => mapAgent(row, input.withContent === true));
  });
}

/**
 * One agent of the home workspace with its current revision, or null. No
 * visibility filter: the caller decides who may see an Only me agent.
 */
export async function getAgent(
  db: Database,
  home: AgentHome,
  agentId: string,
): Promise<AgentRecord | null> {
  return await withRlsContext(db, home, async (tx) => {
    const [row] = await rawRows<AgentRow>(
      tx,
      sql`select ${AGENT_COLUMNS}, r.instructions, r.first_message,
          r.created_by_subject_id as revision_created_by_subject_id,
          r.created_at as revision_created_at
        from agents a
        left join agent_revisions r on r.agent_id = a.id and r.revision = a.current_revision
        where a.account_id = ${home.accountId}::uuid
          and a.workspace_id = ${home.workspaceId}::uuid
          and a.id = ${agentId}::uuid`,
    );
    return row ? mapAgent(row, true) : null;
  });
}

/** Where these agents of the home workspace are available in Slack. */
export async function listAgentSlackInstalls(
  db: Database,
  home: AgentHome,
  agentIds: readonly string[],
): Promise<AgentSlackInstallRecord[]> {
  if (agentIds.length === 0) return [];
  return await withRlsContext(db, home, async (tx) => {
    const rows = await rawRows<InstallRow>(
      tx,
      sql`select ${INSTALL_COLUMNS}
        from agent_slack_installs i
        ${INSTALL_LEGACY_JOIN}
        where i.account_id = ${home.accountId}::uuid
          and i.workspace_id = ${home.workspaceId}::uuid
          and i.agent_id = any(${sql`ARRAY[${sql.join(
            agentIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[]`})
        order by i.created_at, i.id`,
    );
    return rows.map(mapInstall);
  });
}

/** Saved revisions of an agent, newest first, older than `beforeRevision`. */
export async function listAgentRevisions(
  db: Database,
  home: AgentHome,
  input: { agentId: string; beforeRevision?: number | null; limit: number },
): Promise<AgentRevisionRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
  return await withRlsContext(db, home, async (tx) => {
    const rows = await rawRows<{
      revision: number;
      name: string;
      description: string;
      instructions: string;
      first_message: string;
      created_by_subject_id: string | null;
      created_at: Date | string;
    }>(
      tx,
      sql`select r.revision, r.name, r.description, r.instructions, r.first_message,
          r.created_by_subject_id, r.created_at
        from agent_revisions r
        where r.account_id = ${home.accountId}::uuid
          and r.workspace_id = ${home.workspaceId}::uuid
          and r.agent_id = ${input.agentId}::uuid
          ${input.beforeRevision ? sql`and r.revision < ${input.beforeRevision}::integer` : sql``}
        order by r.revision desc
        limit ${limit}`,
    );
    return rows.map((row) => ({
      revision: Number(row.revision),
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      firstMessage: row.first_message,
      createdBySubjectId: row.created_by_subject_id,
      createdAt: date(row.created_at),
    }));
  });
}

// --- Writes --------------------------------------------------------------

export type CreateAgentInput = {
  /** A fixed id makes a retried create find the agent it already made. */
  id?: string;
  visibility: AgentVisibilityValue;
  ownerSubjectId: string | null;
  name: string;
  description: string;
  avatar: SessionAvatar | null;
  instructions: string;
  firstMessage: string;
  memoryEnabled: boolean;
  origin: AgentOriginValue;
  sourceSessionId: string | null;
  createdBySubjectId: string | null;
  /** Also write the legacy `bot_templates` row (agents that came from one). */
  legacyBotTemplate?: boolean;
  /** Refuse past this many agents in the home workspace. */
  maxPerWorkspace: number;
};

/** Creating another agent would pass the workspace's limit. */
export class AgentLimitError extends Error {
  readonly name = "AgentLimitError";
  constructor(readonly limit: number) {
    super(`A workspace keeps at most ${limit} agents. Delete one to make another.`);
  }
}

/**
 * An Only me agent's owner must be someone the database knows as a member of
 * the organization (the private-agent policy reads memberships), like an Only
 * me chat's.
 */
export class AgentPrivateOwnerError extends Error {
  readonly name = "AgentPrivateOwnerError";
  constructor() {
    super("Only a member of the organization can keep an agent to themselves.");
  }
}

function privateOwnerRefusal(error: unknown, visibility: AgentVisibilityValue | undefined): never {
  if (visibility === "private" && nestedPostgresSqlState(error) === "42501") {
    throw new AgentPrivateOwnerError();
  }
  throw error;
}

async function insertAgentRows(tx: Database, home: AgentHome, input: CreateAgentInput) {
  const [row] = await rawRows<AgentRow>(
    tx,
    sql`insert into agents (${sql.raw(input.id ? "id, " : "")}account_id, workspace_id, visibility,
        owner_subject_id, name, name_key, description, avatar, memory_enabled, current_revision,
        origin, source_session_id, created_by_subject_id)
      values (${input.id ? sql`${input.id}::uuid, ` : sql``}${home.accountId}::uuid,
        ${home.workspaceId}::uuid, ${input.visibility}, ${input.ownerSubjectId}, ${input.name},
        lower(btrim(${input.name})), ${input.description},
        ${input.avatar === null ? sql`null` : sql`${JSON.stringify(input.avatar)}::jsonb`},
        ${input.memoryEnabled}, 1, ${input.origin}, ${input.sourceSessionId}::uuid,
        ${input.createdBySubjectId})
      returning ${sql.raw(`id::text as id, account_id::text as account_id,
        workspace_id::text as workspace_id, visibility, owner_subject_id, name, description, avatar,
        memory_enabled, memory_collection_id::text as memory_collection_id, current_revision,
        origin, source_session_id::text as source_session_id, created_by_subject_id, version,
        created_at, updated_at`)}`,
  );
  if (!row) throw new Error("Agent insert returned no row");
  const [revision] = await rawRows<{ created_at: Date | string }>(
    tx,
    sql`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
        description, instructions, first_message, created_by_subject_id)
      values (${row.id}::uuid, ${home.accountId}::uuid, ${home.workspaceId}::uuid, 1,
        ${input.name}, ${input.description}, ${input.instructions}, ${input.firstMessage},
        ${input.createdBySubjectId})
      returning created_at`,
  );
  if (input.legacyBotTemplate) {
    await tx.execute(sql`insert into bot_templates (id, account_id, workspace_id, name, description,
        avatar, setup_instructions, visibility, source_session_id, created_by_subject_id)
      values (${row.id}::uuid, ${home.accountId}::uuid, ${home.workspaceId}::uuid, ${input.name},
        ${input.description},
        ${input.avatar === null ? sql`null` : sql`${JSON.stringify(input.avatar)}::jsonb`},
        ${input.firstMessage}, ${input.visibility}, ${input.sourceSessionId}::uuid,
        ${input.visibility === "private" ? input.ownerSubjectId : input.createdBySubjectId})`);
  }
  return mapAgent(
    {
      ...row,
      instructions: input.instructions,
      first_message: input.firstMessage,
      revision_created_by_subject_id: input.createdBySubjectId,
      revision_created_at: revision?.created_at ?? new Date(),
    },
    true,
  );
}

async function lockAgentsOfWorkspace(tx: Database, home: AgentHome): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`agents:${home.workspaceId}`}, 0))`,
  );
}

async function countAgents(tx: Database, home: AgentHome): Promise<number> {
  const [count] = await rawRows<{ count: number }>(
    tx,
    sql`select count(*)::int as count from agents
      where account_id = ${home.accountId}::uuid and workspace_id = ${home.workspaceId}::uuid`,
  );
  return Number(count?.count ?? 0);
}

/**
 * Create an agent with revision 1. With a fixed id, a retry returns the agent
 * it already made (`created: false`), unchanged.
 */
export async function createAgent(
  db: Database,
  home: AgentHome,
  input: CreateAgentInput,
): Promise<{ agent: AgentRecord; created: boolean }> {
  return await withRlsContext(db, home, async (tx) => {
    await lockAgentsOfWorkspace(tx, home);
    if (input.id) {
      const existing = await getAgent(tx, home, input.id);
      if (existing) return { agent: existing, created: false };
    }
    if ((await countAgents(tx, home)) >= input.maxPerWorkspace) {
      throw new AgentLimitError(input.maxPerWorkspace);
    }
    await markDualWrite(tx);
    return { agent: await insertAgentRows(tx, home, input), created: true };
  }).catch((error: unknown) => privateOwnerRefusal(error, input.visibility));
}

export type AgentPatch = {
  name?: string;
  description?: string;
  avatar?: SessionAvatar | null;
  visibility?: AgentVisibilityValue;
  /** Required with `visibility`: the owner of an Only me agent, null otherwise. */
  ownerSubjectId?: string | null;
  instructions?: string;
  firstMessage?: string;
  memoryEnabled?: boolean;
  /** Forget the current Memory collection (for example after a visibility change). */
  clearMemoryCollection?: boolean;
};

export type UpdateAgentOutcome =
  | { kind: "updated"; agent: AgentRecord; revised: boolean }
  | { kind: "not_found" }
  | { kind: "version_conflict"; current: AgentRecord }
  /** The new name clashes with another agent in a Slack installation it is in. */
  | { kind: "slack_name_taken"; connectionId: string }
  /** The change would make an agent that is in Slack Only me. */
  | { kind: "requires_workspace_visibility" };

async function lockAgent(
  tx: Database,
  home: AgentHome,
  agentId: string,
): Promise<AgentRecord | null> {
  const [locked] = await rawRows<{ id: string }>(
    tx,
    sql`select id::text as id from agents
      where account_id = ${home.accountId}::uuid and workspace_id = ${home.workspaceId}::uuid
        and id = ${agentId}::uuid
      for update`,
  );
  return locked ? await getAgent(tx, home, agentId) : null;
}

/** The Slack installations an agent is in, with their own workspaces, inside a transaction. */
async function installsOf(
  tx: Database,
  home: AgentHome,
  agentId: string,
): Promise<AgentSlackInstallRecord[]> {
  return await listAgentSlackInstalls(tx, home, [agentId]);
}

/** Write the legacy Slack agent row of every installation the agent is in. */
async function syncLegacySlackRows(
  tx: Database,
  agent: AgentRecord,
  installs: readonly AgentSlackInstallRecord[],
  options: { bump?: boolean } = {},
): Promise<void> {
  const bump = options.bump ?? true;
  for (const install of installs) {
    if (!install.installWorkspaceId) continue;
    await withRlsContext(
      tx,
      { accountId: agent.accountId, workspaceId: install.installWorkspaceId },
      async (scoped) => {
        await scoped.execute(sql`update slack_agents set
            name = ${agent.name},
            name_key = ${install.nameKey},
            description = ${agent.description},
            avatar = ${JSON.stringify(legacySlackAgentAvatar(agent))}::jsonb,
            instructions = ${agent.content?.instructions ?? ""},
            knowledge_collection_id = ${agent.memoryEnabled ? agent.memoryCollectionId : null}::uuid,
            open = ${install.open},
            -- Never backwards: the legacy API shows the greater of the two
            -- versions (lockAgentLegacySlackVersion), so a version read from
            -- either API is accepted by the other during the rollout.
            version = greatest(${bump ? sql`version + 1` : sql`version`}, ${agent.version}::integer),
            updated_at = now()
          where id = ${agent.id}::uuid
            and workspace_id = ${install.installWorkspaceId}::uuid
            and connection_id = ${install.connectionId}::uuid`);
      },
    );
  }
}

/**
 * Change an agent at an expected version (null skips the check, for the
 * compatibility endpoints that never had one). Changing the Instructions or
 * First message adds a revision made by `actorSubjectId`; renaming an agent
 * that is in Slack renames its Slack handle too.
 */
export async function updateAgent(
  db: Database,
  home: AgentHome,
  input: {
    agentId: string;
    expectedVersion: number | null;
    patch: AgentPatch;
    actorSubjectId: string | null;
  },
): Promise<UpdateAgentOutcome> {
  try {
    return await withRlsContext(db, home, async (tx) => {
      const current = await lockAgent(tx, home, input.agentId);
      if (!current) return { kind: "not_found" as const };
      if (input.expectedVersion !== null && current.version !== input.expectedVersion) {
        return { kind: "version_conflict" as const, current };
      }
      const { patch } = input;
      const installs = await installsOf(tx, home, current.id);
      // Checked under the row lock: an agent in Slack is always shared.
      if (patch.visibility === "private" && installs.length > 0) {
        return { kind: "requires_workspace_visibility" as const };
      }
      await markDualWrite(tx);
      const name = patch.name ?? current.name;
      const instructions = patch.instructions ?? current.content?.instructions ?? "";
      const firstMessage = patch.firstMessage ?? current.content?.firstMessage ?? "";
      const revised =
        current.content === null ||
        instructions !== current.content.instructions ||
        firstMessage !== current.content.firstMessage;
      const nextRevision = revised ? current.currentRevision + 1 : current.currentRevision;
      const visibility = patch.visibility ?? current.visibility;
      const ownerSubjectId =
        patch.visibility !== undefined ? (patch.ownerSubjectId ?? null) : current.ownerSubjectId;
      const avatar = patch.avatar !== undefined ? patch.avatar : current.avatar;
      await tx.execute(sql`update agents set
          name = ${name},
          name_key = lower(btrim(${name})),
          description = ${patch.description ?? current.description},
          avatar = ${avatar === null ? sql`null` : sql`${JSON.stringify(avatar)}::jsonb`},
          visibility = ${visibility},
          owner_subject_id = ${ownerSubjectId},
          memory_enabled = ${patch.memoryEnabled ?? current.memoryEnabled},
          memory_collection_id = ${patch.clearMemoryCollection ? null : current.memoryCollectionId}::uuid,
          current_revision = ${nextRevision}::integer,
          version = version + 1,
          updated_at = now()
        where id = ${current.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
      if (revised) {
        await tx.execute(sql`insert into agent_revisions (agent_id, account_id, workspace_id,
            revision, name, description, instructions, first_message, created_by_subject_id)
          values (${current.id}::uuid, ${home.accountId}::uuid, ${home.workspaceId}::uuid,
            ${nextRevision}::integer, ${name}, ${patch.description ?? current.description},
            ${instructions}, ${firstMessage}, ${input.actorSubjectId})`);
      }
      if (
        patch.name !== undefined &&
        slackAgentNameKey(patch.name) !== slackAgentNameKey(current.name)
      ) {
        for (const install of installs) {
          try {
            await tx.execute(sql`update agent_slack_installs set
                name_key = ${slackAgentNameKey(name)}, version = version + 1, updated_at = now()
              where id = ${install.id}::uuid`);
          } catch (error) {
            if (isSlackNameClash(uniqueViolation(error))) {
              throw new SlackNameClash(install.connectionId);
            }
            throw error;
          }
          install.nameKey = slackAgentNameKey(name);
        }
      }
      const updated = await getAgent(tx, home, current.id);
      if (!updated) throw new Error("Agent update lost its row");
      if (current.origin === "bot_template") {
        // The legacy template: its setup text is the First message, and an
        // Only me template belongs to whoever saved it.
        await tx.execute(sql`update bot_templates set
            name = ${updated.name},
            description = ${updated.description},
            avatar = ${updated.avatar === null ? sql`null` : sql`${JSON.stringify(updated.avatar)}::jsonb`},
            setup_instructions = ${firstMessage},
            visibility = ${updated.visibility},
            created_by_subject_id = ${
              updated.visibility === "private" ? updated.ownerSubjectId : sql`created_by_subject_id`
            },
            updated_at = now()
          where id = ${updated.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
      }
      await syncLegacySlackRows(tx, updated, installs);
      return { kind: "updated" as const, agent: updated, revised };
    });
  } catch (error) {
    if (error instanceof SlackNameClash) {
      return { kind: "slack_name_taken", connectionId: error.connectionId };
    }
    if (isSlackNameClash(uniqueViolation(error))) {
      return { kind: "slack_name_taken", connectionId: "" };
    }
    return privateOwnerRefusal(error, input.patch.visibility);
  }
}

class SlackNameClash extends Error {
  constructor(readonly connectionId: string) {
    super("Slack name clash");
  }
}

/**
 * For the legacy Slack agents API during the rollout: lock the agent and
 * return the version that API shows, the greater of the agent's and its
 * legacy row's (the backfill did not copy legacy versions), raising the
 * agent's to match so versions only move forward. Null when not found.
 * Call inside the caller's transaction.
 */
export async function lockAgentLegacySlackVersion(
  tx: Database,
  home: AgentHome,
  input: { agentId: string; connectionId: string; installWorkspaceId: string },
): Promise<{ agentVersion: number; version: number } | null> {
  const agent = await lockAgent(tx, home, input.agentId);
  if (!agent) return null;
  const legacy = await withRlsContext(
    tx,
    { accountId: home.accountId, workspaceId: input.installWorkspaceId },
    async (scoped) =>
      (
        await rawRows<{ version: number }>(
          scoped,
          sql`select version from slack_agents
            where id = ${input.agentId}::uuid
              and workspace_id = ${input.installWorkspaceId}::uuid
              and connection_id = ${input.connectionId}::uuid
            for update`,
        )
      )[0]?.version ?? null,
  );
  const version = Math.max(agent.version, Number(legacy ?? 0));
  if (version > agent.version) {
    await markDualWrite(tx);
    await tx.execute(sql`update agents set version = ${version}::integer
      where id = ${agent.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
  }
  return { agentVersion: agent.version, version };
}

/** Remember the agent's Memory collection once it exists. Version-free and idempotent. */
export async function setAgentMemoryCollection(
  db: Database,
  home: AgentHome,
  input: { agentId: string; collectionId: string },
): Promise<AgentRecord | null> {
  return await withRlsContext(db, home, async (tx) => {
    const current = await lockAgent(tx, home, input.agentId);
    if (!current) return null;
    await markDualWrite(tx);
    await tx.execute(sql`update agents set memory_collection_id = ${input.collectionId}::uuid,
        updated_at = now()
      where id = ${current.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
    const updated = await getAgent(tx, home, current.id);
    if (!updated) return null;
    await syncLegacySlackRows(tx, updated, await installsOf(tx, home, current.id), {
      bump: false,
    });
    return updated;
  });
}

/**
 * Delete an agent, its revisions and Slack availability, and its legacy rows
 * (a Slack agent's channel settings go with it). Its chats stay.
 */
export async function deleteAgent(
  db: Database,
  home: AgentHome,
  agentId: string,
): Promise<boolean> {
  return await withRlsContext(db, home, async (tx) => {
    const current = await lockAgent(tx, home, agentId);
    if (!current) return false;
    await markDualWrite(tx);
    for (const install of await installsOf(tx, home, agentId)) {
      await deleteLegacySlackRow(tx, current.accountId, install);
    }
    await tx.execute(sql`delete from bot_templates
      where id = ${agentId}::uuid and workspace_id = ${home.workspaceId}::uuid`);
    await tx.execute(sql`delete from agents
      where id = ${agentId}::uuid and workspace_id = ${home.workspaceId}::uuid`);
    return true;
  });
}

async function deleteLegacySlackRow(
  tx: Database,
  accountId: string,
  install: AgentSlackInstallRecord,
): Promise<void> {
  if (!install.installWorkspaceId) return;
  await withRlsContext(
    tx,
    { accountId, workspaceId: install.installWorkspaceId },
    async (scoped) => {
      await scoped.execute(sql`delete from slack_agents
        where id = ${install.agentId}::uuid
          and workspace_id = ${install.installWorkspaceId}::uuid
          and connection_id = ${install.connectionId}::uuid`);
    },
  );
}

export type PutAgentSlackInstallOutcome =
  | { kind: "saved"; install: AgentSlackInstallRecord; agent: AgentRecord; created: boolean }
  | { kind: "not_found" }
  | { kind: "version_conflict"; install: AgentSlackInstallRecord }
  | { kind: "name_taken" }
  /** The agent is already available in another Slack installation. */
  | { kind: "single_install"; connectionId: string }
  /** An Only me agent cannot be in Slack. */
  | { kind: "requires_workspace_visibility" };

/**
 * Make an agent available in one Slack installation, or change its open
 * setting there. Also writes the legacy Slack agent row under the
 * installation's own workspace. Callers check the name rules, visibility and
 * permissions first.
 */
export async function putAgentSlackInstall(
  db: Database,
  home: AgentHome,
  input: {
    agentId: string;
    connectionId: string;
    slackTeamId: string;
    /** The installation's own workspace (its binding's workspace). */
    installWorkspaceId: string;
    open?: boolean;
    expectedVersion?: number;
    actorSubjectId: string;
  },
): Promise<PutAgentSlackInstallOutcome> {
  try {
    return await withRlsContext(db, home, async (tx) => {
      const agent = await lockAgent(tx, home, input.agentId);
      if (!agent) return { kind: "not_found" as const };
      // Checked under the row lock, so a concurrent change to Only me cannot
      // slip in between the caller's check and this write.
      if (agent.visibility !== "workspace") {
        return { kind: "requires_workspace_visibility" as const };
      }
      await markDualWrite(tx);
      const installs = await installsOf(tx, home, agent.id);
      const existing = installs.find((install) => install.connectionId === input.connectionId);
      const other = installs.find((install) => install.connectionId !== input.connectionId);
      if (!existing && other) {
        return { kind: "single_install" as const, connectionId: other.connectionId };
      }
      if (existing) {
        if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
          return { kind: "version_conflict" as const, install: existing };
        }
        if (input.open === undefined || input.open === existing.open) {
          return { kind: "saved" as const, install: existing, agent, created: false };
        }
        await tx.execute(sql`update agent_slack_installs set open = ${input.open},
            version = version + 1, updated_at = now()
          where id = ${existing.id}::uuid`);
        // The legacy API's version is the agent's.
        await tx.execute(sql`update agents set version = version + 1, updated_at = now()
          where id = ${agent.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
        const updated = (await getAgent(tx, home, agent.id)) ?? agent;
        const saved = (await installsOf(tx, home, agent.id)).find(
          (install) => install.id === existing.id,
        )!;
        await syncLegacySlackRows(tx, updated, [saved]);
        return { kind: "saved" as const, install: saved, agent: updated, created: false };
      }
      const nameKey = slackAgentNameKey(agent.name);
      await tx.execute(sql`insert into agent_slack_installs (agent_id, account_id, workspace_id,
          connection_id, slack_team_id, name_key, open, enabled_by_subject_id)
        values (${agent.id}::uuid, ${home.accountId}::uuid, ${home.workspaceId}::uuid,
          ${input.connectionId}::uuid, ${input.slackTeamId}, ${nameKey}, ${input.open ?? false},
          ${input.actorSubjectId})`);
      // Turning Slack on changes the agent, so a stale edit of it conflicts.
      await tx.execute(sql`update agents set version = version + 1, updated_at = now()
        where id = ${agent.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
      const enabled = (await getAgent(tx, home, agent.id)) ?? agent;
      await withRlsContext(
        tx,
        { accountId: home.accountId, workspaceId: input.installWorkspaceId },
        async (scoped) => {
          await scoped.execute(sql`insert into slack_agents (id, account_id, workspace_id,
              connection_id, slack_team_id, target_account_id, target_workspace_id, name, name_key,
              description, avatar, instructions, knowledge_collection_id, open,
              created_by_subject_id, version)
            values (${agent.id}::uuid, ${home.accountId}::uuid, ${input.installWorkspaceId}::uuid,
              ${input.connectionId}::uuid, ${input.slackTeamId}, ${home.accountId}::uuid,
              ${home.workspaceId}::uuid, ${agent.name}, ${nameKey}, ${agent.description},
              ${JSON.stringify(legacySlackAgentAvatar(agent))}::jsonb,
              ${agent.content?.instructions ?? ""},
              ${agent.memoryEnabled ? agent.memoryCollectionId : null}::uuid,
              ${input.open ?? false},
              ${agent.createdBySubjectId ?? input.actorSubjectId}, ${enabled.version}::integer)`);
        },
      );
      const saved = (await installsOf(tx, home, agent.id)).find(
        (install) => install.connectionId === input.connectionId,
      );
      if (!saved) throw new Error("Agent Slack availability insert returned no row");
      return { kind: "saved" as const, install: saved, agent: enabled, created: true };
    });
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (isSlackNameClash(constraint)) return { kind: "name_taken" };
    if (constraint === "slack_agents_pkey") {
      // A legacy row with this id already exists elsewhere: treat it as the
      // one installation the agent may be in.
      return { kind: "single_install", connectionId: "" };
    }
    throw error;
  }
}

/** Stop an agent answering in one Slack installation. The agent and its chats stay. */
export async function deleteAgentSlackInstall(
  db: Database,
  home: AgentHome,
  input: { agentId: string; connectionId: string },
): Promise<boolean> {
  return await withRlsContext(db, home, async (tx) => {
    const agent = await lockAgent(tx, home, input.agentId);
    if (!agent) return false;
    const install = (await installsOf(tx, home, agent.id)).find(
      (candidate) => candidate.connectionId === input.connectionId,
    );
    if (!install) return false;
    await markDualWrite(tx);
    await deleteLegacySlackRow(tx, home.accountId, install);
    await tx.execute(sql`delete from agent_slack_installs where id = ${install.id}::uuid`);
    await tx.execute(sql`update agents set version = version + 1, updated_at = now()
      where id = ${agent.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
    return true;
  });
}

// --- Chats ---------------------------------------------------------------

export type AgentChatRecord = {
  sessionId: string;
  title: string | null;
  visibility: "private" | "workspace";
  createdBySubjectId: string | null;
  ownerSubjectId: string | null;
  slack: {
    connectionId: string;
    channelId: string;
    threadTs: string;
    initiatingSlackUserId: string | null;
  } | null;
  createdAt: Date;
  /** `created_at` to the microsecond, for a keyset cursor. */
  cursorAt: string;
  updatedAt: Date;
};

/**
 * An agent's chats in its home workspace, newest first: chats bound to it
 * (`sessions.agent_id`), plus chats an older release started for it in Slack
 * that only its Slack interaction names. Only me chats and Slack DMs are listed
 * only to their owner; `yours` keeps the reader's own chats; `sharedOnly` lists
 * neither (for an agent's other chats).
 */
export async function listAgentChats(
  db: Database,
  home: AgentHome,
  input: {
    agentId: string;
    viewerSubjectId: string | null;
    filter: "yours" | "everyone";
    sharedOnly?: boolean;
    excludeSessionId?: string | null;
    /** Keyset cursor: chats created before this one (`cursorAt` of the last chat read). */
    before?: { createdAt: string; sessionId: string } | null;
    limit: number;
  },
): Promise<AgentChatRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
  if (input.filter === "yours" && input.viewerSubjectId === null) return [];
  const viewer = input.viewerSubjectId;
  return await withRlsContext(db, home, async (tx) => {
    const rows = await rawRows<{
      id: string;
      title: string | null;
      visibility: string;
      created_by_subject_id: string | null;
      owner_subject_id: string | null;
      created_at: Date | string;
      created_at_exact: string;
      updated_at: Date | string;
      connection_id: string | null;
      slack_channel_id: string | null;
      slack_thread_ts: string | null;
      initiating_slack_user_id: string | null;
      slack_private: boolean;
    }>(
      tx,
      sql`with bound as (
          select s.id from sessions s
          where s.workspace_id = ${home.workspaceId}::uuid and s.agent_id = ${input.agentId}::uuid
          union
          select i.session_id from slack_interactions i
          join sessions s on s.id = i.session_id and s.workspace_id = i.workspace_id
          where i.workspace_id = ${home.workspaceId}::uuid
            and i.slack_agent_id = ${input.agentId}::uuid
            and i.session_id is not null
            and s.agent_id is null
        )
        select s.id::text as id, s.title, s.visibility, s.created_by_subject_id,
          s.owner_subject_id, s.created_at, s.updated_at,
          to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_exact,
          si.connection_id::text as connection_id, si.slack_channel_id, si.slack_thread_ts,
          si.initiating_slack_user_id, dm.owning_subject_id is not null as slack_private
        from bound b
        join sessions s on s.id = b.id and s.workspace_id = ${home.workspaceId}::uuid
        left join lateral (
          select i.connection_id, i.slack_channel_id, i.slack_thread_ts, i.initiating_slack_user_id
          from slack_interactions i
          where i.workspace_id = s.workspace_id and i.session_id = s.id
          order by i.created_at, i.id
          limit 1
        ) si on true
        -- A Slack DM is private through its interaction, not the session row
        -- (docs/slack-bot.md): only the person it belongs to sees it listed.
        left join lateral (
          select p.owning_subject_id
          from slack_interactions p
          where p.workspace_id = s.workspace_id
            and p.session_reservation_id = s.root_session_id
            and p.visibility = 'private'
          order by p.created_at, p.id
          limit 1
        ) dm on true
        where s.archived_at is null
          and s.parent_session_id is null
          -- A Site viewer's chat belongs to the Site's audience, not the workspace.
          and s.site_access_root_id is null
          and ${
            input.sharedOnly || viewer === null
              ? sql`s.visibility = 'workspace_shared' and dm.owning_subject_id is null`
              : sql`((s.visibility = 'workspace_shared' and dm.owning_subject_id is null)
                  or (s.visibility = 'user_private' and s.owner_subject_id = ${viewer})
                  or dm.owning_subject_id = ${viewer})`
          }
          ${
            input.filter === "yours"
              ? sql`and (s.owner_subject_id = ${viewer} or s.created_by_subject_id = ${viewer}
                  or dm.owning_subject_id = ${viewer})`
              : sql``
          }
          ${input.excludeSessionId ? sql`and s.id <> ${input.excludeSessionId}::uuid` : sql``}
          ${
            input.before
              ? sql`and (s.created_at, s.id) < (${input.before.createdAt}::timestamptz, ${input.before.sessionId}::uuid)`
              : sql``
          }
        order by s.created_at desc, s.id desc
        limit ${limit}`,
    );
    return rows.map((row) => ({
      sessionId: row.id,
      title: row.title,
      visibility: row.visibility === "user_private" || row.slack_private ? "private" : "workspace",
      createdBySubjectId: row.created_by_subject_id,
      ownerSubjectId: row.owner_subject_id,
      slack:
        row.connection_id && row.slack_channel_id && row.slack_thread_ts
          ? {
              connectionId: row.connection_id,
              channelId: row.slack_channel_id,
              threadTs: row.slack_thread_ts,
              initiatingSlackUserId: row.initiating_slack_user_id,
            }
          : null,
      createdAt: date(row.created_at),
      cursorAt: row.created_at_exact,
      updatedAt: date(row.updated_at),
    }));
  });
}

/**
 * The agent a chat was started with: `sessions.agent_id`, or for a chat an
 * older release started in Slack, the agent its Slack interaction names.
 * Null for an ordinary chat.
 */
export async function getSessionAgentId(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<string | null> {
  return (await readSessionAgentRef(db, input))?.agentId ?? null;
}

/**
 * Whether a chat is bound to an Only me agent, whose chats stay Only me
 * (making one shared would hand its private Instructions to others).
 */
export async function sessionAgentRequiresPrivateChat(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<boolean> {
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [row] = await rawRows<{ found: number }>(
      tx,
      sql`select 1 as found
        from sessions s
        join agents a on a.workspace_id = s.workspace_id and a.id = s.agent_id
        where s.workspace_id = ${input.workspaceId}::uuid and s.id = ${input.sessionId}::uuid
          and a.visibility = 'private'`,
    );
    return row !== undefined;
  });
}

/**
 * SQL for a chat's agent id: its binding, else (for a chat an older release
 * started in Slack) its Slack interaction's agent. Never the free-form
 * metadata a caller can set on create.
 */
function sessionAgentIdSql(session: SQL): SQL {
  return sql`coalesce(${session}.agent_id, (
    select i.slack_agent_id from slack_interactions i
    where i.workspace_id = ${session}.workspace_id and i.session_id = ${session}.id
      and i.slack_agent_id is not null
    order by i.created_at, i.id limit 1))`;
}

async function readSessionAgentRef(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<{ accountId: string; agentId: string | null; agentChat: boolean } | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [row] = await rawRows<{
      account_id: string;
      agent_id: string | null;
      named: boolean;
    }>(
      tx,
      sql`select s.account_id::text as account_id,
          ${sessionAgentIdSql(sql.raw("s"))}::text as agent_id,
          (s.metadata -> 'slackAgent') is not null as named
        from sessions s
        where s.workspace_id = ${input.workspaceId}::uuid and s.id = ${input.sessionId}::uuid`,
    );
    if (!row) return null;
    // The metadata only says an older release started it for an agent (so a
    // chat whose agent is gone posts as Opengeni); it never names the agent.
    if (!row.agent_id && !row.named) return null;
    return { accountId: row.account_id, agentId: row.agent_id, agentChat: true };
  });
}

// --- Slack projections ---------------------------------------------------

/**
 * An agent as the Slack pipeline sees it in one installation: the shape the
 * Slack agent code was written against, read from the agents tables.
 * `accountId`/`workspaceId` are the installation's own (home) tenancy;
 * `targetWorkspaceId` is the agent's home workspace, where its chats run.
 */
export type SlackAgentProjection = {
  id: string;
  accountId: string;
  workspaceId: string;
  connectionId: string;
  slackTeamId: string;
  targetAccountId: string;
  targetWorkspaceId: string;
  name: string;
  nameKey: string;
  description: string;
  avatar: SessionAvatar;
  /** "" when the reader's workspace cannot read the agent's revisions. */
  instructions: string;
  /** Null while Memory is off. */
  knowledgeCollectionId: string | null;
  open: boolean;
  createdBySubjectId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type ProjectionRow = InstallRow & {
  agent_account_id: string;
  agent_workspace_id: string;
  name: string;
  description: string;
  avatar: unknown;
  memory_enabled: boolean;
  memory_collection_id: string | null;
  agent_created_by_subject_id: string | null;
  agent_version: number;
  agent_created_at: Date | string;
  agent_updated_at: Date | string;
  instructions: string | null;
};

function mapProjection(row: ProjectionRow, fallbackHome: string | null): SlackAgentProjection {
  return {
    id: row.agent_id,
    accountId: row.account_id,
    workspaceId: row.install_workspace_id ?? fallbackHome ?? row.agent_workspace_id,
    connectionId: row.connection_id,
    slackTeamId: row.slack_team_id,
    targetAccountId: row.agent_account_id,
    targetWorkspaceId: row.agent_workspace_id,
    name: row.name,
    nameKey: row.name_key,
    description: row.description,
    avatar: legacySlackAgentAvatar({ id: row.agent_id, name: row.name, avatar: row.avatar }),
    instructions: row.instructions ?? "",
    knowledgeCollectionId: row.memory_enabled ? row.memory_collection_id : null,
    open: row.open,
    createdBySubjectId: row.agent_created_by_subject_id ?? row.enabled_by_subject_id ?? "",
    version: Number(row.agent_version),
    createdAt: date(row.agent_created_at),
    updatedAt: date(row.agent_updated_at),
  };
}

/**
 * Fill in the Instructions of projections whose revisions their reader's
 * workspace could not read: one read per agent home workspace.
 */
async function withProjectionInstructions(
  db: Database,
  accountId: string,
  projections: SlackAgentProjection[],
  readable: ReadonlySet<string>,
): Promise<SlackAgentProjection[]> {
  const byHome = new Map<string, SlackAgentProjection[]>();
  for (const projection of projections) {
    if (readable.has(projection.id)) continue;
    const list = byHome.get(projection.targetWorkspaceId) ?? [];
    list.push(projection);
    byHome.set(projection.targetWorkspaceId, list);
  }
  for (const [workspaceId, list] of byHome) {
    const instructions = await withRlsContext(db, { accountId, workspaceId }, async (tx) => {
      const rows = await rawRows<{ agent_id: string; instructions: string }>(
        tx,
        sql`select a.id::text as agent_id, r.instructions
          from agents a
          join agent_revisions r on r.agent_id = a.id and r.revision = a.current_revision
          where a.workspace_id = ${workspaceId}::uuid
            and a.id = any(${sql`ARRAY[${sql.join(
              list.map((projection) => sql`${projection.id}::uuid`),
              sql`, `,
            )}]::uuid[]`})`,
      );
      return new Map(rows.map((row) => [row.agent_id, row.instructions]));
    });
    for (const projection of list) {
      projection.instructions = instructions.get(projection.id) ?? "";
    }
  }
  return projections;
}

function readableIds(rows: readonly ProjectionRow[]): Set<string> {
  return new Set(rows.filter((row) => row.instructions !== null).map((row) => row.agent_id));
}

function projectionQuery(where: SQL): SQL {
  return sql`select ${INSTALL_COLUMNS},
      a.account_id::text as agent_account_id, a.workspace_id::text as agent_workspace_id,
      a.name, a.description, a.avatar, a.memory_enabled,
      a.memory_collection_id::text as memory_collection_id,
      a.created_by_subject_id as agent_created_by_subject_id,
      -- The legacy API's version during the rollout (see lockAgentLegacySlackVersion).
      greatest(a.version, coalesce(s.version, 0)) as agent_version,
      a.created_at as agent_created_at, a.updated_at as agent_updated_at,
      r.instructions
    from agent_slack_installs i
    join agents a on a.id = i.agent_id and a.account_id = i.account_id
    left join agent_revisions r on r.agent_id = a.id and r.revision = a.current_revision
    ${INSTALL_LEGACY_JOIN}
    where a.visibility = 'workspace' and ${where}`;
}

function compareProjections(left: SlackAgentProjection, right: SlackAgentProjection): number {
  if (left.nameKey !== right.nameKey) return left.nameKey < right.nameKey ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * The agents one Slack installation answers to, read from its own workspace,
 * by name. An installation with none stays one indexed read.
 */
export async function listSlackAgentProjectionsForConnection(
  db: Database,
  installHome: AgentHome,
  connectionId: string,
): Promise<SlackAgentProjection[]> {
  return await withRlsContext(db, installHome, async (tx) => {
    const rows = await rawRows<ProjectionRow>(
      tx,
      projectionQuery(
        sql`i.account_id = ${installHome.accountId}::uuid and i.connection_id = ${connectionId}::uuid`,
      ),
    );
    if (rows.length === 0) return [];
    const projections = rows
      .map((row) => mapProjection(row, installHome.workspaceId))
      .filter((agent) => agent.workspaceId === installHome.workspaceId);
    return (
      await withProjectionInstructions(tx, installHome.accountId, projections, readableIds(rows))
    ).sort(compareProjections);
  });
}

/** Every Slack-available agent of an organization, by name. */
export async function listOrganizationSlackAgentProjections(
  db: Database,
  input: { accountId: string },
): Promise<SlackAgentProjection[]> {
  return await withRlsContext(db, { accountId: input.accountId }, async (tx) => {
    const rows = await rawRows<ProjectionRow>(
      tx,
      projectionQuery(sql`i.account_id = ${input.accountId}::uuid`),
    );
    const projections = rows.map((row) => mapProjection(row, null));
    return (
      await withProjectionInstructions(tx, input.accountId, projections, readableIds(rows))
    ).sort(compareProjections);
  });
}

/** One Slack-available agent of an organization by id, or null. */
export async function getSlackAgentProjection(
  db: Database,
  input: { accountId: string; agentId: string },
): Promise<SlackAgentProjection | null> {
  return await withRlsContext(db, { accountId: input.accountId }, async (tx) => {
    const rows = await rawRows<ProjectionRow>(
      tx,
      projectionQuery(
        sql`i.account_id = ${input.accountId}::uuid and i.agent_id = ${input.agentId}::uuid
          order by i.created_at limit 1`,
      ),
    );
    const [projection] = await withProjectionInstructions(
      tx,
      input.accountId,
      rows.map((row) => mapProjection(row, null)),
      readableIds(rows),
    );
    return projection ?? null;
  });
}

/**
 * The agent a chat was started with, read from the chat's workspace (the
 * agent's home). `agentChat` stays true when the agent was deleted since, so
 * callers can post as plain Opengeni rather than as the chat's own title.
 */
export async function getSessionAgent(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<{ agentChat: boolean; agent: AgentRecord | null }> {
  const ref = await readSessionAgentRef(db, input);
  if (!ref) return { agentChat: false, agent: null };
  return {
    agentChat: true,
    agent: ref.agentId
      ? await getAgent(
          db,
          { accountId: ref.accountId, workspaceId: input.workspaceId },
          ref.agentId,
        )
      : null,
  };
}
