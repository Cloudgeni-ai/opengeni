/**
 * Web view of the agent capability registry (`@opengeni/contracts`
 * agent-config). Every screen that shows or edits what an agent can do (the
 * workspace defaults page, the composer's Capabilities panel, the session
 * Agent panel and the schedule form) reads its groups, labels and request
 * shapes from here, so they cannot drift from the server's meaning.
 *
 * A "draft" is what a picker edits: a starting point plus the full value of
 * every capability. `requestFromDraft` turns it back into the smallest
 * `AgentCapabilities` request (a starting point plus only the toggles that
 * differ from it), which is what the server stores and what people read in
 * the API.
 */
import {
  AGENT_CAPABILITY_DESCRIPTIONS,
  AGENT_CAPABILITY_IDS,
  allAgentCapabilities,
  noneAgentCapabilities,
  type AgentCapabilities,
  type AgentCapabilityId,
  type AgentCapabilityStartingPoint,
  type AgentCapabilityToggles,
  type AgentSkillsCapability,
  type ClientAgentConfig,
  type ResolvedAgentCapabilities,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";

export type { AgentCapabilityId, ResolvedAgentCapabilities };

export type AgentCapabilityGroup = {
  id: "conversation" | "work" | "workspace";
  label: string;
  capabilities: readonly AgentCapabilityId[];
};

/** Three groups, in the order people scan them. Every capability appears once. */
export const AGENT_CAPABILITY_GROUPS: readonly AgentCapabilityGroup[] = [
  { id: "conversation", label: "Conversation", capabilities: ["humanInput", "webSearch", "media"] },
  {
    id: "work",
    label: "Work",
    capabilities: ["goals", "subagents", "skills", "artifacts", "browser", "schedules"],
  },
  {
    id: "workspace",
    label: "Workspace",
    capabilities: ["knowledge", "workspaceFiles", "workspaceConnectors", "workspaceAdmin"],
  },
];

export function capabilityLabel(id: AgentCapabilityId): string {
  return AGENT_CAPABILITY_DESCRIPTIONS[id].label;
}

export function capabilityDescription(id: AgentCapabilityId): string {
  return AGENT_CAPABILITY_DESCRIPTIONS[id].description;
}

/** The two starting points, in product words, each with its consequence. */
export const AGENT_STARTING_POINTS: readonly {
  value: AgentCapabilityStartingPoint;
  title: string;
  description: string;
}[] = [
  {
    value: "all",
    title: "Everything this workspace offers",
    description: "Every capability is on unless you turn it off.",
  },
  {
    value: "none",
    title: "Only what you choose",
    description:
      "Starts with its own tools, asking questions and reading Skills. Turn on the rest as needed.",
  },
];

export const SKILLS_OPTIONS: readonly { value: "off" | "read" | "manage"; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "manage", label: "Read and manage" },
];

export function skillsOptionValue(value: AgentSkillsCapability): "off" | "read" | "manage" {
  return value === false ? "off" : value;
}

export function skillsFromOption(value: "off" | "read" | "manage"): AgentSkillsCapability {
  return value === "off" ? false : value;
}

export const UNAVAILABLE_CAPABILITY_REASON = "Not enabled on this server";

/** Capabilities this deployment offers. Unknown ids (an older server) count as available. */
export type CapabilityAvailability = {
  isAvailable: (id: AgentCapabilityId) => boolean;
  unavailable: ReadonlySet<AgentCapabilityId>;
};

export function capabilityAvailability(
  config: Pick<ClientAgentConfig, "capabilities"> | null | undefined,
  alsoUnavailable: readonly AgentCapabilityId[] = [],
): CapabilityAvailability {
  const unavailable = new Set<AgentCapabilityId>(alsoUnavailable);
  for (const entry of config?.capabilities ?? []) {
    if (!entry.available) unavailable.add(entry.id);
  }
  return { unavailable, isAvailable: (id) => !unavailable.has(id) };
}

export function baseCapabilities(from: AgentCapabilityStartingPoint): ResolvedAgentCapabilities {
  return from === "all" ? allAgentCapabilities() : noneAgentCapabilities();
}

export type AgentCapabilityDraft = {
  from: AgentCapabilityStartingPoint;
  values: ResolvedAgentCapabilities;
};

function applyToggles(
  base: ResolvedAgentCapabilities,
  toggles: AgentCapabilityToggles,
): ResolvedAgentCapabilities {
  const next = { ...base };
  for (const id of AGENT_CAPABILITY_IDS) {
    const value = toggles[id];
    if (value === undefined) continue;
    if (id === "skills") next.skills = value as AgentSkillsCapability;
    else next[id] = value as boolean;
  }
  return next;
}

/**
 * The editable form of a request. Omitted means "everything". A workspace's
 * older "Ask questions" setting (off) still turns the default off unless the
 * request says otherwise, matching the server's resolution.
 */
export function draftFromRequest(
  capabilities: AgentCapabilities | undefined,
  options: { legacyHumanInputOff?: boolean } = {},
): AgentCapabilityDraft {
  const from: AgentCapabilityStartingPoint =
    capabilities === undefined
      ? "all"
      : typeof capabilities === "string"
        ? capabilities
        : capabilities.from;
  const toggles: AgentCapabilityToggles =
    capabilities === undefined || typeof capabilities === "string"
      ? {}
      : (({ from: _from, ...rest }) => rest)(capabilities);
  const values = applyToggles(baseCapabilities(from), toggles);
  if (options.legacyHumanInputOff && toggles.humanInput === undefined) values.humanInput = false;
  return { from, values };
}

/** A frozen session configuration as a draft (for editing a running session). */
export function draftFromResolved(config: ResolvedAgentConfig): AgentCapabilityDraft {
  return { from: config.from, values: { ...config.capabilities } };
}

/**
 * The smallest request for a draft: its starting point, plus only the
 * capabilities that differ from it. A capability this server does not offer
 * is never sent as on (the server would refuse it).
 */
export function requestFromDraft(
  draft: AgentCapabilityDraft,
  availability?: CapabilityAvailability,
): AgentCapabilities {
  const base = baseCapabilities(draft.from);
  const toggles: AgentCapabilityToggles = {};
  for (const id of AGENT_CAPABILITY_IDS) {
    const value = draft.values[id];
    if (value === base[id]) continue;
    if (availability && !availability.isAvailable(id) && value !== false) continue;
    (toggles as Record<string, boolean | string>)[id] = value;
  }
  return Object.keys(toggles).length === 0 ? draft.from : { from: draft.from, ...toggles };
}

/** Switch the starting point: every capability takes that starting point's value. */
export function withStartingPoint(
  draft: AgentCapabilityDraft,
  from: AgentCapabilityStartingPoint,
): AgentCapabilityDraft {
  return draft.from === from ? draft : { from, values: baseCapabilities(from) };
}

export function withCapability(
  draft: AgentCapabilityDraft,
  id: AgentCapabilityId,
  value: boolean | AgentSkillsCapability,
): AgentCapabilityDraft {
  return { ...draft, values: { ...draft.values, [id]: value } };
}

export function capabilityOn(values: ResolvedAgentCapabilities, id: AgentCapabilityId): boolean {
  return id === "skills" ? values.skills !== false : values[id] === true;
}

/** What actually runs: a capability the server doesn't offer is off. */
export function effectiveCapabilityOn(
  values: ResolvedAgentCapabilities,
  id: AgentCapabilityId,
  availability: CapabilityAvailability,
): boolean {
  return availability.isAvailable(id) && capabilityOn(values, id);
}

export function draftsEqual(left: AgentCapabilityDraft, right: AgentCapabilityDraft): boolean {
  return (
    left.from === right.from &&
    AGENT_CAPABILITY_IDS.every((id) => left.values[id] === right.values[id])
  );
}

/**
 * One short line for a chip or a muted row value: "All capabilities",
 * "9 of 13 capabilities". Counts only what this server offers.
 */
export function capabilitySummary(
  values: ResolvedAgentCapabilities,
  availability: CapabilityAvailability,
): string {
  const offered = AGENT_CAPABILITY_IDS.filter((id) => availability.isAvailable(id));
  const on = offered.filter((id) => capabilityOn(values, id)).length;
  if (on === offered.length) return "All capabilities";
  if (on === 0) return "No capabilities";
  return `${on} of ${offered.length} capabilities`;
}

/** Product words for the state of one capability, for read-only views. */
export function capabilityStateLabel(
  values: ResolvedAgentCapabilities,
  id: AgentCapabilityId,
  availability: CapabilityAvailability,
): string {
  if (!availability.isAvailable(id)) return UNAVAILABLE_CAPABILITY_REASON;
  if (id === "skills") {
    return values.skills === "manage"
      ? "Read and manage"
      : values.skills === "read"
        ? "Read"
        : "Off";
  }
  return values[id] ? "On" : "Off";
}

/** The workspace's saved defaults, or null when it follows OpenGeni's defaults. */
export function workspaceAgentDefaultsDraft(input: {
  capabilities: AgentCapabilities | undefined;
  legacyHumanInputOff: boolean;
}): AgentCapabilityDraft {
  return draftFromRequest(input.capabilities, { legacyHumanInputOff: input.legacyHumanInputOff });
}

/** Tool owner in product words, for the Technical details list. */
export function toolOwnerLabel(owner: AgentCapabilityId | "runtime" | "sandbox" | "product") {
  switch (owner) {
    case "runtime":
      return "Always available";
    case "sandbox":
      return "Sandbox";
    case "product":
      return "Added to this session";
    default:
      return capabilityLabel(owner);
  }
}

/**
 * Agent-setting failures in product words: what happened and what to do.
 * The raw API text (with its reference) is only a last resort.
 */
export function agentConfigErrorText(error: unknown, fallback: string): string {
  const failure = error as {
    status?: unknown;
    code?: unknown;
    details?: Record<string, unknown> | undefined;
    message?: unknown;
  } | null;
  if (!failure || typeof failure !== "object") return fallback;
  if (failure.status === 409) {
    return "Someone changed these settings while you were editing. Nothing was saved. Check the current settings and try again.";
  }
  const details = failure.details ?? {};
  const code = String(details.code ?? failure.code ?? "");
  const capability =
    typeof details.capability === "string" &&
    (AGENT_CAPABILITY_IDS as readonly string[]).includes(details.capability)
      ? capabilityLabel(details.capability as AgentCapabilityId)
      : null;
  switch (code) {
    case "agent_config_not_enabled":
      return "Agent settings aren't turned on for this OpenGeni server yet. Ask whoever runs it.";
    case "agent_capability_unavailable":
      return capability
        ? `${capability} isn't enabled on this server. Turn it off and save again.`
        : "One of these capabilities isn't enabled on this server. Turn it off and save again.";
    case "agent_config_widening":
      return capability
        ? `This session can't turn on ${capability}: the session that started it doesn't have it.`
        : "This session can't have more than the session that started it.";
    case "agent_config_conflict":
      return "These settings conflict with the tools chosen for this session. Change one of them and save again.";
    default:
      return failure.status === 403
        ? "You don't have permission to change this. Ask a workspace admin."
        : fallback;
  }
}
