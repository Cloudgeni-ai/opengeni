/**
 * Teams workspace routing: what a linked person's 1:1 chat uses, the switch
 * cards it was shown, where the organization lets Teams start work, and the
 * agents that can answer there.
 *
 * Every row lives in the installation's workspace (home tenancy), like its
 * links and routes, and names a target workspace of the same organization
 * (a CHECK and a composite foreign key hold it there). None of it is
 * authority: the API checks the person's live access to the target on every
 * message, at session admission and on delivery.
 */
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import { PERSONAL_WORKSPACE_EXTERNAL_SOURCE } from "./personal-workspace-membership";
import { teamsScoped, type TeamsInstallation } from "./teams-conversations";

/** A workspace (and, optionally, an agent in it) a Teams chat can use. */
export type TeamsChatTarget = { workspaceId: string; agentId: string | null };

export type TeamsChatChoice = TeamsChatTarget & {
  subjectId: string;
  version: number;
};

/** The person's current choice for their 1:1 chat, or null. Memory only. */
export async function getTeamsChatChoice(
  db: Database,
  i: TeamsInstallation,
  input: { actorId: string; subjectId: string },
): Promise<TeamsChatChoice | null> {
  return teamsScoped(db, i, async (tx) => {
    const [row] = await rawRows<{
      subject_id: string;
      target_workspace_id: string;
      agent_id: string | null;
      version: number;
    }>(
      tx,
      sql`select subject_id,target_workspace_id,agent_id,version from teams_bot_chat_choices
        where tenant_id=${i.tenant_id}::uuid and actor_id=${input.actorId}::uuid
          and account_id=${i.account_id}::uuid and workspace_id=${i.workspace_id}::uuid`,
    );
    // A choice another Opengeni account made before a relink is not theirs.
    if (!row || row.subject_id !== input.subjectId) return null;
    return {
      subjectId: row.subject_id,
      workspaceId: row.target_workspace_id,
      agentId: row.agent_id,
      version: Number(row.version),
    };
  });
}

/**
 * Remember what the person's 1:1 chat uses. The link must still name them;
 * the target must be a workspace of the installation's organization.
 */
export async function setTeamsChatChoice(
  db: Database,
  i: TeamsInstallation,
  input: { actorId: string; subjectId: string } & TeamsChatTarget,
): Promise<void> {
  await teamsScoped(db, i, async (tx) => {
    const linked = await rawRows(
      tx,
      sql`select 1 from teams_bot_links where tenant_id=${i.tenant_id}::uuid
        and actor_id=${input.actorId}::uuid and subject_id=${input.subjectId} for share`,
    );
    if (!linked.length) throw new Error("teams_link_missing");
    await tx.execute(sql`insert into teams_bot_chat_choices
      (account_id,workspace_id,tenant_id,actor_id,subject_id,target_account_id,target_workspace_id,agent_id)
      values(${i.account_id}::uuid,${i.workspace_id}::uuid,${i.tenant_id}::uuid,${input.actorId}::uuid,
        ${input.subjectId},${i.account_id}::uuid,${input.workspaceId}::uuid,${input.agentId}::uuid)
      on conflict(tenant_id,actor_id) do update set subject_id=excluded.subject_id,
        target_workspace_id=excluded.target_workspace_id,agent_id=excluded.agent_id,
        version=teams_bot_chat_choices.version+1,updated_at=now()`);
  });
}

/** Forget the person's choice, for example when they lost access to it. */
export async function clearTeamsChatChoice(
  db: Database,
  i: TeamsInstallation,
  input: { actorId: string },
): Promise<void> {
  await teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`delete from teams_bot_chat_choices where tenant_id=${i.tenant_id}::uuid and actor_id=${input.actorId}::uuid`,
    );
  });
}

/** How long a switch card's numbers stay valid. */
export const TEAMS_ROUTE_PROMPT_TTL_MS = 24 * 60 * 60_000;

export type TeamsRoutePrompt = {
  id: string;
  /** The message waiting for the answer, or null for a plain "switch". */
  payload: Record<string, unknown> | null;
  options: Array<TeamsChatTarget & { position: number }>;
};

/**
 * Record the switch card a person is shown, replacing any earlier one: only
 * the latest card's numbers count. Options are numbered from 1 in order.
 */
export async function putTeamsRoutePrompt(
  db: Database,
  i: TeamsInstallation,
  input: {
    actorId: string;
    subjectId: string;
    payload: Record<string, unknown> | null;
    options: readonly TeamsChatTarget[];
  },
): Promise<string> {
  if (input.options.length < 1 || input.options.length > 100)
    throw new Error("teams_route_prompt_options_invalid");
  return teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`delete from teams_bot_route_prompts where tenant_id=${i.tenant_id}::uuid and actor_id=${input.actorId}::uuid`,
    );
    const [prompt] = await rawRows<{ id: string }>(
      tx,
      sql`insert into teams_bot_route_prompts(account_id,workspace_id,tenant_id,actor_id,subject_id,generation,payload)
        values(${i.account_id}::uuid,${i.workspace_id}::uuid,${i.tenant_id}::uuid,${input.actorId}::uuid,
          ${input.subjectId},${i.generation}::uuid,${input.payload === null ? null : JSON.stringify(input.payload)}::jsonb)
        returning id`,
    );
    if (!prompt) throw new Error("teams_route_prompt_unavailable");
    for (const [index, option] of input.options.entries()) {
      await tx.execute(sql`insert into teams_bot_route_prompt_options
        (account_id,workspace_id,prompt_id,position,target_account_id,target_workspace_id,agent_id)
        values(${i.account_id}::uuid,${i.workspace_id}::uuid,${prompt.id}::uuid,${index + 1},
          ${i.account_id}::uuid,${option.workspaceId}::uuid,${option.agentId}::uuid)`);
    }
    return prompt.id;
  });
}

/** The person's latest switch card in this installation generation, while it is fresh, or null. */
export async function readTeamsRoutePrompt(
  db: Database,
  i: TeamsInstallation,
  input: { actorId: string; subjectId: string; now?: Date },
): Promise<TeamsRoutePrompt | null> {
  return teamsScoped(db, i, async (tx) => {
    const cutoff = new Date((input.now?.getTime() ?? Date.now()) - TEAMS_ROUTE_PROMPT_TTL_MS);
    const [prompt] = await rawRows<{ id: string; payload: Record<string, unknown> | null }>(
      tx,
      sql`select id,payload from teams_bot_route_prompts where tenant_id=${i.tenant_id}::uuid
        and actor_id=${input.actorId}::uuid and subject_id=${input.subjectId}
        and generation=${i.generation}::uuid and created_at>${cutoff.toISOString()}::timestamptz`,
    );
    if (!prompt) return null;
    const options = await rawRows<{
      position: number;
      target_workspace_id: string;
      agent_id: string | null;
    }>(
      tx,
      sql`select position,target_workspace_id,agent_id from teams_bot_route_prompt_options
        where prompt_id=${prompt.id}::uuid and account_id=${i.account_id}::uuid order by position`,
    );
    return {
      id: prompt.id,
      payload: prompt.payload,
      options: options.map((row) => ({
        position: Number(row.position),
        workspaceId: row.target_workspace_id,
        agentId: row.agent_id,
      })),
    };
  });
}

/**
 * Answer a switch card: the option at `position` of the person's latest
 * fresh card, and the message that was waiting for it. The card is removed
 * in the same transaction, so a repeated answer finds nothing.
 */
export async function takeTeamsRoutePromptOption(
  db: Database,
  i: TeamsInstallation,
  input: { actorId: string; subjectId: string; position: number; now?: Date },
): Promise<{ target: TeamsChatTarget; payload: Record<string, unknown> | null } | null> {
  if (!Number.isInteger(input.position) || input.position < 1 || input.position > 100) return null;
  return teamsScoped(db, i, async (tx) => {
    const cutoff = new Date((input.now?.getTime() ?? Date.now()) - TEAMS_ROUTE_PROMPT_TTL_MS);
    const [row] = await rawRows<{
      id: string;
      payload: Record<string, unknown> | null;
      target_workspace_id: string;
      agent_id: string | null;
    }>(
      tx,
      sql`select p.id,p.payload,o.target_workspace_id,o.agent_id
        from teams_bot_route_prompts p
        join teams_bot_route_prompt_options o on o.prompt_id=p.id and o.account_id=p.account_id
        where p.tenant_id=${i.tenant_id}::uuid and p.actor_id=${input.actorId}::uuid
          and p.subject_id=${input.subjectId} and p.generation=${i.generation}::uuid
          and p.created_at>${cutoff.toISOString()}::timestamptz and o.position=${input.position}
        for update of p`,
    );
    if (!row) return null;
    await tx.execute(sql`delete from teams_bot_route_prompts where id=${row.id}::uuid`);
    return {
      target: { workspaceId: row.target_workspace_id, agentId: row.agent_id },
      payload: row.payload,
    };
  });
}

/** Remove switch cards older than their lifetime. Returns how many. */
export async function pruneTeamsRoutePrompts(
  db: Database,
  i: TeamsInstallation,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - TEAMS_ROUTE_PROMPT_TTL_MS);
  const rows = await teamsScoped(db, i, (tx) =>
    rawRows(
      tx,
      sql`delete from teams_bot_route_prompts where tenant_id=${i.tenant_id}::uuid
        and created_at<=${cutoff.toISOString()}::timestamptz returning id`,
    ),
  );
  return rows.length;
}

/**
 * Where an organization lets its Teams connection start work. `workspaceIds`
 * null is every workspace of the organization; an array narrows it to those,
 * and the installation's own workspace is always included. Personal
 * workspaces are their own switch (and the organization's Personal workspace
 * setting still applies).
 */
export type TeamsReach = {
  workspaceIds: string[] | null;
  personalWorkspaces: boolean;
  version: number;
};

export async function getTeamsReach(db: Database, i: TeamsInstallation): Promise<TeamsReach> {
  const [row] = await teamsScoped(db, i, (tx) =>
    rawRows<{
      reach_workspace_ids: string[] | null;
      reach_personal_workspaces: boolean;
      reach_version: number | string;
    }>(
      tx,
      sql`select reach_workspace_ids,reach_personal_workspaces,reach_version from teams_bot_installations
        where tenant_id=${i.tenant_id}::uuid and workspace_id=${i.workspace_id}::uuid`,
    ),
  );
  if (!row) throw new Error("teams_installation_changed");
  return {
    workspaceIds: row.reach_workspace_ids,
    personalWorkspaces: row.reach_personal_workspaces,
    version: Number(row.reach_version),
  };
}

/** Whether a workspace is inside the reach. The installation's own always is. */
export function teamsReachIncludes(
  reach: Pick<TeamsReach, "workspaceIds" | "personalWorkspaces">,
  i: Pick<TeamsInstallation, "workspace_id">,
  workspace: { workspaceId: string; personal: boolean },
): boolean {
  if (workspace.workspaceId === i.workspace_id) return true;
  if (workspace.personal) return reach.personalWorkspaces;
  return reach.workspaceIds === null || reach.workspaceIds.includes(workspace.workspaceId);
}

/**
 * Change the reach. The caller must already have checked that the person is
 * an organization administrator who manages the installation's workspace.
 * Selected workspaces must belong to the organization and be shared
 * workspaces; the installation's own workspace is implied and not stored.
 * `expectedVersion` makes a stale editor fail instead of overwriting.
 */
export async function setTeamsReach(
  db: Database,
  i: TeamsInstallation,
  input: {
    workspaceIds: readonly string[] | null;
    personalWorkspaces: boolean;
    expectedVersion?: number;
  },
): Promise<TeamsReach> {
  if (input.workspaceIds?.some((id) => typeof id !== "string" || !UUID.test(id)))
    throw new Error("teams_reach_invalid");
  const selected =
    input.workspaceIds === null
      ? null
      : [
          ...new Set(
            input.workspaceIds
              .map((id) => id.toLowerCase())
              .filter((id) => id !== i.workspace_id.toLowerCase()),
          ),
        ].sort();
  if (selected && selected.length > 1000) throw new Error("teams_reach_invalid");
  if (selected && selected.length > 0) {
    const found = await organizationSharedWorkspaceIds(db, i.account_id, selected);
    if (selected.some((id) => !found.has(id))) throw new Error("teams_reach_invalid");
  }
  return teamsScoped(db, i, async (tx) => {
    const [row] = await rawRows<{
      reach_workspace_ids: string[] | null;
      reach_personal_workspaces: boolean;
      reach_version: number | string;
    }>(
      tx,
      sql`update teams_bot_installations set
          reach_workspace_ids=${uuidArray(selected)},
          reach_personal_workspaces=${input.personalWorkspaces},
          reach_version=reach_version+1
        where tenant_id=${i.tenant_id}::uuid and workspace_id=${i.workspace_id}::uuid
          and (${input.expectedVersion ?? null}::bigint is null or reach_version=${input.expectedVersion ?? null}::bigint)
        returning reach_workspace_ids,reach_personal_workspaces,reach_version`,
    );
    if (!row) throw new Error("teams_reach_version_conflict");
    return {
      workspaceIds: row.reach_workspace_ids,
      personalWorkspaces: row.reach_personal_workspaces,
      version: Number(row.reach_version),
    };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A bound uuid[] (never a text literal a caller's string could extend). */
function uuidArray(values: readonly string[] | null) {
  return values === null
    ? sql`NULL::uuid[]`
    : sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)::uuid)`;
}

/** Which of `workspaceIds` are shared (not Personal) workspaces of the organization. */
async function organizationSharedWorkspaceIds(
  db: Database,
  accountId: string,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  const rows = await withRlsContext(db, { accountId }, (tx) =>
    rawRows<{ workspace_id: string }>(
      tx,
      sql`select inventory.workspace_id from list_organization_workspace_ids(${accountId}::uuid) inventory
        join workspaces w on w.id=inventory.workspace_id and w.account_id=${accountId}::uuid
        where inventory.workspace_id = any(${uuidArray(workspaceIds)})
          and w.external_source is distinct from ${PERSONAL_WORKSPACE_EXTERNAL_SOURCE}`,
    ),
  );
  return new Set(rows.map((row) => row.workspace_id.toLowerCase()));
}

/** A shared agent Teams can offer: ids, names and where it works. */
export type TeamsAgentDirectoryEntry = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  nameKey: string;
  avatar: unknown;
};

/**
 * The shared (workspace-visible) agents of an organization whose home is one
 * of `workspaceIds`, by name. Only me agents are never listed. Whether the
 * person may use one is decided by the caller from their live access to its
 * workspace; this only lists.
 */
export async function listTeamsAgentDirectory(
  db: Database,
  input: { accountId: string; workspaceIds: readonly string[] },
): Promise<TeamsAgentDirectoryEntry[]> {
  if (input.workspaceIds.length === 0) return [];
  const rows = await withRlsContext(db, { accountId: input.accountId }, (tx) =>
    rawRows<{
      id: string;
      account_id: string;
      workspace_id: string;
      name: string;
      name_key: string;
      avatar: unknown;
    }>(
      tx,
      sql`select a.id,a.account_id,a.workspace_id,a.name,a.name_key,a.avatar from agents a
        join workspaces w on w.id=a.workspace_id and w.account_id=a.account_id
        where a.account_id=${input.accountId}::uuid and a.visibility='workspace'
          and w.external_source is distinct from ${PERSONAL_WORKSPACE_EXTERNAL_SOURCE}
          and a.workspace_id = any(${uuidArray(input.workspaceIds.filter((id) => UUID.test(id)))})
        order by a.name_key, a.created_at, a.id
        limit 500`,
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    name: row.name,
    nameKey: row.name_key,
    avatar: row.avatar,
  }));
}
