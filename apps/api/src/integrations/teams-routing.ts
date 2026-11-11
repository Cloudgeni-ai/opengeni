/**
 * Teams workspace routing: which workspace (and agent) a linked person's 1:1
 * message starts work in, the way Slack routes a bot DM.
 *
 * A connected tenant reaches every workspace of the connecting organization
 * the linked person can start work in, within the organization admin's reach
 * setting. The first match wins:
 *
 *   1. `in <Workspace>: …` for this one message;
 *   2. `<App name>: …` (or `Opengeni: …`): the main assistant again;
 *   3. an agent addressed at the start (`+name`, or `Name: …` / `Name, …`),
 *      which also becomes the chat's choice, since a Teams 1:1 has no threads;
 *   4. the person's remembered choice (switch, or the last agent addressed);
 *   5. their Personal workspace;
 *   6. their only workspace;
 *   7. otherwise a switch card, with the message waiting for the answer.
 *
 * Nothing here is authority. Candidates come from the person's live
 * memberships, and the caller re-checks live access to the chosen workspace
 * when it enqueues, at session admission and before delivery. A choice that
 * no longer works is refused, never quietly served from somewhere else.
 */
import { slackAgentNameKey } from "@opengeni/contracts";
import {
  getOrganizationPrivacyPreferences,
  getTeamsReach,
  listNamedSubjectSlackRoutableWorkspaces,
  listTeamsAgentDirectory,
  namedSubjectPersonalWorkspaceId,
  personalWorkspaceClosedToNewWork,
  teamsReachIncludes,
  type Database,
  type TeamsChatTarget,
  type TeamsInstallation,
} from "@opengeni/db";
import { parseSlackWorkspacePrefix } from "./slack-routing";
import {
  matchSlackAgentAddress,
  slackAgentAddressIsExplicit,
  type SlackRoutingAgent,
} from "./slack-agent-address";

/** A workspace the person can start work in from Teams. */
export type TeamsRouteWorkspace = { workspaceId: string; label: string; personal: boolean };

/** A shared agent of the organization, and whether this person can use it. */
export type TeamsRouteAgent = SlackRoutingAgent & { usable: boolean };

/** Everything routing reads for one person, loaded live per message. */
export type TeamsRouteDirectory = {
  candidates: TeamsRouteWorkspace[];
  agents: TeamsRouteAgent[];
  /** The person's own Personal workspace, when it is a candidate. */
  personalWorkspaceId: string | null;
};

/** Where one message goes. `text` is the message without the addressing. */
export type TeamsRouteResolution =
  | {
      kind: "resolved";
      target: TeamsChatTarget;
      workspaceLabel: string;
      agentName: string | null;
      text: string;
      source: "prefix" | "main" | "agent" | "choice" | "personal" | "sole";
      /** Remember this target as the chat's choice. */
      remember: boolean;
      /** Name the workspace on the first reply: routing made a real choice. */
      announce: boolean;
    }
  /** Only switched the chat (an agent's name or the app name on its own). */
  | { kind: "switched"; target: TeamsChatTarget; workspaceLabel: string; agentName: string | null }
  | { kind: "ask"; options: TeamsRouteOption[] }
  | { kind: "denied"; text: string; forgetChoice?: boolean };

/** One numbered choice on a switch card. */
export type TeamsRouteOption = TeamsChatTarget & {
  title: string;
  detail: string;
};

const MAIN_NAMES = ["opengeni"];

/** The switch commands, or null. Only the whole message counts. */
export function teamsSwitchCommand(
  text: string,
): { kind: "list" } | { kind: "pick"; position: number } | { kind: "named"; name: string } | null {
  if (text.length > 200) return null;
  const value = text
    .trim()
    .replace(/^\//u, "")
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
  const lower = value.toLowerCase();
  if (["switch", "workspace", "workspaces", "agents", "agent"].includes(lower))
    return { kind: "list" };
  const match = /^switch(?: to)? (.+)$/iu.exec(value);
  if (!match) return null;
  const rest = match[1]!.trim();
  if (/^\d{1,3}$/u.test(rest)) return { kind: "pick", position: Number(rest) };
  return rest ? { kind: "named", name: rest } : null;
}

function mainAddress(text: string, appName: string): { remainder: string | null } | null {
  const names = [...new Set([appName.trim().toLowerCase(), ...MAIN_NAMES])].filter(Boolean);
  const lower = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "");
  for (const name of names) {
    if (lower === name) return { remainder: null };
    if (!text.trim().toLowerCase().startsWith(name)) continue;
    const after = text.trim().slice(name.length);
    const separated = /^\s*[:,]\s*/u.exec(after);
    if (!separated) continue;
    const remainder = after.slice(separated[0].length);
    return { remainder: remainder.trim() ? remainder : null };
  }
  return null;
}

function workspaceLabel(directory: TeamsRouteDirectory, workspaceId: string): string | null {
  return directory.candidates.find((c) => c.workspaceId === workspaceId)?.label ?? null;
}

/** The agents a name can mean: one per name, preferring ones the person can use. */
function nameableAgents(directory: TeamsRouteDirectory): {
  agents: TeamsRouteAgent[];
  ambiguous: Map<string, TeamsRouteAgent[]>;
} {
  const byKey = new Map<string, TeamsRouteAgent[]>();
  for (const agent of directory.agents) {
    const list = byKey.get(agent.nameKey) ?? [];
    list.push(agent);
    byKey.set(agent.nameKey, list);
  }
  const agents: TeamsRouteAgent[] = [];
  const ambiguous = new Map<string, TeamsRouteAgent[]>();
  for (const [key, list] of byKey) {
    const usable = list.filter((agent) => agent.usable);
    if (usable.length > 1) ambiguous.set(key, usable);
    agents.push(usable[0] ?? list[0]!);
  }
  return { agents, ambiguous };
}

/** "Name works in the X workspace, which you don't have access to." */
export function teamsNoAccessToAgentText(
  agent: Pick<SlackRoutingAgent, "name" | "targetWorkspaceLabel">,
): string {
  const where = agent.targetWorkspaceLabel
    ? `the **${agent.targetWorkspaceLabel}** workspace`
    : "a workspace";
  return `**${agent.name}** works in ${where}, which you don't have access to. Ask an admin of that workspace for access. No chat was started.`;
}

/** "No agent called X. Available: …" */
export function teamsUnknownAgentText(
  requested: string,
  usable: readonly TeamsRouteAgent[],
): string {
  const named = requested.trim() ? ` called **${requested.trim()}**` : "";
  const names = usable.filter((agent) => agent.usable).map((agent) => agent.name);
  const available = names.length ? ` Available: ${names.join(", ")}.` : "";
  return `No agent${named}.${available} No chat was started.`;
}

function ambiguousAgentText(list: readonly TeamsRouteAgent[]): string {
  const where = list
    .map((agent) => agent.targetWorkspaceLabel)
    .filter((label): label is string => Boolean(label));
  return `Several agents are called **${list[0]!.name}**${where.length ? ` (in ${where.join(", ")})` : ""}. Send **switch** to pick one. No chat was started.`;
}

function noAccessToWorkspaceText(requested: string, candidates: readonly TeamsRouteWorkspace[]) {
  const names = candidates.map((c) => c.label);
  return `You can't start work in a workspace called **${requested}**.${names.length ? ` Your workspaces: ${names.join(", ")}.` : ""} No chat was started.`;
}

/** For a person with no workspace they can start work in. */
export const TEAMS_NO_WORKSPACE_TEXT =
  "Your Opengeni account can't start chats in any workspace your organization makes available in Microsoft Teams. Ask an Opengeni admin in your organization for access, then message me again.";

/** For a remembered choice the person can no longer use: access or the organization's reach changed. */
export function teamsChoiceUnavailableText(label: string | null): string {
  return `You can no longer start chats in **${label ?? "the workspace this chat used"}** from Teams. Send **switch** to choose another. No chat was started.`;
}

/** The numbered options a switch card offers: usable agents first, then workspaces, Personal first. */
export function teamsRouteOptions(directory: TeamsRouteDirectory): TeamsRouteOption[] {
  const agents = directory.agents
    .filter((agent) => agent.usable)
    .map((agent) => ({
      workspaceId: agent.targetWorkspaceId,
      agentId: agent.id,
      title: agent.name,
      detail: `Agent in ${agent.targetWorkspaceLabel ?? "a workspace"}`,
    }));
  const workspaces = [...directory.candidates]
    .sort((a, b) => Number(b.personal) - Number(a.personal))
    .map((workspace) => ({
      workspaceId: workspace.workspaceId,
      agentId: null,
      title: workspace.label,
      detail: workspace.personal ? "Your Personal workspace" : "Workspace",
    }));
  return [...agents, ...workspaces].slice(0, 100);
}

/** Find a workspace or agent by what the person typed after "switch". */
export function teamsRouteOptionNamed(
  directory: TeamsRouteDirectory,
  name: string,
): TeamsRouteOption | "ambiguous" | null {
  const options = teamsRouteOptions(directory);
  const wanted = slackAgentNameKey(name.replace(/^\+/u, ""));
  const matches = options.filter((option) => slackAgentNameKey(option.title) === wanted);
  if (matches.length > 1) return "ambiguous";
  return matches[0] ?? null;
}

/** Decide where one 1:1 message goes. Pure: everything it reads is in `input`. */
export function resolveTeamsRoute(input: {
  text: string;
  appName: string;
  directory: TeamsRouteDirectory;
  choice: TeamsChatTarget | null;
}): TeamsRouteResolution {
  const { directory } = input;
  const { candidates } = directory;
  const many = candidates.length + directory.agents.filter((a) => a.usable).length > 1;
  const label = (workspaceId: string) => workspaceLabel(directory, workspaceId);
  const choiceLive =
    input.choice &&
    label(input.choice.workspaceId) !== null &&
    (!input.choice.agentId ||
      directory.agents.some(
        (agent) =>
          agent.id === input.choice!.agentId &&
          agent.usable &&
          agent.targetWorkspaceId === input.choice!.workspaceId,
      ))
      ? input.choice
      : null;

  // 1. One message to another workspace. A name that matches nothing (or two
  //    workspaces) is refused, never ignored.
  const prefix = parseSlackWorkspacePrefix(input.text);
  if (prefix) {
    const wanted = prefix.requested.toLowerCase();
    const matches = candidates.filter((c) => c.label.toLowerCase() === wanted);
    if (matches.length !== 1)
      return { kind: "denied", text: noAccessToWorkspaceText(prefix.requested, candidates) };
    return {
      kind: "resolved",
      target: { workspaceId: matches[0]!.workspaceId, agentId: null },
      workspaceLabel: matches[0]!.label,
      agentName: null,
      text: prefix.remainder,
      source: "prefix",
      remember: false,
      announce: true,
    };
  }

  // 2. Back to the main assistant, in the workspace the chat already uses.
  //    A remembered workspace that no longer works is refused and forgotten,
  //    as in step 4; nothing starts somewhere else.
  const main = mainAddress(input.text, input.appName);
  if (main) {
    if (input.choice && label(input.choice.workspaceId) === null)
      return {
        kind: "denied",
        text: teamsChoiceUnavailableText(null),
        forgetChoice: true,
      };
    const base = input.choice ? input.choice.workspaceId : defaultWorkspace(directory);
    if (!base) return { kind: "denied", text: TEAMS_NO_WORKSPACE_TEXT };
    const target = { workspaceId: base, agentId: null };
    if (main.remainder === null)
      return { kind: "switched", target, workspaceLabel: label(base)!, agentName: null };
    return {
      kind: "resolved",
      target,
      workspaceLabel: label(base)!,
      agentName: null,
      text: main.remainder,
      source: "main",
      remember: true,
      announce: many,
    };
  }

  // 3. An agent addressed at the start. A bare name that merely starts a
  //    sentence ("Data looks fine") is ordinary text, as in Slack.
  const { agents, ambiguous } = nameableAgents(directory);
  const address = matchSlackAgentAddress(input.text, agents, { allowBare: true, allowPlus: true });
  if (address?.kind === "unknown")
    return { kind: "denied", text: teamsUnknownAgentText(address.requested, directory.agents) };
  if (address?.kind === "agent" && slackAgentAddressIsExplicit(address)) {
    const agent = address.agent as TeamsRouteAgent;
    const several = ambiguous.get(agent.nameKey);
    if (several) return { kind: "denied", text: ambiguousAgentText(several) };
    if (!agent.usable) return { kind: "denied", text: teamsNoAccessToAgentText(agent) };
    const target = { workspaceId: agent.targetWorkspaceId, agentId: agent.id };
    const workspace = agent.targetWorkspaceLabel ?? label(agent.targetWorkspaceId) ?? "";
    if (address.remainder === null)
      return { kind: "switched", target, workspaceLabel: workspace, agentName: agent.name };
    return {
      kind: "resolved",
      target,
      workspaceLabel: workspace,
      agentName: agent.name,
      text: address.remainder,
      source: "agent",
      remember: true,
      announce: true,
    };
  }

  // 4. The remembered choice, while it still works. One that doesn't is
  //    refused and forgotten; nothing starts somewhere else.
  if (input.choice && !choiceLive)
    return {
      kind: "denied",
      text: teamsChoiceUnavailableText(label(input.choice.workspaceId)),
      forgetChoice: true,
    };
  if (choiceLive) {
    const agent = choiceLive.agentId
      ? directory.agents.find((a) => a.id === choiceLive.agentId)
      : undefined;
    return {
      kind: "resolved",
      target: choiceLive,
      workspaceLabel: label(choiceLive.workspaceId)!,
      agentName: agent?.name ?? null,
      text: input.text,
      source: "choice",
      remember: false,
      announce: many,
    };
  }

  // 5. and 6. The Personal workspace, then a sole workspace.
  const fallback = defaultWorkspace(directory);
  if (fallback) {
    const personal = fallback === directory.personalWorkspaceId;
    return {
      kind: "resolved",
      target: { workspaceId: fallback, agentId: null },
      workspaceLabel: label(fallback)!,
      agentName: null,
      text: input.text,
      source: personal ? "personal" : "sole",
      remember: false,
      announce: many,
    };
  }
  if (candidates.length === 0) return { kind: "denied", text: TEAMS_NO_WORKSPACE_TEXT };
  // 7. A real choice: ask, and keep the message until they answer.
  return { kind: "ask", options: teamsRouteOptions(directory) };
}

/** Personal first, then a sole workspace; null when the person must choose. */
function defaultWorkspace(directory: TeamsRouteDirectory): string | null {
  if (directory.personalWorkspaceId) return directory.personalWorkspaceId;
  return directory.candidates.length === 1 ? directory.candidates[0]!.workspaceId : null;
}

/** The switch card's text: numbered rows that work without the buttons too. */
export function teamsSwitchCardText(
  options: readonly TeamsRouteOption[],
  current: { workspaceLabel: string | null; agentName: string | null } | null,
  waiting: boolean,
): string {
  const lead = waiting
    ? "Where should I work on this? Choose a workspace or one of your agents."
    : current?.workspaceLabel
      ? `This chat uses ${current.agentName ? `**${current.agentName}** in ` : ""}**${current.workspaceLabel}**. Choose another workspace or agent.`
      : "Choose the workspace or agent this chat uses.";
  const rows = options.map(
    (option, index) => `${index + 1}. **${option.title}** · ${option.detail}`,
  );
  return [lead, rows.join("\n"), "Select one, or send **switch** and its number."].join("\n\n");
}

/** The confirmation after choosing. */
export function teamsSwitchedText(target: { workspaceLabel: string; agentName: string | null }) {
  return target.agentName
    ? `Now using **${target.agentName}** in **${target.workspaceLabel}**. New messages go to this agent. Send **switch** to change.`
    : `Now using **${target.workspaceLabel}**. New messages start work there. Send **switch** to change.`;
}

/** The header on every reply from an agent: Teams can't change the bot's name per message. */
export function teamsAgentReplyHeader(agentName: string, workspaceName: string | null): string {
  return workspaceName ? `**${agentName}** · ${workspaceName}` : `**${agentName}**`;
}

/**
 * Whether the organization's Teams reach still includes a workspace for this
 * person, read live. Checked when a routed message is queued and before every
 * delivery, so an admin's narrower reach stops chats it no longer includes.
 */
export async function teamsWorkspaceInReach(
  db: Database,
  i: TeamsInstallation,
  subjectId: string,
  workspaceId: string,
): Promise<boolean> {
  if (workspaceId === i.workspace_id) return true;
  // One after the other: `db` may be a transaction.
  const reach = await getTeamsReach(db, i);
  const personal = await namedSubjectPersonalWorkspaceId(db, {
    accountId: i.account_id,
    subjectId,
  });
  return teamsReachIncludes(reach, i, { workspaceId, personal: personal === workspaceId });
}

/**
 * The person's live routing directory: the workspaces they can start work in
 * within the organization's reach (Personal ones only while the organization
 * allows them and they are open to new work), and the organization's shared
 * agents in reach, each marked usable when its workspace is a candidate.
 */
export async function loadTeamsRouteDirectory(
  db: Database,
  i: TeamsInstallation,
  subjectId: string,
): Promise<TeamsRouteDirectory> {
  const [routable, reach, privacy] = await Promise.all([
    listNamedSubjectSlackRoutableWorkspaces(db, { accountId: i.account_id, subjectId }),
    getTeamsReach(db, i),
    getOrganizationPrivacyPreferences(db, i.account_id),
  ]);
  const candidates: TeamsRouteWorkspace[] = [];
  for (const workspace of routable) {
    if (workspace.accountId !== i.account_id) continue;
    if (!teamsReachIncludes(reach, i, workspace)) continue;
    if (
      workspace.personal &&
      (!privacy.personalWorkspacesEnabled ||
        (await personalWorkspaceClosedToNewWork(db, {
          accountId: i.account_id,
          workspaceId: workspace.workspaceId,
        })))
    )
      continue;
    candidates.push({
      workspaceId: workspace.workspaceId,
      label: workspace.label,
      personal: workspace.personal,
    });
  }
  const usable = new Set(candidates.map((c) => c.workspaceId));
  const agents = (
    await listTeamsAgentDirectory(db, { accountId: i.account_id, workspaceIds: null })
  )
    .filter((agent) =>
      teamsReachIncludes(reach, i, { workspaceId: agent.workspaceId, personal: false }),
    )
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      nameKey: agent.nameKey,
      targetAccountId: agent.accountId,
      targetWorkspaceId: agent.workspaceId,
      targetWorkspaceLabel: agent.workspaceName,
      usable: usable.has(agent.workspaceId),
    }));
  return {
    candidates,
    agents,
    personalWorkspaceId: candidates.find((c) => c.personal)?.workspaceId ?? null,
  };
}
