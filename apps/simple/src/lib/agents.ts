import type { Session } from "@opengeni/sdk";
import type { AgentProfile, UsageSummary } from "./app-api";

export type Agent = {
  id: string;
  session: Session;
  name: string;
  role: "main" | "agent";
  emoji: string;
  description: string | null;
  shared: boolean;
  profile: AgentProfile | null;
  score: number;
  lastUsedAt: string | null;
  lastActivityAt: string;
  working: boolean;
  needsYou: boolean;
  unread: boolean;
};

type SimpleMetadata = {
  kind?: string;
  role?: string;
  shared?: boolean;
  blank?: boolean;
};

export function simpleMetadata(session: Session): SimpleMetadata | null {
  const value = session.metadata?.simpleApp;
  return value && typeof value === "object" ? (value as SimpleMetadata) : null;
}

const WORKING = new Set(["running", "queued", "recovering", "waiting_capacity", "starting"]);
const ABANDONED_AFTER_MS = 2 * 60 * 1000;

/**
 * Older builds made a "New agent" the moment the button was pressed. One that
 * was never told anything is clutter, not an agent.
 */
function isAbandonedBlank(
  session: Session,
  metadata: SimpleMetadata,
  profile: AgentProfile | null,
) {
  return (
    metadata.blank === true &&
    (profile?.name ?? "New agent") === "New agent" &&
    // Only creation bookkeeping, never a single turn.
    session.lastSequence < 10 &&
    session.activeTurnId == null &&
    !WORKING.has(String(session.status)) &&
    Date.now() - Date.parse(session.createdAt) > ABANDONED_AFTER_MS
  );
}

export function toAgents(
  sessions: Session[],
  profiles: AgentProfile[],
  usage: UsageSummary[],
): Agent[] {
  const profileById = new Map(profiles.map((profile) => [profile.sessionId, profile]));
  const usageById = new Map(usage.map((entry) => [entry.sessionId, entry]));
  return sessions
    .filter((session) => {
      const metadata = simpleMetadata(session);
      if (metadata?.kind !== "agent" || session.archived) return false;
      return !isAbandonedBlank(session, metadata, profileById.get(session.id) ?? null);
    })
    .map((session) => {
      const metadata = simpleMetadata(session)!;
      const profile = profileById.get(session.id) ?? null;
      const role = metadata.role === "main" ? "main" : "agent";
      const status = String(session.status);
      return {
        id: session.id,
        session,
        name: role === "main" ? "Geni" : (profile?.name ?? session.title ?? "Agent"),
        role,
        emoji: profile?.emoji ?? (role === "main" ? "✨" : "🤖"),
        description: profile?.description ?? null,
        shared: metadata.shared === true,
        profile,
        score: usageById.get(session.id)?.score ?? 0,
        lastUsedAt: usageById.get(session.id)?.lastUsedAt ?? null,
        lastActivityAt: session.updatedAt,
        working: session.activelyWorking === true || WORKING.has(status),
        needsYou: status === "requires_action",
        unread: session.unread === true,
      } satisfies Agent;
    });
}

export type SidebarSection = {
  id: string;
  label: string | null;
  agents: Agent[];
  collapsible?: boolean;
};

const QUIET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const NEW_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The sidebar organizes itself: Geni first, then pins, then personal agents and
 * the workspace's shared agents, each ordered by how much and how recently they
 * are used (with anything that needs you or has news lifted to the top). Agents
 * nobody has touched in two weeks fold into "Quiet".
 */
export function organizeSidebar(agents: Agent[]): SidebarSection[] {
  const now = Date.now();
  const main = agents.filter((agent) => agent.role === "main");
  const rest = agents.filter((agent) => agent.role !== "main");
  const pinned = rest.filter((agent) => agent.session.pinned);
  const unpinned = rest.filter((agent) => !agent.session.pinned);
  const rank = (agent: Agent) =>
    agent.score +
    (agent.needsYou ? 100 : 0) +
    (agent.unread ? 20 : 0) +
    (agent.working ? 5 : 0) +
    recency(agent.lastActivityAt, now);
  const isQuiet = (agent: Agent) => {
    if (agent.needsYou || agent.unread || agent.working) return false;
    const touched = Math.max(
      agent.lastUsedAt ? Date.parse(agent.lastUsedAt) : 0,
      Date.parse(agent.lastActivityAt),
    );
    const created = Date.parse(agent.session.createdAt);
    return now - touched > QUIET_AFTER_MS && now - created > NEW_GRACE_MS;
  };
  const active = unpinned.filter((agent) => !isQuiet(agent)).sort((a, b) => rank(b) - rank(a));
  const quiet = unpinned.filter(isQuiet).sort((a, b) => rank(b) - rank(a));
  const sections: SidebarSection[] = [{ id: "main", label: null, agents: main }];
  if (pinned.length) {
    sections.push({
      id: "pinned",
      label: "Pinned",
      agents: pinned.sort((a, b) =>
        (a.session.pinnedAt ?? "").localeCompare(b.session.pinnedAt ?? ""),
      ),
    });
  }
  const personal = active.filter((agent) => !agent.shared);
  const workspace = active.filter((agent) => agent.shared);
  if (personal.length) sections.push({ id: "personal", label: "Personal", agents: personal });
  if (workspace.length) sections.push({ id: "workspace", label: "Workspace", agents: workspace });
  if (quiet.length)
    sections.push({
      id: "quiet",
      label: "Quiet",
      agents: quiet,
      collapsible: true,
    });
  return sections;
}

/** A small bonus for activity in the last day, so fresh agents surface. */
function recency(iso: string, now: number) {
  const age = now - Date.parse(iso);
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.max(0, 2 * (1 - age / (24 * 60 * 60 * 1000)));
}

export function relativeTime(iso: string | null) {
  if (!iso) return "never";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Deterministic gradient per agent, for the emoji fallback avatar. */
export function agentGradient(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue} 80% 62%), hsl(${(hue + 50) % 360} 85% 55%))`;
}
