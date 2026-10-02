import type { ConfirmDependency } from "@/components/ui/destructive-confirm";

import {
  KIT_NOW,
  chats,
  emptyVariableSet,
  organization,
  sandboxEnvironments,
  schedules,
  variableSets,
  type VariableKind,
  type VariableSetScope,
  type VariableSetUsage,
} from "../../fixtures";

/* ----------------------------------------------------------------------------
   The in-memory data behind the Variable sets page previews. Everything is a
   fixture; nothing talks to the network. Each preview pane owns its own copy.
   -------------------------------------------------------------------------- */

export interface PreviewVariable {
  name: string;
  kind: VariableKind;
  /** Plain values only. Secrets are write-only. */
  value?: string;
  /** Write counter, only for the "keep version numbers" answer to Q18. */
  version: number;
  updatedAt: string;
}

export interface PreviewSet {
  id: string;
  name: string;
  description: string;
  scope: VariableSetScope;
  variables: PreviewVariable[];
  usedBy: VariableSetUsage[];
  updatedAt: string;
}

/** Which data the page shows: the fixtures, a long list, nothing, or a failed load. */
export type DataState = "default" | "many" | "empty" | "loading" | "error";

const NOW_ISO = KIT_NOW.toISOString();

function fromFixture(set: (typeof variableSets)[number]): PreviewSet {
  return {
    id: set.id,
    name: set.name,
    description: set.description,
    scope: set.scope,
    usedBy: set.usedBy,
    updatedAt: set.updatedAt,
    variables: set.variables.map((variable) => ({
      name: variable.name,
      kind: variable.kind,
      value: variable.value,
      // Secrets have been replaced once or twice; plain config was set once.
      version: variable.kind === "secret" ? (variable.name.endsWith("_KEY") ? 3 : 2) : 1,
      updatedAt: variable.updatedAt,
    })),
  };
}

function secret(name: string, updatedAt: string, version = 1): PreviewVariable {
  return { name, kind: "secret", version, updatedAt };
}

function plain(name: string, value: string, updatedAt: string): PreviewVariable {
  return { name, kind: "plain", value, version: 1, updatedAt };
}

/** Eight more sets for the "many sets" state, so search appears (past 10). */
const EXTRA_SETS: PreviewSet[] = [
  {
    ...emptyVariableSet,
    scope: "workspace",
    usedBy: [{ kind: "schedule", kindLabel: "Schedule", name: "Summarize new Sentry errors" }],
    updatedAt: "2026-09-24T08:10:00Z",
    variables: [
      secret("SENTRY_AUTH_TOKEN", "2026-09-24T08:10:00Z", 2),
      plain("SENTRY_ORG", "acme-robotics", "2026-09-24T08:10:00Z"),
    ],
  },
  {
    id: "vs-stripe-test",
    name: "Stripe test mode",
    description: "Restricted test-mode key for the billing flows in staging.",
    scope: "workspace",
    usedBy: [],
    updatedAt: "2026-09-19T13:30:00Z",
    variables: [
      secret("STRIPE_SECRET_KEY", "2026-09-19T13:30:00Z"),
      plain("STRIPE_ACCOUNT", "acct_1ExampleAcme", "2026-09-19T13:30:00Z"),
    ],
  },
  {
    id: "vs-slack-alerts",
    name: "Slack alerts webhook",
    description: "Incoming webhook that posts to #eng-alerts.",
    scope: "workspace",
    usedBy: [],
    updatedAt: "2026-09-02T09:00:00Z",
    variables: [secret("SLACK_WEBHOOK_URL", "2026-09-02T09:00:00Z")],
  },
  {
    id: "vs-snowflake",
    name: "Snowflake reader",
    description: "Read-only warehouse user for the revenue dashboards.",
    scope: "workspace",
    usedBy: [],
    updatedAt: "2026-08-28T10:15:00Z",
    variables: [
      plain("SNOWFLAKE_ACCOUNT", "acme-eu1", "2026-08-28T10:15:00Z"),
      plain("SNOWFLAKE_USER", "agent_reader", "2026-08-28T10:15:00Z"),
      secret("SNOWFLAKE_PASSWORD", "2026-08-28T10:15:00Z", 2),
    ],
  },
  {
    id: "vs-pagerduty",
    name: "PagerDuty",
    description: "Events API key so agents can open and resolve incidents.",
    scope: "workspace",
    usedBy: [],
    updatedAt: "2026-08-20T15:45:00Z",
    variables: [secret("PAGERDUTY_ROUTING_KEY", "2026-08-20T15:45:00Z")],
  },
  {
    id: "vs-cloudflare",
    name: "Cloudflare DNS",
    description: "Scoped API token for the acme.dev zone.",
    scope: "workspace",
    usedBy: [],
    updatedAt: "2026-08-11T12:00:00Z",
    variables: [
      secret("CLOUDFLARE_API_TOKEN", "2026-08-11T12:00:00Z"),
      plain("CLOUDFLARE_ZONE_ID", "3f9ac27e41b8", "2026-08-11T12:00:00Z"),
    ],
  },
  {
    id: "vs-npm",
    name: "npm publish",
    description: "Automation token for publishing @acme-robotics packages.",
    scope: "workspace",
    usedBy: [],
    updatedAt: "2026-07-30T08:20:00Z",
    variables: [secret("NPM_TOKEN", "2026-07-30T08:20:00Z", 3)],
  },
  {
    id: "vs-linear",
    name: "Linear API",
    description: "API key for the triage automation in the Platform team.",
    scope: "workspace",
    usedBy: [],
    updatedAt: "2026-07-14T16:05:00Z",
    variables: [secret("LINEAR_API_KEY", "2026-07-14T16:05:00Z")],
  },
];

export function seedSets(state: DataState): PreviewSet[] {
  if (state === "empty") return [];
  const base = variableSets.map(fromFixture);
  if (state !== "many") return base;
  const organizationSets = base.filter((set) => set.scope === "organization");
  const workspaceSets = base.filter((set) => set.scope !== "organization");
  return [...workspaceSets, ...EXTRA_SETS, ...organizationSets];
}

/** The empty set from the fixtures ("Sentry"), for the detail page's empty state. */
export function emptySet(): PreviewSet {
  return {
    id: emptyVariableSet.id,
    name: emptyVariableSet.name,
    description: emptyVariableSet.description,
    scope: emptyVariableSet.scope,
    usedBy: [],
    updatedAt: emptyVariableSet.updatedAt,
    variables: [],
  };
}

/* ----------------------------------------------------------------------------
   Reducer.
   -------------------------------------------------------------------------- */

export interface NewVariable {
  name: string;
  kind: VariableKind;
  value?: string;
}

export type SetsAction =
  | { type: "reset"; sets: PreviewSet[] }
  | { type: "create"; set: PreviewSet }
  | { type: "update"; id: string; name: string; description: string }
  | { type: "delete-set"; id: string }
  | { type: "restore-set"; set: PreviewSet; index: number }
  | { type: "upsert-variables"; id: string; variables: NewVariable[] }
  | { type: "replace-value"; id: string; name: string; value?: string }
  | { type: "delete-variable"; id: string; name: string }
  | { type: "restore-variable"; id: string; variable: PreviewVariable; index: number };

function touch(set: PreviewSet): PreviewSet {
  return { ...set, updatedAt: NOW_ISO };
}

export function setsReducer(sets: PreviewSet[], action: SetsAction): PreviewSet[] {
  switch (action.type) {
    case "reset":
      return action.sets;
    case "create":
      return [...sets, action.set];
    case "update":
      return sets.map((set) =>
        set.id === action.id
          ? touch({ ...set, name: action.name, description: action.description })
          : set,
      );
    case "delete-set":
      return sets.filter((set) => set.id !== action.id);
    case "restore-set": {
      const next = [...sets];
      next.splice(Math.min(action.index, next.length), 0, action.set);
      return next;
    }
    case "upsert-variables":
      return sets.map((set) => {
        if (set.id !== action.id) return set;
        const variables = [...set.variables];
        for (const incoming of action.variables) {
          const index = variables.findIndex((variable) => variable.name === incoming.name);
          const saved: PreviewVariable = {
            name: incoming.name,
            kind: incoming.kind,
            value: incoming.kind === "plain" ? incoming.value : undefined,
            version: index === -1 ? 1 : variables[index]!.version + 1,
            updatedAt: NOW_ISO,
          };
          if (index === -1) variables.push(saved);
          else variables[index] = saved;
        }
        return touch({ ...set, variables });
      });
    case "replace-value":
      return sets.map((set) =>
        set.id === action.id
          ? touch({
              ...set,
              variables: set.variables.map((variable) =>
                variable.name === action.name
                  ? {
                      ...variable,
                      value: variable.kind === "plain" ? action.value : undefined,
                      version: variable.version + 1,
                      updatedAt: NOW_ISO,
                    }
                  : variable,
              ),
            })
          : set,
      );
    case "delete-variable":
      return sets.map((set) =>
        set.id === action.id
          ? touch({
              ...set,
              variables: set.variables.filter((variable) => variable.name !== action.name),
            })
          : set,
      );
    case "restore-variable":
      return sets.map((set) => {
        if (set.id !== action.id) return set;
        const variables = [...set.variables];
        variables.splice(Math.min(action.index, variables.length), 0, action.variable);
        return { ...set, variables };
      });
  }
}

/* ----------------------------------------------------------------------------
   Copy helpers.
   -------------------------------------------------------------------------- */

/** "A", "A and B", "A, B and C". */
export function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function variablesLabel(set: PreviewSet): string {
  return set.variables.length === 0
    ? "No variables"
    : plural(set.variables.length, "variable", "variables");
}

/** ["1 schedule", "1 environment"]: what uses a set, one count per kind. */
export function usageParts(usedBy: VariableSetUsage[]): string[] {
  const count = (kind: VariableSetUsage["kind"]) =>
    usedBy.filter((usage) => usage.kind === kind).length;
  const parts: string[] = [];
  const scheduleCount = count("schedule");
  const chatCount = count("chat");
  const environmentCount = count("environment_default");
  if (scheduleCount) parts.push(plural(scheduleCount, "schedule", "schedules"));
  if (chatCount) parts.push(plural(chatCount, "chat", "chats"));
  if (environmentCount) parts.push(plural(environmentCount, "environment", "environments"));
  return parts;
}

/** "1 schedule and 1 environment", or null when nothing uses it. */
export function usageSummary(usedBy: VariableSetUsage[]): string | null {
  return usedBy.length === 0 ? null : joinAnd(usageParts(usedBy));
}

const USAGE_PLACE: Record<VariableSetUsage["kind"], string> = {
  schedule: "this schedule",
  chat: "this chat",
  environment_default: "this environment's defaults",
};

/** The blocked delete dialog's one line: what to do before the set can go. */
export function blockedDeleteHint(set: PreviewSet, verb: string): string {
  const then = `then you can ${verb.toLocaleLowerCase()} it.`;
  const only = set.usedBy.length === 1 ? set.usedBy[0] : undefined;
  return only
    ? `Remove it from ${USAGE_PLACE[only.kind]} first, ${then}`
    : `Remove it from each of these first, ${then}`;
}

export const SCOPE_LABEL: Record<VariableSetScope, string> = {
  workspace: "This workspace",
  organization: "Organization",
  personal: "Only me",
};

/** The chip next to a name: only for sets that aren't the workspace default. */
export function scopeChip(scope: VariableSetScope): string | null {
  return scope === "workspace" ? null : SCOPE_LABEL[scope];
}

export const SCOPE_HINT: Record<VariableSetScope, string> = {
  workspace: "Everyone in this workspace can use it in chats and schedules.",
  organization: `Every workspace in ${organization.name} can use it. Only organization admins can change it.`,
  personal: "Only you can use it, in any workspace. Only work you start gets these values.",
};

/** Who can use it, as a sentence, for places where it can no longer change. */
export const SCOPE_LOCKED: Record<VariableSetScope, string> = {
  workspace: "Everyone in this workspace can use it. That was chosen when it was created.",
  organization: `Every workspace in ${organization.name} can use it. That was chosen when it was created.`,
  personal: "Only you can use it. That was chosen when it was created.",
};

/* ----------------------------------------------------------------------------
   What uses a set: rows for "Used by" and dependencies for the delete dialog.
   -------------------------------------------------------------------------- */

export interface UsageEntry {
  id: string;
  kind: VariableSetUsage["kind"];
  name: string;
  /** "Schedule", "Chat", "Sandbox environment". */
  kindLabel: string;
  /** "Every weekday at 08:00 · Oslo". */
  detail: string;
  /** Where it lives in the app. */
  href: string;
}

export function usageEntries(set: PreviewSet): UsageEntry[] {
  return set.usedBy.map((usage, index) => {
    if (usage.kind === "schedule") {
      const schedule = schedules.find((each) => each.name === usage.name);
      return {
        id: schedule?.id ?? `schedule-${index}`,
        kind: usage.kind,
        name: usage.name,
        kindLabel: "Schedule",
        detail: schedule
          ? schedule.state === "paused"
            ? `${schedule.cadenceLabel} · Paused`
            : schedule.cadenceLabel
          : "Schedule",
        href: `/schedules?schedule=${schedule?.id ?? ""}`,
      };
    }
    if (usage.kind === "chat") {
      const chat = chats.find((each) => each.title === usage.name);
      return {
        id: chat?.id ?? `chat-${index}`,
        kind: usage.kind,
        name: usage.name,
        kindLabel: "Chat",
        detail: chat ? `Last message ${chat.updatedLabel.toLocaleLowerCase()}` : "Chat",
        href: `/chats/${chat?.id ?? ""}`,
      };
    }
    const environment = sandboxEnvironments.find((each) => each.name === usage.name);
    return {
      id: environment?.id ?? `environment-${index}`,
      kind: usage.kind,
      name: usage.name,
      kindLabel: "Sandbox environment",
      detail: environment?.isDefault
        ? "Added to every new session in this workspace"
        : "Added to sessions that use this environment",
      href: `/rigs/${environment?.id ?? ""}`,
    };
  });
}

export function confirmDependencies(set: PreviewSet): ConfirmDependency[] {
  return usageEntries(set).map((entry) => ({
    id: entry.id,
    kind: entry.kind === "environment_default" ? "environment" : entry.kind,
    kindLabel:
      entry.kind === "environment_default" ? "Sandbox environment default" : entry.kindLabel,
    name: entry.name,
    detail: entry.detail,
    href: entry.href,
  }));
}

/* ----------------------------------------------------------------------------
   Values for the "reveal with audit" answer to Q17. Obviously fake: AWS's own
   documented example keys and placeholder tokens.
   -------------------------------------------------------------------------- */

const EXAMPLE_SECRETS: Record<string, string> = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  GITHUB_BOT_TOKEN: "ghp_EXAMPLE0acmeRoboticsBotToken00000",
  DD_API_KEY: "0example0datadog0api0key0000000",
  DD_APP_KEY: "0example0datadog0application0key000000",
  DATABASE_URL: "postgres://agent_ro:example@staging-db.acme.dev:5432/app",
  EXPORT_TOKEN: "exp_example_finance_exports_token",
};

export function exampleSecret(name: string): string {
  return EXAMPLE_SECRETS[name] ?? `example-${name.toLocaleLowerCase().replaceAll("_", "-")}`;
}

/** A stable id for a set created in the preview. */
export function newSetId(name: string, taken: PreviewSet[]): string {
  const base = `vs-${
    name
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "new"
  }`;
  let id = base;
  let counter = 2;
  while (taken.some((set) => set.id === id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  return id;
}

export { NOW_ISO };
