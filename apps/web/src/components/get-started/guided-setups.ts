/**
 * Guided setups (docs/agents.md#guided-setups): a few ready-made engineering
 * setups. Get started shows them beside an example of what each one produces;
 * one button opens the setup on the Enable page (components/enable), the same
 * page that turns on any ready-made agent or app.
 *
 * A setup is a ready-made agent (packages/core/src/agent-templates) plus the
 * suggested trigger it turns on. What it needs comes from that template's
 * `setup.connections`, so Get started, Enable and the server agree; a setup
 * may only make more of the agent's own connections required (Linear for
 * issue triage), never another agent.
 */
import type { AgentSummary, AgentTemplate, ScheduledTask } from "@opengeni/sdk";

export type GuidedSetupKey = "pr-reviews" | "issue-triage" | "product-analytics";

/** One line of an example outcome, with its status dot. */
export type SetupExampleLine = {
  label: string;
  tone: "danger" | "attention" | "success" | "neutral";
  text: string;
};

/** What the setup's agent produces, shown on Get started labelled "Example". */
export type SetupExample = {
  /** What it worked on: "Retry webhook delivery with backoff". */
  subject: string;
  subjectMeta: string;
  /** The agent's verdict: "Changes requested". */
  verdict: string;
  verdictTone: "attention" | "success" | "progress";
  lines: readonly SetupExampleLine[];
};

export type GuidedSetup = {
  key: GuidedSetupKey;
  title: string;
  description: string;
  icon: "git-pull-request" | "list-checks" | "chart-line";
  /** The ready-made agent it turns on. */
  agentTemplateKey: string;
  agentName: string;
  /** The name of the agent template's suggested trigger it turns on. */
  triggerName: string;
  /** Providers of the agent's own connections this setup needs although the agent alone doesn't. */
  requireProviders: readonly string[];
  /** The primary button on Get started: "Set up PR reviews". */
  action: string;
  example: SetupExample;
};

export const GUIDED_SETUPS: readonly GuidedSetup[] = [
  {
    key: "pr-reviews",
    title: "Review pull requests",
    description: "Catch bugs and risky changes before they merge.",
    icon: "git-pull-request",
    agentTemplateKey: "pr-reviewer",
    agentName: "PR reviewer",
    triggerName: "When a pull request opens",
    requireProviders: [],
    action: "Set up PR reviews",
    example: {
      subject: "Retry webhook delivery with backoff",
      subjectMeta: "#8142 · 4 files",
      verdict: "Changes requested",
      verdictTone: "attention",
      lines: [
        {
          label: "Must fix",
          tone: "danger",
          text: "Retries never stop when the endpoint returns 410.",
        },
        {
          label: "Should fix",
          tone: "attention",
          text: "Backoff has no jitter, so retries arrive together.",
        },
        { label: "Good", tone: "success", text: "Tests cover the timeout path." },
      ],
    },
  },
  {
    key: "issue-triage",
    title: "Triage new issues",
    description: "Sort, label and route every new Linear issue.",
    icon: "list-checks",
    agentTemplateKey: "triage",
    agentName: "Triage",
    triggerName: "When a Linear issue is created",
    requireProviders: ["linear.app"],
    action: "Set up triage",
    example: {
      subject: "Sign-in fails on Safari after the update",
      subjectMeta: "ENG-412 · from support",
      verdict: "Triaged",
      verdictTone: "success",
      lines: [
        { label: "Label", tone: "neutral", text: "Bug, high priority." },
        { label: "Team", tone: "neutral", text: "Web, assigned to its on-call." },
        { label: "Linked", tone: "neutral", text: "Same error as ENG-398." },
      ],
    },
  },
  {
    key: "product-analytics",
    title: "Weekly product report",
    description: "What changed in PostHog, and why, every Monday.",
    icon: "chart-line",
    agentTemplateKey: "product-analyst",
    agentName: "Product analyst",
    triggerName: "Every Monday morning",
    requireProviders: [],
    action: "Set up the report",
    example: {
      subject: "Product report, week 47",
      subjectMeta: "Monday 09:00 · PostHog",
      verdict: "Sent",
      verdictTone: "progress",
      lines: [
        { label: "Up", tone: "success", text: "Sign-ups 1,240, 8% more than last week." },
        { label: "Down", tone: "danger", text: "Activation 41%, 3 points lower." },
        { label: "Why", tone: "neutral", text: "Most new people stop at the invite step." },
      ],
    },
  },
];

export function guidedSetupByKey(key: string | undefined): GuidedSetup | null {
  return GUIDED_SETUPS.find((setup) => setup.key === key) ?? null;
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
 * The agent's trigger for this setup, whatever its state: on, paused (Turn on
 * resumes it rather than adding another) or none. The same naming rule as the
 * agent page, which names a trigger added from a suggestion after it.
 */
export function setupTriggerTask(
  tasks: readonly ScheduledTask[],
  agentId: string,
  setup: Pick<GuidedSetup, "triggerName">,
): ScheduledTask | null {
  const matches = tasks.filter(
    (task) => task.agentConfig.agentId === agentId && task.name.endsWith(setup.triggerName),
  );
  return matches.find((task) => task.status === "active") ?? matches[0] ?? null;
}

/**
 * Where Capabilities opens a catalog connector's page, with its Connect
 * button; Capabilities itself when the catalog couldn't be read. With
 * `returnTo`, its back link (and a finished sign-in) returns there.
 */
export function catalogConnectHref(
  workspaceId: string,
  itemId: string | null,
  returnTo?: { path: string; label: string },
): string {
  const page = `/workspaces/${encodeURIComponent(workspaceId)}/plugins`;
  const params = new URLSearchParams();
  if (itemId) params.set("open", `item:${itemId}`);
  if (returnTo) {
    params.set("from", returnTo.path);
    params.set("fromLabel", returnTo.label);
  }
  const search = params.toString();
  return search ? `${page}?${search}` : page;
}

/**
 * What a setup needs, by name: its agent's required connections plus the ones
 * the setup itself requires. "GitHub", "Linear". Empty when nothing is.
 */
export function setupNeeds(
  setup: Pick<GuidedSetup, "requireProviders">,
  template: Pick<AgentTemplate, "setup"> | null | undefined,
): string[] {
  return (template?.setup?.connections ?? [])
    .filter(
      (connection) => connection.required || setup.requireProviders.includes(connection.provider),
    )
    .map((connection) => connection.name);
}

/** "Needs GitHub", "Needs GitHub and Linear"; null when it needs nothing. */
export function needsLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Needs ${list}`;
}
