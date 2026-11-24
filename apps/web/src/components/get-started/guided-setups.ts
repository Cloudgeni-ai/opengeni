/**
 * Guided setups (docs/agents.md#guided-setups): a few ready-made
 * engineering setups, each three steps that end with something working.
 *
 * 1. Connect the tool it needs, through the existing Connect pages.
 * 2. Add a ready-made agent (packages/core/src/agent-templates).
 * 3. Turn on one of that agent's suggested triggers, through the agent
 *    page's own Add trigger dialog.
 *
 * Each step reads its state from the workspace, so a setup finished
 * elsewhere (the Agents page, Capabilities) shows as done here too.
 */
import type { AgentSummary, CapabilityCatalogItem, ScheduledTask } from "@opengeni/sdk";

export type GuidedSetupKey = "pr-reviews" | "issue-triage" | "product-analytics";

export type GuidedSetupConnection =
  | { kind: "github"; name: "GitHub" }
  /** A catalog connector, found by its MCP address. */
  | { kind: "catalog"; name: string; mcpUrl: string };

export type GuidedSetup = {
  key: GuidedSetupKey;
  title: string;
  description: string;
  icon: "git-pull-request" | "list-checks" | "chart-line";
  connection: GuidedSetupConnection;
  /** The ready-made agent it adds. */
  agentTemplateKey: string;
  agentName: string;
  /** The name of the agent template's suggested trigger it turns on. */
  triggerName: string;
  /** What the trigger step does, in words. */
  triggerLabel: string;
  /** The last line once everything is done. */
  ready: string;
};

export const GUIDED_SETUPS: readonly GuidedSetup[] = [
  {
    key: "pr-reviews",
    title: "Review pull requests",
    description: "An agent reviews each new pull request.",
    icon: "git-pull-request",
    connection: { kind: "github", name: "GitHub" },
    agentTemplateKey: "pr-reviewer",
    agentName: "PR reviewer",
    triggerName: "When a pull request opens",
    triggerLabel: "Review each new pull request",
    ready: "PR reviewer reviews each new pull request.",
  },
  {
    key: "issue-triage",
    title: "Triage issues",
    description: "An agent sorts and labels each new Linear issue.",
    icon: "list-checks",
    connection: { kind: "catalog", name: "Linear", mcpUrl: "https://mcp.linear.app/mcp" },
    agentTemplateKey: "triage",
    agentName: "Triage",
    triggerName: "When a Linear issue is created",
    triggerLabel: "Triage each new Linear issue",
    ready: "Triage sorts each new Linear issue.",
  },
  {
    key: "product-analytics",
    title: "Track product analytics",
    description: "An agent sends a weekly PostHog report.",
    icon: "chart-line",
    connection: { kind: "catalog", name: "PostHog", mcpUrl: "https://mcp.posthog.com/mcp" },
    agentTemplateKey: "product-analyst",
    agentName: "Product analyst",
    triggerName: "Every Monday morning",
    triggerLabel: "Send a report every Monday",
    ready: "Product analyst sends a report every Monday.",
  },
];

export function guidedSetupByKey(key: string | undefined): GuidedSetup | null {
  return GUIDED_SETUPS.find((setup) => setup.key === key) ?? null;
}

function normalizedUrl(url: string | null | undefined): string {
  return (url ?? "").trim().replace(/\/+$/u, "").toLowerCase();
}

/**
 * The catalog entry for a connector, by its MCP address: one already on
 * here first, then any other. Null when this deployment doesn't offer it.
 */
export function catalogItemFor(
  items: readonly CapabilityCatalogItem[],
  mcpUrl: string,
): CapabilityCatalogItem | null {
  const wanted = normalizedUrl(mcpUrl);
  const matches = items.filter(
    (item) => item.kind === "mcp" && normalizedUrl(item.mcpUrl ?? item.endpointUrl) === wanted,
  );
  return matches.find((item) => item.enabled) ?? matches[0] ?? null;
}

/** Whether a catalog connector is on and ready to use here. */
export function catalogItemConnected(item: CapabilityCatalogItem | null): boolean {
  return item !== null && item.enabled && item.lifecycle.readiness === "ready";
}

/** The agent added from this setup's template: one the reader can edit first. */
export function agentForSetup(
  agents: readonly AgentSummary[],
  setup: Pick<GuidedSetup, "agentTemplateKey">,
): AgentSummary | null {
  const matches = agents.filter((agent) => agent.templateKey === setup.agentTemplateKey);
  return matches.find((agent) => agent.viewer.canEdit) ?? matches[0] ?? null;
}

/**
 * Whether the agent has this setup's trigger, switched on: the same naming
 * rule as the agent page, which names a trigger added from a suggestion
 * after it. A paused one doesn't count.
 */
export function setupTriggerOn(
  tasks: readonly ScheduledTask[],
  agentId: string,
  setup: Pick<GuidedSetup, "triggerName">,
): boolean {
  return tasks.some(
    (task) =>
      task.status === "active" &&
      task.agentConfig.agentId === agentId &&
      task.name.endsWith(setup.triggerName),
  );
}

/**
 * Where Capabilities opens a catalog connector's page, with its Connect
 * button; Capabilities itself when the catalog couldn't be read.
 */
export function catalogConnectHref(workspaceId: string, itemId: string | null): string {
  const page = `/workspaces/${encodeURIComponent(workspaceId)}/plugins`;
  return itemId ? `${page}?open=${encodeURIComponent(`item:${itemId}`)}` : page;
}
