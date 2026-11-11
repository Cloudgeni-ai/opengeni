/**
 * An agent works wherever its workspace is connected: every shared agent is
 * available in each Slack workspace linked to its home workspace, with no
 * separate step. Who may use it there is still the agent's own access (its
 * workspace's members, or linked organization members while it is open).
 *
 * Availability is still one `agent_slack_installs` row per agent and Slack
 * installation, because Slack threads, channel settings and intros hang off
 * it; this module only keeps those rows in step:
 *
 * - eagerly, when an agent is created, renamed or shared from the app, the
 *   API or a chat (`ensureAgentInLinkedSlack`);
 * - lazily, when an installation reads its agents for routing
 *   (`ensureSlackInstallationAgents`), which covers existing agents, agents a
 *   compatibility path or an older release made, and Slack workspaces
 *   connected later.
 *
 * A name Slack can't use, or one another agent there already answers to, is
 * refused when an agent is created, renamed or shared (`agentSlackNameRefusal`),
 * and an older agent that has such a name simply stays out of that Slack
 * workspace; its page says why (`agentSlackUnavailableReason`). When two older
 * agents share a name, the older one keeps it.
 */
import {
  slackAgentNameKey,
  slackAgentNameProblem,
  slackAgentNameProblemText,
  type AgentErrorCode,
  type SlackAgentNameProblem,
} from "@opengeni/contracts";
import {
  availableSlackBotConnectionMetadata,
  getWorkspace,
  listAgentSlackInstalls,
  listAgentsMissingFromSlack,
  listSlackAgentsForConnection,
  listSlackInstallationBindings,
  putAgentSlackInstall,
  type AgentRecord,
  type AgentSlackInstallRecord,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";

type Home = { accountId: string; workspaceId: string };

/** One Slack workspace linked to an Opengeni workspace: an active Opengeni Slack app it can use. */
export type LinkedSlackInstallation = {
  connectionId: string;
  slackTeamId: string;
  slackTeamName: string | null;
  /** The installation's own workspace (its binding's). */
  installHome: Home;
  /** What people mention, for example "Opengeni" or "Opengeni Staging". */
  botDisplayName: string;
};

/**
 * The Slack workspaces linked to a workspace: the active Opengeni Slack apps
 * installed in it or shared with it by its organization, each with an active
 * installation binding. In a fixed order, which is also where a new agent
 * goes while an agent is in one Slack workspace at a time: the workspace's
 * own Slack apps first, then those its organization shares, each by Slack
 * workspace name.
 */
export async function linkedSlackInstallations(
  deps: Pick<ApiRouteDeps, "db">,
  home: Home,
): Promise<LinkedSlackInstallation[]> {
  const available = (await availableSlackBotConnectionMetadata(deps.db, home)).filter(
    (connection) => connection.status === "active",
  );
  const bindingsByHome = new Map<
    string,
    Awaited<ReturnType<typeof listSlackInstallationBindings>>
  >();
  const linked: LinkedSlackInstallation[] = [];
  for (const connection of available) {
    let bindings = bindingsByHome.get(connection.workspaceId);
    if (!bindings) {
      bindings = await listSlackInstallationBindings(deps.db, {
        accountId: home.accountId,
        workspaceId: connection.workspaceId,
      }).catch(() => []);
      bindingsByHome.set(connection.workspaceId, bindings);
    }
    const binding = bindings.find(
      (candidate) => candidate.connectionId === connection.id && candidate.state === "active",
    );
    if (!binding) continue;
    linked.push({
      connectionId: connection.id,
      slackTeamId: binding.slackTeamId,
      slackTeamName: binding.slackTeamName ?? null,
      installHome: { accountId: home.accountId, workspaceId: connection.workspaceId },
      botDisplayName: binding.botDisplayName,
    });
  }
  const own = (installation: LinkedSlackInstallation) =>
    installation.installHome.workspaceId === home.workspaceId ? 0 : 1;
  // Code-unit order, so every server picks the same one whatever its locale.
  const byCodeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return linked.sort(
    (left, right) =>
      own(left) - own(right) ||
      byCodeUnit(left.slackTeamName ?? "", right.slackTeamName ?? "") ||
      byCodeUnit(left.connectionId, right.connectionId),
  );
}

async function isPersonalWorkspace(deps: Pick<ApiRouteDeps, "db">, home: Home): Promise<boolean> {
  const workspace = await getWorkspace(deps.db, home.workspaceId);
  return !workspace || workspace.accountId !== home.accountId || workspace.kind === "personal";
}

/** Why a name can't be an agent's in a Slack workspace. */
export type AgentSlackNameRefusal =
  | {
      code: "agent_slack_name_invalid";
      problem: SlackAgentNameProblem;
      message: string;
    }
  | {
      code: "agent_slack_name_taken";
      connectionId: string;
      slackTeamName: string | null;
      message: string;
    };

function nameTakenMessage(name: string, slackTeamName: string | null): string {
  const where = slackTeamName ? `the ${slackTeamName} Slack workspace` : "a linked Slack workspace";
  return `Another agent is already called “${name.trim()}” in ${where}, where people ask agents by name. Choose another name.`;
}

function nameRefusal(
  name: string,
  agentId: string | null,
  installation: LinkedSlackInstallation,
  taken: ReadonlyMap<string, string>,
): AgentSlackNameRefusal | null {
  const problem = slackAgentNameProblem(name);
  if (problem) {
    return {
      code: "agent_slack_name_invalid",
      problem,
      message: `${slackAgentNameProblemText(name, problem)} People ask agents by name in Slack, which is linked to this workspace.`,
    };
  }
  const holder = taken.get(slackAgentNameKey(name));
  if (holder !== undefined && holder !== agentId) {
    return {
      code: "agent_slack_name_taken",
      connectionId: installation.connectionId,
      slackTeamName: installation.slackTeamName,
      message: nameTakenMessage(name, installation.slackTeamName),
    };
  }
  return null;
}

/** Name key to agent id, per installation, for one pass. */
type TakenNames = Map<string, Map<string, string>>;

/** Name key to agent id, for the agents one installation answers to. */
async function takenNames(
  deps: Pick<ApiRouteDeps, "db">,
  installation: LinkedSlackInstallation,
  cache?: TakenNames,
): Promise<Map<string, string>> {
  const cached = cache?.get(installation.connectionId);
  if (cached) return cached;
  const agents = await listSlackAgentsForConnection(deps.db, installation.installHome, {
    connectionId: installation.connectionId,
  });
  const taken = new Map(agents.map((agent) => [agent.nameKey, agent.id]));
  cache?.set(installation.connectionId, taken);
  return taken;
}

/**
 * Make one shared agent available in the first linked Slack workspace that
 * takes its name, in `linked`'s order. One Slack workspace per agent until the
 * agents contract step (the legacy `slack_agents` row shares the agent's id).
 * Opengeni does this on its own, so the agent's version stays.
 */
async function placeAgent(
  deps: Pick<ApiRouteDeps, "db">,
  home: Home,
  agent: Pick<AgentRecord, "id" | "name" | "createdBySubjectId">,
  linked: readonly LinkedSlackInstallation[],
  cache: TakenNames,
): Promise<void> {
  for (const installation of linked) {
    try {
      const taken = await takenNames(deps, installation, cache);
      if (nameRefusal(agent.name, agent.id, installation, taken)) continue;
      const saved = await putAgentSlackInstall(deps.db, home, {
        agentId: agent.id,
        connectionId: installation.connectionId,
        slackTeamId: installation.slackTeamId,
        installWorkspaceId: installation.installHome.workspaceId,
        actorSubjectId: agent.createdBySubjectId,
        automatic: true,
      });
      if (saved.kind === "saved") {
        taken.set(slackAgentNameKey(agent.name), agent.id);
        return;
      }
      // Another server placed it at the same moment.
      if (saved.kind === "single_install") return;
      // Its name was taken there at the same moment: try the next one.
      if (saved.kind === "name_taken") cache.delete(installation.connectionId);
    } catch (error) {
      console.warn("[agent-slack-availability] could not make an agent available in Slack", {
        agentId: agent.id,
        connectionId: installation.connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Make every shared agent of an organization that is in no Slack workspace
 * yet available where it can be, oldest first, so that when two share a name
 * the older one keeps it. Never throws.
 */
async function catchUpOrganization(
  deps: Pick<ApiRouteDeps, "db">,
  installHome: Home,
): Promise<boolean> {
  try {
    const missing = await listAgentsMissingFromSlack(deps.db, installHome);
    if (missing.length === 0) return true;
    const names: TakenNames = new Map();
    const linkedByWorkspace = new Map<string, LinkedSlackInstallation[]>();
    for (const agent of missing) {
      if (slackAgentNameProblem(agent.name)) continue;
      const home = { accountId: installHome.accountId, workspaceId: agent.workspaceId };
      let linked = linkedByWorkspace.get(agent.workspaceId);
      if (!linked) {
        linked = (await isPersonalWorkspace(deps, home))
          ? []
          : await linkedSlackInstallations(deps, home);
        linkedByWorkspace.set(agent.workspaceId, linked);
      }
      if (linked.length > 0) await placeAgent(deps, home, agent, linked, names);
    }
    return true;
  } catch (error) {
    console.warn("[agent-slack-availability] could not bring an organization's agents up to date", {
      accountId: installHome.accountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Check a shared agent's name against every Slack workspace linked to its
 * home workspace, before it is created, renamed or shared. Older agents not
 * in Slack yet are placed first, so a new name never takes one from them.
 * Null when it is fine, or when no Slack workspace is linked (or the home is
 * personal).
 */
export async function agentSlackNameRefusal(
  deps: Pick<ApiRouteDeps, "db">,
  home: Home,
  input: { agentId: string | null; name: string },
): Promise<AgentSlackNameRefusal | null> {
  if (await isPersonalWorkspace(deps, home)) return null;
  const linked = await linkedSlackInstallations(deps, home);
  if (linked.length === 0) return null;
  await catchUpOrganization(deps, linked[0]!.installHome);
  for (const installation of linked) {
    const refusal = nameRefusal(
      input.name,
      input.agentId,
      installation,
      await takenNames(deps, installation),
    );
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Make a shared agent available where it can be, after the organization's
 * older agents: its own workspace's Slack apps first, then those its
 * organization shares with it. Best effort: a Slack workspace whose name
 * rules it breaks, or where another agent has its name, is skipped; the agent
 * page says why. Only reading the agent's current availabilities can throw.
 * Returns them.
 */
export async function ensureAgentInLinkedSlack(
  deps: Pick<ApiRouteDeps, "db">,
  home: Home,
  agent: Pick<AgentRecord, "id" | "visibility">,
): Promise<AgentSlackInstallRecord[]> {
  const installs = await listAgentSlackInstalls(deps.db, home, [agent.id]);
  if (installs.length > 0 || agent.visibility !== "workspace") return installs;
  let linked: LinkedSlackInstallation[];
  try {
    if (await isPersonalWorkspace(deps, home)) return installs;
    linked = await linkedSlackInstallations(deps, home);
  } catch (error) {
    console.warn("[agent-slack-availability] could not read the linked Slack workspaces", {
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return installs;
  }
  if (linked.length === 0) return installs;
  // The agent is one of the organization's agents in no Slack workspace yet.
  await catchUpOrganization(deps, linked[0]!.installHome);
  return await listAgentSlackInstalls(deps.db, home, [agent.id]);
}

/** When each installation last brought its organization up to date, per database handle. */
const lastInstallationSync = new WeakMap<object, Map<string, number>>();
/** How long one process trusts an installation's agents after bringing them up to date. */
const INSTALLATION_SYNC_INTERVAL_MS = 60_000;

/**
 * Before an installation reads its agents for routing, make every shared
 * agent of its organization that is in no Slack workspace yet available where
 * it can be. Cheap when nothing is missing (one read), and at most once a
 * minute per installation and process; creating, renaming and sharing an
 * agent do it at once anyway. Never throws: Slack keeps working with the
 * agents it already has.
 */
export async function ensureSlackInstallationAgents(
  deps: Pick<ApiRouteDeps, "db">,
  installHome: Home,
  connectionId: string,
  options: { now?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  let synced = lastInstallationSync.get(deps.db);
  if (!synced) {
    synced = new Map();
    lastInstallationSync.set(deps.db, synced);
  }
  const last = synced.get(connectionId);
  if (last !== undefined && now - last < INSTALLATION_SYNC_INTERVAL_MS) return;
  synced.set(connectionId, now);
  // Try again on the next read rather than waiting out the interval.
  if (!(await catchUpOrganization(deps, installHome))) synced.delete(connectionId);
}

/** Why a shared agent isn't available in one linked Slack workspace, or null when it is. */
export async function agentSlackUnavailableReason(
  deps: Pick<ApiRouteDeps, "db">,
  input: {
    agent: Pick<AgentRecord, "id" | "name" | "visibility">;
    installation: LinkedSlackInstallation;
    installs: readonly AgentSlackInstallRecord[];
    personalWorkspace: boolean;
  },
): Promise<AgentErrorCode | null> {
  const { agent, installation, installs } = input;
  if (installs.some((install) => install.connectionId === installation.connectionId)) return null;
  if (agent.visibility !== "workspace") return "agent_slack_requires_workspace_visibility";
  if (input.personalWorkspace) return "agent_slack_personal_workspace";
  if (installs.length > 0) return "agent_slack_single_install";
  const refusal = nameRefusal(
    agent.name,
    agent.id,
    installation,
    await takenNames(deps, installation),
  );
  return refusal?.code ?? null;
}

export { isPersonalWorkspace as agentHomeIsPersonalWorkspace };
