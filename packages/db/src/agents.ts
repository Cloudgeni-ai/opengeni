/**
 * Agents: reads and writes (docs/agents.md).
 *
 * An agent row belongs to its HOME workspace, where its chats run. Its
 * Instructions and First message are immutable revisions in the same
 * workspace; where it answers in Slack is one `agent_slack_installs` row per
 * Slack installation, also home-owned, recording the installation's own
 * workspace (`install_workspace_id`). An agent may be in any number of Slack
 * installations; the Slack tables (channel routes, interactions, user states,
 * proposals, intro records, suggestions) point at its installation row.
 *
 * The legacy `bot_templates` and `slack_agents` tables are gone (the contract,
 * migrations 1380 to 1399, and the legacy drop, 1407 to 1417).
 *
 * Authorization (who may read, change or enable what) is decided by callers
 * from live grants. Reads filter Only me agents explicitly; nothing here
 * grants anything.
 */
import {
  agentInitialsAvatar,
  agentInstructionsWithFirstMessage,
  slackAgentNameKey,
  type SessionAvatar,
} from "@opengeni/contracts";
import { sql, type SQL } from "drizzle-orm";

import { rawRows, withRlsContext, withWorkspaceRls, type Database } from "./database";
import { nestedErrorRecords, nestedPostgresSqlState } from "./persistence-errors";

export type AgentHome = { accountId: string; workspaceId: string };
export type AgentVisibilityValue = "private" | "workspace";
export type AgentOriginValue = "slack_agent" | "bot_template" | "app" | "slack";

/** The current revision's content, read from the agent's home workspace. */
export type AgentContent = {
  instructions: string;
  createdBySubjectId: string | null;
  createdAt: Date;
};

/**
 * Agents have one text, their Instructions. A First message an older client
 * or the previous release sends joins them as its own paragraph
 * (`agentInstructionsWithFirstMessage`); since migration 1422 every stored
 * revision is that way, and nothing here reads `first_message` (kept, empty,
 * for the previous release until a later step drops it).
 */
function joinedInstructions(instructions: string, firstMessage: string | undefined): string {
  return agentInstructionsWithFirstMessage(instructions, firstMessage ?? "");
}

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
  /**
   * Who can use it: anyone in the organization from chat integrations, not
   * only the workspace. Always false for an Only me agent. The only source
   * since migration 1418; each Slack installation's `open` is kept equal to
   * it for the previous release, which still reads that.
   */
  organizationAccess: boolean;
  currentRevision: number;
  origin: AgentOriginValue;
  sourceSessionId: string | null;
  createdBySubjectId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
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
   * The Slack installation's own workspace (where the installation binding
   * and its routes live).
   */
  installWorkspaceId: string;
};

export type AgentRevisionRecord = {
  revision: number;
  name: string;
  description: string;
  instructions: string;
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
  organization_access?: boolean | null;
  current_revision: number;
  origin: string;
  source_session_id: string | null;
  created_by_subject_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  instructions?: string | null;
  revision_created_by_subject_id?: string | null;
  revision_created_at?: Date | string | null;
};

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapAgent(row: AgentRow, withContent: boolean): AgentRecord {
  const content =
    withContent && typeof row.instructions === "string" && row.revision_created_at
      ? {
          instructions: row.instructions,
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
    organizationAccess: row.visibility !== "private" && row.organization_access === true,
    currentRevision: Number(row.current_revision),
    origin: row.origin as AgentOriginValue,
    sourceSessionId: row.source_session_id,
    createdBySubjectId: row.created_by_subject_id,
    version: Number(row.version),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
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
  install_workspace_id: string;
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
  a.organization_access,
  a.current_revision, a.origin, a.source_session_id::text as source_session_id,
  a.created_by_subject_id, a.version, a.created_at, a.updated_at`);

const INSTALL_COLUMNS = sql.raw(`i.id::text as id, i.agent_id::text as agent_id,
  i.account_id::text as account_id, i.workspace_id::text as workspace_id,
  i.connection_id::text as connection_id, i.slack_team_id, i.name_key, i.open,
  i.enabled_by_subject_id, i.version, i.created_at, i.updated_at,
  i.install_workspace_id::text as install_workspace_id`);

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
  return constraint === "agent_slack_installs_name_key_uq";
}

/**
 * The avatar an agent posts with in Slack (it cannot be empty): the agent's
 * own, or its initials.
 */
export function agentSlackAvatar(agent: {
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
      sql`select ${AGENT_COLUMNS}
          ${
            input.withContent
              ? sql`, r.instructions,
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
      sql`select ${AGENT_COLUMNS}, r.instructions,
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
      created_by_subject_id: string | null;
      created_at: Date | string;
    }>(
      tx,
      sql`select r.revision, r.name, r.description, r.instructions,
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
  /** Older field: joins the Instructions as its own paragraph. */
  firstMessage?: string;
  memoryEnabled: boolean;
  /** Anyone in the organization can use it (shared agents only). */
  organizationAccess?: boolean;
  origin: AgentOriginValue;
  sourceSessionId: string | null;
  createdBySubjectId: string | null;
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
  const instructions = joinedInstructions(input.instructions, input.firstMessage);
  const [row] = await rawRows<AgentRow>(
    tx,
    sql`insert into agents (${sql.raw(input.id ? "id, " : "")}account_id, workspace_id, visibility,
        owner_subject_id, name, name_key, description, avatar, memory_enabled, organization_access,
        current_revision, origin, source_session_id, created_by_subject_id)
      values (${input.id ? sql`${input.id}::uuid, ` : sql``}${home.accountId}::uuid,
        ${home.workspaceId}::uuid, ${input.visibility}, ${input.ownerSubjectId}, ${input.name},
        lower(btrim(${input.name})), ${input.description},
        ${input.avatar === null ? sql`null` : sql`${JSON.stringify(input.avatar)}::jsonb`},
        ${input.memoryEnabled},
        ${input.visibility === "workspace" && input.organizationAccess === true}, 1,
        ${input.origin}, ${input.sourceSessionId}::uuid,
        ${input.createdBySubjectId})
      returning ${sql.raw(`id::text as id, account_id::text as account_id,
        workspace_id::text as workspace_id, visibility, owner_subject_id, name, description, avatar,
        memory_enabled, memory_collection_id::text as memory_collection_id, organization_access,
        current_revision, origin, source_session_id::text as source_session_id, created_by_subject_id, version,
        created_at, updated_at`)}`,
  );
  if (!row) throw new Error("Agent insert returned no row");
  const [revision] = await rawRows<{ created_at: Date | string }>(
    tx,
    sql`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
        description, instructions, created_by_subject_id)
      values (${row.id}::uuid, ${home.accountId}::uuid, ${home.workspaceId}::uuid, 1,
        ${input.name}, ${input.description}, ${instructions},
        ${input.createdBySubjectId})
      returning created_at`,
  );
  return mapAgent(
    {
      ...row,
      instructions,
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
  /** Older field: joins the Instructions as its own paragraph. */
  firstMessage?: string;
  memoryEnabled?: boolean;
  /**
   * Anyone in the organization can use it. Written to the agent and, for the
   * previous release during the rollout, as `open` on every Slack
   * installation it is in. Making the agent Only me turns it off.
   */
  organizationAccess?: boolean;
  /** Forget the current Memory collection (for example after a visibility change). */
  clearMemoryCollection?: boolean;
};

export type UpdateAgentOutcome =
  | { kind: "updated"; agent: AgentRecord; revised: boolean }
  | { kind: "not_found" }
  | { kind: "version_conflict"; current: AgentRecord }
  /** The new name clashes with another agent in a Slack installation it is in. */
  | { kind: "slack_name_taken"; connectionId: string };

/**
 * Lock an agent of the home workspace for the rest of the caller's
 * transaction and read it, or null when it does not exist.
 */
export async function lockAgent(
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
      let installs = await installsOf(tx, home, current.id);
      // Checked under the row lock: an agent in Slack is always shared, so
      // making it Only me takes it out of every Slack workspace, the same way
      // turning Slack off does (its channel settings there go with it).
      if (patch.visibility === "private" && installs.length > 0) {
        for (const install of installs) {
          await tx.execute(sql`delete from agent_slack_installs where id = ${install.id}::uuid`);
        }
        installs = [];
      }
      const name = patch.name ?? current.name;
      const was = current.content?.instructions ?? "";
      const instructions = joinedInstructions(patch.instructions ?? was, patch.firstMessage);
      const revised = current.content === null || instructions !== was;
      const nextRevision = revised ? current.currentRevision + 1 : current.currentRevision;
      const visibility = patch.visibility ?? current.visibility;
      const ownerSubjectId =
        patch.visibility !== undefined ? (patch.ownerSubjectId ?? null) : current.ownerSubjectId;
      const organizationAccess =
        visibility === "workspace" && (patch.organizationAccess ?? current.organizationAccess);
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
          organization_access = ${organizationAccess},
          current_revision = ${nextRevision}::integer,
          version = version + 1,
          updated_at = now()
        where id = ${current.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
      // Only the previous release reads who can use it from each Slack
      // installation's `open` (nothing here does since 1418): keep them the
      // same until a later step drops the column.
      for (const install of installs) {
        if (install.open === organizationAccess) continue;
        await tx.execute(sql`update agent_slack_installs set open = ${organizationAccess},
            version = version + 1, updated_at = now()
          where id = ${install.id}::uuid`);
        install.open = organizationAccess;
      }
      if (revised) {
        await tx.execute(sql`insert into agent_revisions (agent_id, account_id, workspace_id,
            revision, name, description, instructions, created_by_subject_id)
          values (${current.id}::uuid, ${home.accountId}::uuid, ${home.workspaceId}::uuid,
            ${nextRevision}::integer, ${name}, ${patch.description ?? current.description},
            ${instructions}, ${input.actorSubjectId})`);
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

/** Remember the agent's Memory collection once it exists. Version-free and idempotent. */
export async function setAgentMemoryCollection(
  db: Database,
  home: AgentHome,
  input: { agentId: string; collectionId: string },
): Promise<AgentRecord | null> {
  return await withRlsContext(db, home, async (tx) => {
    const current = await lockAgent(tx, home, input.agentId);
    if (!current) return null;
    await tx.execute(sql`update agents set memory_collection_id = ${input.collectionId}::uuid,
        updated_at = now()
      where id = ${current.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
    return await getAgent(tx, home, current.id);
  });
}

/**
 * Delete an agent, its revisions and Slack availability (its channel
 * settings and other Slack records go with its installation rows). Its chats
 * stay.
 */
export async function deleteAgent(
  db: Database,
  home: AgentHome,
  agentId: string,
): Promise<boolean> {
  return await withRlsContext(db, home, async (tx) => {
    const current = await lockAgent(tx, home, agentId);
    if (!current) return false;
    await tx.execute(sql`delete from agents
      where id = ${agentId}::uuid and workspace_id = ${home.workspaceId}::uuid`);
    return true;
  });
}

export type PutAgentSlackInstallOutcome =
  | { kind: "saved"; install: AgentSlackInstallRecord; agent: AgentRecord; created: boolean }
  | { kind: "not_found" }
  | { kind: "version_conflict"; install: AgentSlackInstallRecord }
  | { kind: "name_taken" }
  /** An Only me agent cannot be in Slack. */
  | { kind: "requires_workspace_visibility" };

/**
 * Make an agent available in one Slack installation. An agent may be in
 * several installations. Its `open` there is the agent's own "Anyone in the
 * organization" (change that with `updateAgent`). Callers check the name
 * rules, visibility and permissions first.
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
    expectedVersion?: number;
    /** Null when Opengeni made it available on its own (every linked Slack workspace). */
    actorSubjectId: string | null;
    /**
     * Opengeni adds it on its own (a shared agent is in every linked Slack
     * workspace): the agent's version stays, so nobody's open edit of it
     * conflicts. A person turning it on bumps it.
     */
    automatic?: boolean;
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
      const existing = (await installsOf(tx, home, agent.id)).find(
        (install) => install.connectionId === input.connectionId,
      );
      if (existing) {
        if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
          return { kind: "version_conflict" as const, install: existing };
        }
        return { kind: "saved" as const, install: existing, agent, created: false };
      }
      // Only the previous release reads who can use it here from `open`.
      const open = agent.organizationAccess;
      const nameKey = slackAgentNameKey(agent.name);
      await tx.execute(sql`insert into agent_slack_installs (agent_id, account_id, workspace_id,
          connection_id, install_workspace_id, slack_team_id, name_key, open,
          enabled_by_subject_id)
        values (${agent.id}::uuid, ${home.accountId}::uuid, ${home.workspaceId}::uuid,
          ${input.connectionId}::uuid, ${input.installWorkspaceId}::uuid, ${input.slackTeamId},
          ${nameKey}, ${open}, ${input.actorSubjectId})`);
      // A person turning Slack on changes the agent, so a stale edit of it
      // conflicts; Opengeni adding it on its own changes nothing they edit.
      if (!input.automatic) {
        await tx.execute(sql`update agents set version = version + 1, updated_at = now()
          where id = ${agent.id}::uuid and workspace_id = ${home.workspaceId}::uuid`);
      }
      const enabled = (await getAgent(tx, home, agent.id)) ?? agent;
      const saved = (await installsOf(tx, home, agent.id)).find(
        (install) => install.connectionId === input.connectionId,
      );
      if (!saved) throw new Error("Agent Slack availability insert returned no row");
      return { kind: "saved" as const, install: saved, agent: enabled, created: true };
    });
  } catch (error) {
    if (isSlackNameClash(uniqueViolation(error))) return { kind: "name_taken" };
    throw error;
  }
}

/**
 * Stop an agent answering in one Slack installation. Its channel routes, user
 * states, intro records and suggestions there go with it, and that
 * installation's threads and proposals lose their link to it. The agent, its
 * chats and its other installations stay.
 */
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

/** A chat bound to an Only me agent stays Only me. */
export class SessionAgentRequiresPrivateChatError extends Error {
  readonly name = "SessionAgentRequiresPrivateChatError";
  constructor() {
    super("This chat's agent is Only me, so the chat stays Only me.");
  }
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
  /** The Memory switch; on with no collection while one could not be made. */
  memoryEnabled: boolean;
  open: boolean;
  createdBySubjectId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type ProjectionRow = InstallRow & {
  agent_account_id: string;
  agent_workspace_id: string;
  agent_organization_access: boolean;
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

function mapProjection(row: ProjectionRow): SlackAgentProjection {
  return {
    id: row.agent_id,
    accountId: row.account_id,
    workspaceId: row.install_workspace_id,
    connectionId: row.connection_id,
    slackTeamId: row.slack_team_id,
    targetAccountId: row.agent_account_id,
    targetWorkspaceId: row.agent_workspace_id,
    name: row.name,
    nameKey: row.name_key,
    description: row.description,
    avatar: agentSlackAvatar({ id: row.agent_id, name: row.name, avatar: row.avatar }),
    instructions: row.instructions ?? "",
    knowledgeCollectionId: row.memory_enabled ? row.memory_collection_id : null,
    memoryEnabled: row.memory_enabled,
    // Anyone in the organization: the agent's own setting.
    open: row.agent_organization_access,
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
      a.organization_access as agent_organization_access,
      a.name, a.description, a.avatar, a.memory_enabled,
      a.memory_collection_id::text as memory_collection_id,
      a.created_by_subject_id as agent_created_by_subject_id,
      a.version as agent_version,
      a.created_at as agent_created_at, a.updated_at as agent_updated_at,
      r.instructions
    from agent_slack_installs i
    join agents a on a.id = i.agent_id and a.account_id = i.account_id
    left join agent_revisions r on r.agent_id = a.id and r.revision = a.current_revision
    where a.visibility = 'workspace' and ${where}`;
}

function compareProjections(left: SlackAgentProjection, right: SlackAgentProjection): number {
  if (left.nameKey !== right.nameKey) return left.nameKey < right.nameKey ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  // One agent in several installations: a stable order.
  if (left.connectionId === right.connectionId) return 0;
  return left.connectionId < right.connectionId ? -1 : 1;
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
      .map((row) => mapProjection(row))
      .filter((agent) => agent.workspaceId === installHome.workspaceId);
    return (
      await withProjectionInstructions(tx, installHome.accountId, projections, readableIds(rows))
    ).sort(compareProjections);
  });
}

/** A shared agent of the organization that one Slack installation doesn't answer to yet. */
export type AgentMissingFromSlack = {
  id: string;
  /** Its home workspace. */
  workspaceId: string;
  name: string;
  createdBySubjectId: string | null;
};

/**
 * Shared agents in the installation's organization that are not available
 * in this Slack installation (`connectionId`) yet, oldest first, so that when
 * two share a name the older one keeps it. Read from the installation's own
 * workspace through the organization read. The caller decides which of them
 * belong here (never a personal workspace's, only agents whose workspace is
 * linked to this Slack workspace).
 */
export async function listAgentsMissingFromSlack(
  db: Database,
  installHome: AgentHome,
  input: { connectionId: string },
): Promise<AgentMissingFromSlack[]> {
  return await withRlsContext(db, installHome, async (tx) => {
    const rows = await rawRows<{
      id: string;
      workspace_id: string;
      name: string;
      created_by_subject_id: string | null;
    }>(
      tx,
      sql`select a.id::text as id, a.workspace_id::text as workspace_id, a.name,
          a.created_by_subject_id
        from agents a
        where a.account_id = ${installHome.accountId}::uuid
          and a.visibility = 'workspace'
          and not exists (select 1 from agent_slack_installs i
            where i.agent_id = a.id and i.account_id = a.account_id
              and i.connection_id = ${input.connectionId}::uuid)
        order by a.created_at, a.id`,
    );
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      createdBySubjectId: row.created_by_subject_id,
    }));
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
    const projections = rows.map((row) => mapProjection(row));
    return (
      await withProjectionInstructions(tx, input.accountId, projections, readableIds(rows))
    ).sort(compareProjections);
  });
}

/**
 * One Slack-available agent of an organization by id, as one installation
 * sees it, or null. An agent may be in several installations: `connectionId`
 * picks that installation, `installWorkspaceId` the one whose own workspace
 * it is; with neither, the installation it joined first.
 */
export async function getSlackAgentProjection(
  db: Database,
  input: {
    accountId: string;
    agentId: string;
    connectionId?: string | null;
    installWorkspaceId?: string | null;
  },
): Promise<SlackAgentProjection | null> {
  return await withRlsContext(db, { accountId: input.accountId }, async (tx) => {
    const rows = await rawRows<ProjectionRow>(
      tx,
      projectionQuery(
        sql`i.account_id = ${input.accountId}::uuid and i.agent_id = ${input.agentId}::uuid
          ${input.connectionId ? sql`and i.connection_id = ${input.connectionId}::uuid` : sql``}
          ${
            input.installWorkspaceId
              ? sql`and i.install_workspace_id = ${input.installWorkspaceId}::uuid`
              : sql``
          }
          order by i.created_at, i.id limit 1`,
      ),
    );
    const [projection] = await withProjectionInstructions(
      tx,
      input.accountId,
      rows.map((row) => mapProjection(row)),
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

/**
 * A chat's agent for its Memory rules, with the chat's audience. A worker a
 * chat started has no agent of its own, so it is checked as its root chat's:
 * it may not write to a Memory its root chat could not. Privacy and Memory
 * scope are the asking chat's own (a private chat's workers are private too).
 */
export async function getSessionAgentMemoryState(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<{
  agentChat: boolean;
  agent: AgentRecord | null;
  chat: {
    private: boolean;
    ownerSubjectId: string | null;
    memoryOff: boolean;
    slackDm: boolean;
  };
} | null> {
  const row = await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    const [found] = await rawRows<{
      account_id: string;
      agent_id: string | null;
      visibility: string;
      owner_subject_id: string | null;
      memory_scope: string;
      dm_owner: string | null;
    }>(
      tx,
      // A Slack DM is private through its interaction, not its session row
      // (docs/slack-bot.md); its workers share the root's interaction.
      sql`select s.account_id::text as account_id,
          coalesce(${sessionAgentIdSql(sql.raw("s"))},
            ${sessionAgentIdSql(sql.raw("r"))})::text as agent_id,
          s.visibility, s.owner_subject_id, s.memory_scope,
          (select p.owning_subject_id from slack_interactions p
            where p.workspace_id = s.workspace_id
              and p.session_reservation_id = s.root_session_id
              and p.visibility = 'private'
            order by p.created_at, p.id limit 1) as dm_owner
        from sessions s
        left join sessions r on r.workspace_id = s.workspace_id
          and r.id = s.root_session_id and r.id <> s.id
        where s.workspace_id = ${input.workspaceId}::uuid and s.id = ${input.sessionId}::uuid`,
    );
    return found ?? null;
  });
  if (!row) return null;
  const onlyMe = row.visibility === "user_private";
  const chat = {
    private: onlyMe || row.dm_owner !== null,
    ownerSubjectId: onlyMe ? row.owner_subject_id : (row.dm_owner ?? row.owner_subject_id),
    memoryOff: row.memory_scope === "off",
    // Its saves land in workspace scope: neither Only me nor Memory scope user.
    slackDm: row.dm_owner !== null && !onlyMe && row.memory_scope !== "user",
  };
  const agentId = row.agent_id && /^[0-9a-f-]{36}$/iu.test(row.agent_id) ? row.agent_id : null;
  if (!agentId) return { agentChat: false, agent: null, chat };
  return {
    agentChat: true,
    agent: await getAgent(
      db,
      { accountId: row.account_id, workspaceId: input.workspaceId },
      agentId,
    ),
    chat,
  };
}
