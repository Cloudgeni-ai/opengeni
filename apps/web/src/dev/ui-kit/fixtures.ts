/**
 * Kit fixtures (design brief section 8). All data is fake and safe to commit.
 * Use these in every kit component so alternatives are compared on identical
 * content. Display strings follow the copy rules: sentence case, plain dashes,
 * dates as "Mon 28 Sep, 08:00" or "3 days ago", never seconds or ISO.
 *
 * Times are pinned to one clock, `KIT_NOW` (Saturday 26 September 2026, 13:48
 * in Oslo), so relative labels and ISO timestamps always agree. Weekday names
 * follow the 2026 calendar, so the brief's "Mon 29 Sep" is "Mon 28 Sep" here
 * and "Wed 1 Oct" is "Thu 1 Oct".
 */

/* ----------------------------------------------------------------------------
   Clock
   -------------------------------------------------------------------------- */

/** Saturday 26 September 2026, 13:48 Oslo time (CEST, UTC+2). */
export const KIT_NOW = new Date("2026-09-26T11:48:00Z");
export const KIT_TIME_ZONE = "Europe/Oslo";

/* ----------------------------------------------------------------------------
   Organization, workspaces and people
   -------------------------------------------------------------------------- */

export interface Organization {
  id: string;
  name: string;
  /** Shown as "Organization: Acme Robotics" in the settings sub-nav. */
  shortName: string;
}

export const organization: Organization = {
  id: "5b0e2f4a-9c1d-4e7b-8a3f-6d2c1e0b9a47",
  name: "Acme Robotics",
  shortName: "Acme Robotics",
};

export type WorkspaceKind = "shared" | "personal";

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  /** "Shared · Acme Robotics" or "Personal · private to you". */
  typeLabel: string;
  description: string;
  createdLabel: string;
  /** People with access (shared workspaces only). */
  peopleCount: number;
}

export const workspaces: Workspace[] = [
  {
    id: "9f1c2d4e-7a3b-4c5d-8e6f-0a1b2c3d4e5f",
    name: "Design preview",
    kind: "shared",
    typeLabel: "Shared · Acme Robotics",
    description: "Where the design team tries new flows before they ship.",
    createdLabel: "Created 14 Mar 2026",
    peopleCount: 3,
  },
  {
    id: "2a7e9b1c-3d4f-4a6b-9c8d-1e2f3a4b5c6d",
    name: "Platform engineering",
    kind: "shared",
    typeLabel: "Shared · Acme Robotics",
    description: "Infrastructure, CI and on-call automation.",
    createdLabel: "Created 2 Feb 2026",
    peopleCount: 5,
  },
  {
    id: "7c4d1e2f-5a6b-4c7d-8e9f-0a1b2c3d4e6a",
    name: "Customer success",
    kind: "shared",
    typeLabel: "Shared · Acme Robotics",
    description: "Support triage, renewals and account health.",
    createdLabel: "Created 21 Apr 2026",
    peopleCount: 3,
  },
  {
    id: "4e8f2a1b-6c3d-4e5f-9a0b-1c2d3e4f5a6b",
    name: "Finance ops",
    kind: "shared",
    typeLabel: "Shared · Acme Robotics",
    description: "Month-end close, exports and spend reviews.",
    createdLabel: "Created 5 Jun 2026",
    peopleCount: 2,
  },
];

/** The workspace most page previews show. */
export const currentWorkspace: Workspace = workspaces[0]!;

export const personalWorkspace: Workspace = {
  id: "c3b2a1f0-e9d8-4c7b-a6f5-e4d3c2b1a0f9",
  name: "Personal",
  kind: "personal",
  typeLabel: "Personal · private to you",
  description: "Your private workspace. Only you can see it.",
  createdLabel: "Created 2 Feb 2026",
  peopleCount: 1,
};

export type OrganizationRole = "owner" | "admin" | "member";
export type WorkspaceRole = "viewer" | "member" | "workspace_admin";

export interface RoleDefinition<Id extends string> {
  id: Id;
  label: string;
  description: string;
}

/** From the server's role catalog, never a client copy. */
export const workspaceRoles: RoleDefinition<WorkspaceRole>[] = [
  {
    id: "viewer",
    label: "Viewer",
    description: "Can view sessions, files and approved knowledge.",
  },
  {
    id: "member",
    label: "Member",
    description: "Can start chats and add workspace content.",
  },
  {
    id: "workspace_admin",
    label: "Workspace admin",
    description: "Can manage workspace settings, access and integrations.",
  },
];

export const organizationRoles: RoleDefinition<OrganizationRole>[] = [
  {
    id: "owner",
    label: "Owner",
    description: "Full control of the organization, billing and recovery.",
  },
  {
    id: "admin",
    label: "Admin",
    description: "Manages people, workspaces and shared connections.",
  },
  {
    id: "member",
    label: "Member",
    description: "Uses the workspaces they're given access to.",
  },
];

export type PersonKind = "person" | "service";
export type PersonStatus = "active" | "invited" | "suspended" | "invite_failed";

export interface WorkspaceAccessGrant {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
}

export interface Person {
  id: string;
  name: string;
  /** Service accounts have no email. */
  email: string | null;
  initials: string;
  kind: PersonKind;
  organizationRole: OrganizationRole;
  status: PersonStatus;
  /** Sentence-case status line, only when not active. */
  statusLabel?: string;
  isYou?: boolean;
  /** The last remaining owner can't be demoted or removed. */
  isOnlyOwner?: boolean;
  joinedLabel?: string;
  /** Shared workspaces this person can use. */
  workspaceAccess: WorkspaceAccessGrant[];
}

const [designPreview, platformEngineering, customerSuccess, financeOps] = workspaces as [
  Workspace,
  Workspace,
  Workspace,
  Workspace,
];

function grant(workspace: Workspace, role: WorkspaceRole): WorkspaceAccessGrant {
  return { workspaceId: workspace.id, workspaceName: workspace.name, role };
}

export const people: Person[] = [
  {
    id: "person-bendik",
    name: "Bendik Hansen",
    email: "bendik@acme.dev",
    initials: "BH",
    kind: "person",
    organizationRole: "owner",
    status: "active",
    isYou: true,
    isOnlyOwner: true,
    joinedLabel: "Joined 2 Feb 2026",
    workspaceAccess: [
      grant(designPreview, "workspace_admin"),
      grant(platformEngineering, "workspace_admin"),
      grant(customerSuccess, "member"),
      grant(financeOps, "viewer"),
    ],
  },
  {
    id: "person-maria",
    name: "Maria Chen",
    email: "maria@acme.dev",
    initials: "MC",
    kind: "person",
    organizationRole: "admin",
    status: "active",
    joinedLabel: "Joined 9 Feb 2026",
    workspaceAccess: [
      grant(designPreview, "member"),
      grant(platformEngineering, "member"),
      grant(customerSuccess, "workspace_admin"),
    ],
  },
  {
    id: "person-jonas",
    name: "Jonas Berg",
    email: "jonas@acme.dev",
    initials: "JB",
    kind: "person",
    organizationRole: "member",
    status: "active",
    joinedLabel: "Joined 3 Mar 2026",
    workspaceAccess: [grant(platformEngineering, "viewer")],
  },
  {
    id: "person-priya",
    name: "Priya Nair",
    email: "priya@acme.dev",
    initials: "PN",
    kind: "person",
    organizationRole: "member",
    status: "invited",
    statusLabel: "Invited · expires in 5 days",
    workspaceAccess: [grant(platformEngineering, "member")],
  },
  {
    id: "person-tom",
    name: "Tom Eriksen",
    email: "tom@acme.dev",
    initials: "TE",
    kind: "person",
    organizationRole: "member",
    status: "suspended",
    statusLabel: "Suspended",
    joinedLabel: "Joined 17 Mar 2026",
    workspaceAccess: [],
  },
  {
    id: "person-aiko",
    name: "Aiko Tanaka",
    email: "aiko@acme.dev",
    initials: "AT",
    kind: "person",
    organizationRole: "member",
    status: "invite_failed",
    statusLabel: "Invitation email failed",
    workspaceAccess: [grant(customerSuccess, "member")],
  },
  {
    id: "person-ci-bot",
    name: "CI bot",
    email: null,
    initials: "CI",
    kind: "service",
    organizationRole: "member",
    status: "active",
    statusLabel: "Service account",
    workspaceAccess: [grant(designPreview, "member"), grant(platformEngineering, "member")],
  },
];

export function personById(id: string): Person {
  const person = people.find((each) => each.id === id);
  if (!person) throw new Error(`Unknown fixture person: ${id}`);
  return person;
}

export const you: Person = personById("person-bendik");

/** Counts for the People toolbar filter (humans only). */
export const peopleCounts = {
  all: people.filter((person) => person.kind === "person").length,
  invited: people.filter(
    (person) => person.status === "invited" || person.status === "invite_failed",
  ).length,
  suspended: people.filter((person) => person.status === "suspended").length,
};

export interface AccessEntry {
  personId: string;
  /** "custom" is a legacy grant set through the API. */
  role: WorkspaceRole | "custom";
  /** Shown instead of the role for custom grants. */
  customLabel?: string;
  /** A custom grant offers "Reset to role". */
  resetToRole?: WorkspaceRole;
}

/** Access to Platform engineering, including a legacy custom grant. */
export const platformEngineeringAccess: AccessEntry[] = [
  { personId: "person-bendik", role: "workspace_admin" },
  { personId: "person-maria", role: "member" },
  { personId: "person-jonas", role: "viewer" },
  {
    personId: "person-tom",
    role: "custom",
    customLabel: "Custom (set via API)",
    resetToRole: "member",
  },
  { personId: "person-ci-bot", role: "member" },
];

/** Access to Design preview, the workspace the settings pages show. */
export const designPreviewAccess: AccessEntry[] = [
  { personId: "person-bendik", role: "workspace_admin" },
  { personId: "person-maria", role: "member" },
  { personId: "person-ci-bot", role: "member" },
];

export interface AccessRequest {
  id: string;
  personId: string;
  source: "Slack";
  requestedLabel: string;
  message: string;
}

/** Slack access requests, shown above the access list only when present. */
export const designPreviewAccessRequests: AccessRequest[] = [
  {
    id: "request-jonas",
    personId: "person-jonas",
    source: "Slack",
    requestedLabel: "2 hours ago",
    message: "Asked from #design-reviews to use OpenGeni in Design preview.",
  },
];

/* ----------------------------------------------------------------------------
   Workspace general settings
   -------------------------------------------------------------------------- */

export const agentActivity = {
  state: "running" as "running" | "paused",
  runningLabel: "Running",
  pausedLabel: "Paused · resumes in 52 min",
};

export const sessionDefaults = {
  voiceInput: true,
  transcriptionProvider: "automatic" as "automatic" | "codex",
  transcriptionProviders: [
    {
      id: "automatic",
      label: "Automatic",
      description: "Uses the best provider you've connected.",
    },
    { id: "codex", label: "Codex plan", description: "Transcribes with your ChatGPT plan." },
  ],
  videoGeneration: false,
  videoGenerationHint: "Connect AI Gateway to turn this on.",
  fastCodeSearch: "default" as "default" | "on" | "off",
  useConnectedAppsAutomatically: true,
};

/* ----------------------------------------------------------------------------
   Variable sets (Design preview)
   -------------------------------------------------------------------------- */

export type VariableKind = "secret" | "plain";

export interface Variable {
  name: string;
  kind: VariableKind;
  /** Plain values only. Secrets are write-only and never shown. */
  value?: string;
  updatedAt: string;
  updatedLabel: string;
}

export type VariableSetScope = "workspace" | "organization" | "personal";

export interface VariableSetUsage {
  kind: "schedule" | "chat" | "environment_default";
  /** "Schedule", "Chat" or "Sandbox environment default". */
  kindLabel: string;
  name: string;
}

export interface VariableSet {
  id: string;
  name: string;
  description: string;
  scope: VariableSetScope;
  /** Badge text, only for Organization or Only me. */
  scopeLabel?: string;
  variables: Variable[];
  usedBy: VariableSetUsage[];
  /** "4 variables". */
  variablesLabel: string;
  /** "Used by 1 schedule" or "Not used". */
  usageLabel: string;
  updatedAt: string;
  updatedLabel: string;
}

export const variableSets: VariableSet[] = [
  {
    id: "vs-aws-production",
    name: "AWS production",
    description: "Read-only IAM credentials for the production AWS account (eu-north-1).",
    scope: "workspace",
    variables: [
      {
        name: "AWS_ACCESS_KEY_ID",
        kind: "secret",
        updatedAt: "2026-09-23T09:12:00Z",
        updatedLabel: "3 days ago",
      },
      {
        name: "AWS_SECRET_ACCESS_KEY",
        kind: "secret",
        updatedAt: "2026-09-23T09:12:00Z",
        updatedLabel: "3 days ago",
      },
      {
        name: "AWS_REGION",
        kind: "plain",
        value: "eu-north-1",
        updatedAt: "2026-08-14T10:02:00Z",
        updatedLabel: "14 Aug",
      },
      {
        name: "AWS_ACCOUNT_ID",
        kind: "plain",
        value: "123456789012",
        updatedAt: "2026-08-14T10:02:00Z",
        updatedLabel: "14 Aug",
      },
    ],
    usedBy: [{ kind: "schedule", kindLabel: "Schedule", name: "Check AWS cost anomalies" }],
    variablesLabel: "4 variables",
    usageLabel: "Used by 1 schedule",
    updatedAt: "2026-09-23T09:12:00Z",
    updatedLabel: "3 days ago",
  },
  {
    id: "vs-github-automation",
    name: "GitHub automation",
    description: "Bot token for dependency PRs in the acme-robotics org.",
    scope: "workspace",
    variables: [
      {
        name: "GITHUB_BOT_TOKEN",
        kind: "secret",
        updatedAt: "2026-09-21T15:40:00Z",
        updatedLabel: "5 days ago",
      },
      {
        name: "GITHUB_ORG",
        kind: "plain",
        value: "acme-robotics",
        updatedAt: "2026-07-02T08:30:00Z",
        updatedLabel: "2 Jul",
      },
    ],
    usedBy: [
      { kind: "schedule", kindLabel: "Schedule", name: "Weekly dependency update PR" },
      {
        kind: "environment_default",
        kindLabel: "Sandbox environment default",
        name: "Platform CI",
      },
    ],
    variablesLabel: "2 variables",
    usageLabel: "Used by 1 schedule and 1 environment",
    updatedAt: "2026-09-21T15:40:00Z",
    updatedLabel: "5 days ago",
  },
  {
    id: "vs-datadog",
    name: "Datadog",
    description: "API and app keys for the EU Datadog site.",
    scope: "workspace",
    variables: [
      {
        name: "DD_API_KEY",
        kind: "secret",
        updatedAt: "2026-09-12T11:05:00Z",
        updatedLabel: "2 weeks ago",
      },
      {
        name: "DD_APP_KEY",
        kind: "secret",
        updatedAt: "2026-09-12T11:05:00Z",
        updatedLabel: "2 weeks ago",
      },
      {
        name: "DD_SITE",
        kind: "plain",
        value: "datadoghq.eu",
        updatedAt: "2026-09-12T11:05:00Z",
        updatedLabel: "2 weeks ago",
      },
    ],
    usedBy: [{ kind: "schedule", kindLabel: "Schedule", name: "Monthly access review" }],
    variablesLabel: "3 variables",
    usageLabel: "Used by 1 schedule",
    updatedAt: "2026-09-12T11:05:00Z",
    updatedLabel: "2 weeks ago",
  },
  {
    id: "vs-staging-database",
    name: "Staging database",
    description: "Read-only connection to the staging Postgres.",
    scope: "workspace",
    variables: [
      {
        name: "DATABASE_URL",
        kind: "secret",
        updatedAt: "2026-09-11T14:20:00Z",
        updatedLabel: "2 weeks ago",
      },
      {
        name: "PGUSER",
        kind: "plain",
        value: "agent_ro",
        updatedAt: "2026-09-11T14:20:00Z",
        updatedLabel: "2 weeks ago",
      },
      {
        name: "PGSSLMODE",
        kind: "plain",
        value: "require",
        updatedAt: "2026-09-11T14:20:00Z",
        updatedLabel: "2 weeks ago",
      },
    ],
    usedBy: [],
    variablesLabel: "3 variables",
    usageLabel: "Not used",
    updatedAt: "2026-09-11T14:20:00Z",
    updatedLabel: "2 weeks ago",
  },
  {
    id: "vs-finance-exports",
    name: "Finance exports",
    description: "Read-only export credentials shared across workspaces.",
    scope: "organization",
    scopeLabel: "Organization",
    variables: [
      {
        name: "EXPORT_TOKEN",
        kind: "secret",
        updatedAt: "2026-08-26T07:45:00Z",
        updatedLabel: "1 month ago",
      },
    ],
    usedBy: [{ kind: "chat", kindLabel: "Chat", name: "Q3 revenue review" }],
    variablesLabel: "1 variable",
    usageLabel: "Used by 1 chat",
    updatedAt: "2026-08-26T07:45:00Z",
    updatedLabel: "1 month ago",
  },
];

export function variableSetById(id: string): VariableSet {
  const set = variableSets.find((each) => each.id === id);
  if (!set) throw new Error(`Unknown fixture variable set: ${id}`);
  return set;
}

/** Deleting this set is blocked: a schedule uses it. */
export const blockedDeleteVariableSet: VariableSet = variableSetById("vs-aws-production");

/** A new set with no variables yet, for the empty state. */
export const emptyVariableSet: VariableSet = {
  id: "vs-sentry",
  name: "Sentry",
  description: "Auth token for reading issues from the acme-robotics Sentry org.",
  scope: "workspace",
  variables: [],
  usedBy: [],
  variablesLabel: "No variables",
  usageLabel: "Not used",
  updatedAt: "2026-09-26T11:30:00Z",
  updatedLabel: "18 min ago",
};

export type EnvPasteRowStatus = "new" | "duplicate" | "reserved";

export interface EnvPasteRow {
  name: string;
  kind: VariableKind;
  /** Plain values only; secret values are never echoed back. */
  value?: string;
  status: EnvPasteRowStatus;
  /** Inline message for duplicate and reserved rows. */
  message?: string;
}

/** Paste .env into GitHub automation: one reserved name and one duplicate. */
export const envPastePreview: { targetSetId: string; rows: EnvPasteRow[] } = {
  targetSetId: "vs-github-automation",
  rows: [
    {
      name: "GITHUB_ORG",
      kind: "plain",
      value: "acme-robotics",
      status: "duplicate",
      message: "Already in this set. Pasting replaces its value.",
    },
    {
      name: "GITHUB_TOKEN",
      kind: "secret",
      status: "reserved",
      message:
        "OpenGeni sets GITHUB_TOKEN for repository access. Use another name, like GITHUB_BOT_TOKEN.",
    },
    { name: "RENOVATE_PLATFORM", kind: "plain", value: "github", status: "new" },
    { name: "RENOVATE_AUTODISCOVER", kind: "plain", value: "false", status: "new" },
  ],
};

/** Name validation copy for Add variable. */
export const variableNameRules = {
  hint: "Letters, numbers and underscores. Saved in uppercase.",
  reserved: "GITHUB_TOKEN is reserved. OpenGeni sets it for repository access.",
  duplicate: "AWS_REGION is already in this set.",
  replaceHint: "Takes effect from the next turn. Turns already running keep the current value.",
};

/* ----------------------------------------------------------------------------
   Sandbox environments and repositories (referenced by other fixtures)
   -------------------------------------------------------------------------- */

export interface SandboxEnvironment {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  defaultVariableSetId?: string;
  healthLabel: string;
  updatedLabel: string;
}

export const sandboxEnvironments: SandboxEnvironment[] = [
  {
    id: "env-platform-ci",
    name: "Platform CI",
    description: "Node 22, Terraform and the platform test toolchain.",
    isDefault: true,
    defaultVariableSetId: "vs-github-automation",
    healthLabel: "Ready",
    updatedLabel: "3 days ago",
  },
  {
    id: "env-data-notebooks",
    name: "Data notebooks",
    description: "Python 3.12 with pandas and DuckDB for finance exports.",
    isDefault: false,
    healthLabel: "Ready",
    updatedLabel: "3 weeks ago",
  },
];

export const repositories = [
  "acme-robotics/platform",
  "acme-robotics/firmware",
  "acme-robotics/web",
  "acme-robotics/docs",
];

/* ----------------------------------------------------------------------------
   Models and model accounts
   -------------------------------------------------------------------------- */

export type Payer = "Codex plan" | "OpenGeni credits" | "AI Gateway" | "OpenRouter";

export interface ModelOption {
  id: string;
  label: string;
  payer: Payer;
  /** "GPT-6 Sol · Codex plan". */
  displayLabel: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
}

export const modelCatalog: ModelOption[] = [
  {
    id: "codex:gpt-6-astra",
    label: "GPT-6 Astra",
    payer: "Codex plan",
    displayLabel: "GPT-6 Astra · Codex plan",
    description: "The most capable model for long, careful work.",
    available: true,
  },
  {
    id: "codex:gpt-6-luna",
    label: "GPT-6 Luna",
    payer: "Codex plan",
    displayLabel: "GPT-6 Luna · Codex plan",
    description: "Fast and light, for quick questions and edits.",
    available: true,
  },
  {
    id: "codex:gpt-6-sol",
    label: "GPT-6 Sol",
    payer: "Codex plan",
    displayLabel: "GPT-6 Sol · Codex plan",
    description: "Balanced speed and depth for everyday work.",
    available: true,
  },
  {
    id: "credits:gpt-6-astra",
    label: "GPT-6 Astra",
    payer: "OpenGeni credits",
    displayLabel: "GPT-6 Astra · OpenGeni credits",
    description: "Billed to your organization's credit balance.",
    available: false,
    unavailableReason: "No credit balance. An owner can add credits in Billing.",
  },
];

export const defaultModel: ModelOption = modelCatalog[2]!;

export type AccountSource = "workspace" | "organization" | "personal";
export type AccountState = "active" | "paused" | "needs_reconnect";
export type UsageTone = "healthy" | "low" | "exhausted" | "unknown";

export interface UsageWindow {
  /** "Weekly" or "5-hour", never abbreviated. */
  label: "Weekly" | "5-hour";
  percentLeft: number | null;
  tone: UsageTone;
  resetsAt?: string;
  /** "Mon 28 Sep, 09:00". */
  resetsLabel?: string;
}

export interface UsageLimitReset {
  id: string;
  label: string;
  expiresLabel: string;
}

export interface ModelAccount {
  id: string;
  provider: "codex";
  name: string;
  plan: string;
  source: AccountSource;
  /** "Workspace", "Organization" or "Only you". */
  sourceLabel: string;
  isPrimary: boolean;
  useForNewWork: boolean;
  state: AccountState;
  /** "Primary", "Paused" or "Needs reconnect", only when it applies. */
  stateLabel?: string;
  usage: UsageWindow[];
  resets: UsageLimitReset[];
  checkedLabel: string;
  codexApps: boolean;
  modelsServedLabel: string;
  /** Organization accounts only. */
  availableInLabel?: string;
  /** Members see organization accounts read-only. */
  readOnly: boolean;
}

export const codexProvider = {
  name: "Codex",
  subtitle: "ChatGPT plan",
  /** "Spread work | Primary only", shown only with 2+ accounts. */
  rotation: "spread" as "spread" | "primary",
  rotationOptions: [
    { id: "spread", label: "Spread work" },
    { id: "primary", label: "Primary only" },
  ],
  /** "Organization | This workspace", shown only when the org assigns an account. */
  source: "workspace" as "organization" | "workspace",
  sourceOptions: [
    { id: "organization", label: "Organization" },
    { id: "workspace", label: "This workspace" },
  ],
};

export const codexWorkspaceAccounts: ModelAccount[] = [
  {
    id: "acct-ops",
    provider: "codex",
    name: "ops@acme.dev",
    plan: "ChatGPT Pro",
    source: "workspace",
    sourceLabel: "Workspace",
    isPrimary: true,
    useForNewWork: true,
    state: "active",
    stateLabel: "Primary",
    usage: [
      {
        label: "Weekly",
        percentLeft: 22,
        tone: "healthy",
        resetsAt: "2026-09-28T07:00:00Z",
        resetsLabel: "Mon 28 Sep, 09:00",
      },
      {
        label: "5-hour",
        percentLeft: 64,
        tone: "healthy",
        resetsAt: "2026-09-26T15:10:00Z",
        resetsLabel: "Today, 17:10",
      },
    ],
    resets: [
      { id: "reset-1", label: "Usage limit reset", expiresLabel: "Expires 12 Oct" },
      { id: "reset-2", label: "Usage limit reset", expiresLabel: "Expires 19 Oct" },
      { id: "reset-3", label: "Usage limit reset", expiresLabel: "Expires 2 Nov" },
    ],
    checkedLabel: "Checked just now",
    codexApps: false,
    modelsServedLabel: "All",
    readOnly: false,
  },
  {
    id: "acct-research",
    provider: "codex",
    name: "research@acme.dev",
    plan: "ChatGPT Pro",
    source: "workspace",
    sourceLabel: "Workspace",
    isPrimary: false,
    useForNewWork: false,
    state: "paused",
    stateLabel: "Paused",
    usage: [
      {
        label: "Weekly",
        percentLeft: 8,
        tone: "low",
        resetsAt: "2026-09-29T07:00:00Z",
        resetsLabel: "Tue 29 Sep, 09:00",
      },
      {
        label: "5-hour",
        percentLeft: 91,
        tone: "healthy",
        resetsAt: "2026-09-26T16:30:00Z",
        resetsLabel: "Today, 18:30",
      },
    ],
    resets: [
      { id: "reset-4", label: "Usage limit reset", expiresLabel: "Expires 8 Oct" },
      { id: "reset-5", label: "Usage limit reset", expiresLabel: "Expires 22 Oct" },
    ],
    checkedLabel: "Checked 4 min ago",
    codexApps: false,
    modelsServedLabel: "All",
    readOnly: false,
  },
];

export const codexOrganizationAccounts: ModelAccount[] = [
  {
    id: "acct-platform",
    provider: "codex",
    name: "platform@acme.dev",
    plan: "ChatGPT Pro",
    source: "organization",
    sourceLabel: "Organization",
    isPrimary: false,
    useForNewWork: true,
    state: "active",
    usage: [
      {
        label: "Weekly",
        percentLeft: 57,
        tone: "healthy",
        resetsAt: "2026-10-01T07:00:00Z",
        resetsLabel: "Thu 1 Oct, 09:00",
      },
      { label: "5-hour", percentLeft: null, tone: "unknown" },
    ],
    resets: [],
    checkedLabel: "Checked 12 min ago",
    codexApps: false,
    modelsServedLabel: "All",
    availableInLabel: "All workspaces + Personal",
    readOnly: true,
  },
];

/** An account at 0% with a reset time, for the exhausted meter state. */
export const exhaustedUsageWindow: UsageWindow = {
  label: "Weekly",
  percentLeft: 0,
  tone: "exhausted",
  resetsAt: "2026-09-28T07:00:00Z",
  resetsLabel: "Mon 28 Sep, 09:00",
};

export interface GatewayProvider {
  id: "vercel" | "openrouter";
  name: string;
  description: string;
  connected: boolean;
  keyHint?: string;
  customModels: string[];
}

export const gatewayProviders: GatewayProvider[] = [
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    description: "Use models from many providers, billed to your Vercel account.",
    connected: false,
    customModels: [],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Use models from OpenRouter, billed to your OpenRouter key.",
    connected: true,
    keyHint: "•••• 4f2a",
    customModels: ["anthropic/claude-sonnet-4.5", "meta-llama/llama-4-maverick"],
  },
];

/** SuperGrok is turned off on this deployment, so it is never rendered. */
export const hiddenProviders = ["SuperGrok"];

export const allowedModelsSummary = "All models from connected accounts";

/* ----------------------------------------------------------------------------
   Schedules (Design preview)
   -------------------------------------------------------------------------- */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type CadenceRule =
  | { frequency: "hourly" }
  | { frequency: "daily"; time: string }
  | { frequency: "weekdays"; time: string }
  | { frequency: "weekly"; days: Weekday[]; time: string }
  | { frequency: "monthly"; dayOfMonth: number; time: string }
  | { frequency: "interval"; every: number; unit: "minutes" | "hours" | "days" }
  | { frequency: "once"; at: string };

export interface TimeZoneOption {
  id: string;
  /** "Oslo time". */
  label: string;
  /** "Oslo". */
  shortLabel: string;
  offsetLabel: string;
}

export const timeZones: TimeZoneOption[] = [
  { id: "Europe/Oslo", label: "Oslo time", shortLabel: "Oslo", offsetLabel: "UTC+2" },
  { id: "Europe/London", label: "London time", shortLabel: "London", offsetLabel: "UTC+1" },
  { id: "America/New_York", label: "New York time", shortLabel: "New York", offsetLabel: "UTC-4" },
  {
    id: "America/Los_Angeles",
    label: "Los Angeles time",
    shortLabel: "Los Angeles",
    offsetLabel: "UTC-7",
  },
  { id: "Asia/Tokyo", label: "Tokyo time", shortLabel: "Tokyo", offsetLabel: "UTC+9" },
  { id: "Asia/Kolkata", label: "India time", shortLabel: "Kolkata", offsetLabel: "UTC+5:30" },
  { id: "UTC", label: "UTC", shortLabel: "UTC", offsetLabel: "UTC" },
];

export type RunStatus = "succeeded" | "failed" | "running" | "never";

export interface ScheduleRun {
  id: string;
  status: Exclude<RunStatus, "never">;
  /** "Succeeded", "Failed" or "Running". */
  statusLabel: string;
  startedAt: string;
  /** "Fri 25 Sep, 08:00" or "48 min ago". */
  startedLabel: string;
  durationLabel?: string;
  /** Only for manual runs. */
  triggerLabel?: string;
  outcome: string;
}

export type EachRun = "new_chat" | "ongoing_chat";

export interface ScheduleSetup {
  model: string;
  eachRun: EachRun;
  /** "New chat each run" or "One ongoing chat". */
  eachRunLabel: string;
  /** Only for ongoing chats. */
  ifStillRunning?: "queue" | "skip";
  ifStillRunningLabel?: string;
  whereItRuns: string;
  variableSetId?: string;
  variableSetName?: string;
  repositories: string[];
  environment?: string;
  tools: string[];
  learning: string;
}

export interface Schedule {
  id: string;
  name: string;
  instructions: string;
  cadence: CadenceRule;
  /** "Every weekday at 08:00 · Oslo". */
  cadenceLabel: string;
  /** "Weekdays at 08:00 · Oslo", for rows. */
  cadenceShortLabel: string;
  /** "Runs every weekday at 08:00 Oslo time." */
  cadenceSentence: string;
  timeZoneId: string;
  state: "active" | "paused";
  nextRunAt?: string;
  /** "Mon 28 Sep, 08:00" or "Paused". */
  nextRunLabel: string;
  lastRun: { status: RunStatus; label: string; at?: string };
  ownerId: string;
  setup: ScheduleSetup;
  runs: ScheduleRun[];
}

export const schedules: Schedule[] = [
  {
    id: "sched-sentry",
    name: "Summarize new Sentry errors",
    instructions:
      "Summarize new Sentry errors from the last hour for #eng-alerts. Group them by service, link the three most frequent issues and skip anything already triaged.",
    cadence: { frequency: "hourly" },
    cadenceLabel: "Every hour",
    cadenceShortLabel: "Every hour",
    cadenceSentence: "Runs every hour.",
    timeZoneId: "Europe/Oslo",
    state: "active",
    nextRunAt: "2026-09-26T12:00:00Z",
    nextRunLabel: "Today, 14:00",
    lastRun: { status: "succeeded", label: "Succeeded · 48 min ago", at: "2026-09-26T11:00:00Z" },
    ownerId: "person-bendik",
    setup: {
      model: "Workspace default - GPT-6 Sol · Codex plan",
      eachRun: "new_chat",
      eachRunLabel: "New chat each run",
      whereItRuns: "Managed sandbox",
      repositories: [],
      tools: ["Sentry", "Slack"],
      learning: "Workspace learning defaults",
    },
    runs: [
      {
        id: "run-sentry-3",
        status: "succeeded",
        statusLabel: "Succeeded",
        startedAt: "2026-09-26T11:00:00Z",
        startedLabel: "48 min ago",
        durationLabel: "1 min 04 s",
        outcome: "2 new errors in checkout-api, posted to #eng-alerts.",
      },
      {
        id: "run-sentry-2",
        status: "succeeded",
        statusLabel: "Succeeded",
        startedAt: "2026-09-26T10:00:00Z",
        startedLabel: "2 hours ago",
        durationLabel: "52 s",
        outcome: "No new errors.",
      },
    ],
  },
  {
    id: "sched-aws-cost",
    name: "Check AWS cost anomalies",
    instructions:
      "Compare yesterday's AWS spend in eu-north-1 with the 14-day average. If any service is more than 20% above it, post a short summary with the top cost drivers to #platform.",
    cadence: { frequency: "weekdays", time: "08:00" },
    cadenceLabel: "Every weekday at 08:00 · Oslo",
    cadenceShortLabel: "Weekdays at 08:00 · Oslo",
    cadenceSentence: "Runs every weekday at 08:00 Oslo time.",
    timeZoneId: "Europe/Oslo",
    state: "active",
    nextRunAt: "2026-09-28T06:00:00Z",
    nextRunLabel: "Mon 28 Sep, 08:00",
    lastRun: { status: "failed", label: "Failed · Fri 08:00", at: "2026-09-25T06:00:00Z" },
    ownerId: "person-bendik",
    setup: {
      model: "Workspace default - GPT-6 Sol · Codex plan",
      eachRun: "new_chat",
      eachRunLabel: "New chat each run",
      whereItRuns: "Managed sandbox",
      variableSetId: "vs-aws-production",
      variableSetName: "AWS production",
      repositories: [],
      tools: ["Slack"],
      learning: "Workspace learning defaults",
    },
    runs: [
      {
        id: "run-aws-4",
        status: "failed",
        statusLabel: "Failed",
        startedAt: "2026-09-25T06:00:00Z",
        startedLabel: "Fri 25 Sep, 08:00",
        durationLabel: "1 min 12 s",
        outcome: "Couldn't read Cost Explorer. AWS rejected the credentials in AWS production.",
      },
      {
        id: "run-aws-3",
        status: "succeeded",
        statusLabel: "Succeeded",
        startedAt: "2026-09-24T06:00:00Z",
        startedLabel: "Thu 24 Sep, 08:00",
        durationLabel: "2 min 03 s",
        outcome: "No anomalies. Spend was 3% under the average.",
      },
      {
        id: "run-aws-2",
        status: "succeeded",
        statusLabel: "Succeeded",
        startedAt: "2026-09-23T13:20:00Z",
        startedLabel: "Wed 23 Sep, 15:20",
        durationLabel: "1 min 48 s",
        triggerLabel: "Run now by Bendik",
        outcome: "S3 requests up 34% after the log retention change. Posted to #platform.",
      },
    ],
  },
  {
    id: "sched-deps",
    name: "Weekly dependency update PR",
    instructions:
      "Open one pull request in acme-robotics/platform that updates outdated dependencies. Group minor and patch updates, run the tests and open the PR as a draft if anything fails.",
    cadence: { frequency: "weekly", days: ["mon"], time: "09:30" },
    cadenceLabel: "Every week on Mon at 09:30 · Oslo",
    cadenceShortLabel: "Mondays at 09:30 · Oslo",
    cadenceSentence: "Runs every Monday at 09:30 Oslo time.",
    timeZoneId: "Europe/Oslo",
    state: "paused",
    nextRunLabel: "Paused",
    lastRun: { status: "succeeded", label: "Succeeded · 21 Sep", at: "2026-09-21T07:30:00Z" },
    ownerId: "person-bendik",
    setup: {
      model: "Workspace default - GPT-6 Sol · Codex plan",
      eachRun: "ongoing_chat",
      eachRunLabel: "One ongoing chat",
      ifStillRunning: "skip",
      ifStillRunningLabel: "Skip if still running",
      whereItRuns: "Platform CI",
      variableSetId: "vs-github-automation",
      variableSetName: "GitHub automation",
      repositories: ["acme-robotics/platform"],
      environment: "Platform CI",
      tools: ["GitHub"],
      learning: "Workspace learning defaults",
    },
    runs: [
      {
        id: "run-deps-2",
        status: "succeeded",
        statusLabel: "Succeeded",
        startedAt: "2026-09-21T07:30:00Z",
        startedLabel: "Mon 21 Sep, 09:30",
        durationLabel: "6 min 40 s",
        outcome: "Opened a draft PR with 14 updates. 1 test is failing.",
      },
    ],
  },
  {
    id: "sched-access-review",
    name: "Monthly access review",
    instructions:
      "List everyone with access to Datadog, AWS and GitHub, flag accounts with no activity in 30 days and draft a message to each team lead for review.",
    cadence: { frequency: "monthly", dayOfMonth: 1, time: "09:00" },
    cadenceLabel: "Every month on day 1 at 09:00 · Oslo",
    cadenceShortLabel: "Monthly on the 1st at 09:00 · Oslo",
    cadenceSentence: "Runs on day 1 of every month at 09:00 Oslo time.",
    timeZoneId: "Europe/Oslo",
    state: "active",
    nextRunAt: "2026-10-01T07:00:00Z",
    nextRunLabel: "Thu 1 Oct, 09:00",
    lastRun: { status: "never", label: "Never run" },
    ownerId: "person-maria",
    setup: {
      model: "Workspace default - GPT-6 Sol · Codex plan",
      eachRun: "new_chat",
      eachRunLabel: "New chat each run",
      whereItRuns: "Managed sandbox",
      variableSetId: "vs-datadog",
      variableSetName: "Datadog",
      repositories: [],
      tools: ["Datadog", "GitHub"],
      learning: "Workspace learning defaults",
    },
    runs: [],
  },
];

export function scheduleById(id: string): Schedule {
  const schedule = schedules.find((each) => each.id === id);
  if (!schedule) throw new Error(`Unknown fixture schedule: ${id}`);
  return schedule;
}

export interface ScheduleTemplate {
  id: string;
  name: string;
  description: string;
  instructions: string;
  cadence: CadenceRule;
  cadenceLabel: string;
}

/** Starter cards for the empty Schedules page. */
export const scheduleTemplates: ScheduleTemplate[] = [
  {
    id: "template-morning-brief",
    name: "Morning brief",
    description: "What changed in your repositories and open incidents.",
    instructions:
      "Every weekday at 08:00: summarize what changed in our repositories and open incidents.",
    cadence: { frequency: "weekdays", time: "08:00" },
    cadenceLabel: "Every weekday at 08:00",
  },
  {
    id: "template-dependency-pr",
    name: "Weekly dependency PR",
    description: "One pull request with outdated dependencies, tested.",
    instructions:
      "Every Monday, open one pull request that updates outdated dependencies and run the tests.",
    cadence: { frequency: "weekly", days: ["mon"], time: "09:30" },
    cadenceLabel: "Every week on Mon at 09:30",
  },
  {
    id: "template-cost-anomaly",
    name: "Cost anomaly check",
    description: "Spot cloud spend that jumps above its usual level.",
    instructions:
      "Every weekday, compare yesterday's cloud spend with the 14-day average and flag anything more than 20% above.",
    cadence: { frequency: "weekdays", time: "08:00" },
    cadenceLabel: "Every weekday at 08:00",
  },
];

/** Cadence picker samples: every frequency, plus the invalid and past states. */
export const cadenceExamples = {
  default: {
    rule: { frequency: "weekdays", time: "09:00" } as CadenceRule,
    summary: "Runs every weekday at 09:00 Oslo time",
    nextRunLabel: "Mon 28 Sep, 09:00",
  },
  weekdays: {
    rule: { frequency: "weekdays", time: "08:00" } as CadenceRule,
    summary: "Runs every weekday at 08:00 Oslo time",
    nextRunLabel: "Mon 28 Sep, 08:00",
  },
  weekly: {
    rule: { frequency: "weekly", days: ["mon", "thu"], time: "09:30" } as CadenceRule,
    summary: "Runs every Monday and Thursday at 09:30 Oslo time",
    nextRunLabel: "Mon 28 Sep, 09:30",
  },
  monthly: {
    rule: { frequency: "monthly", dayOfMonth: 1, time: "09:00" } as CadenceRule,
    summary: "Runs on day 1 of every month at 09:00 Oslo time",
    nextRunLabel: "Thu 1 Oct, 09:00",
  },
  interval: {
    rule: { frequency: "interval", every: 30, unit: "minutes" } as CadenceRule,
    summary: "Runs every 30 minutes",
    nextRunLabel: "Today, 14:18",
  },
  once: {
    rule: { frequency: "once", at: "2026-10-02T13:00:00Z" } as CadenceRule,
    summary: "Runs once on Fri 2 Oct at 15:00 Oslo time",
    nextRunLabel: "Fri 2 Oct, 15:00",
  },
  invalid: {
    message: "Pick at least one day.",
  },
  pastOneTime: {
    message: "Fri 25 Sep, 08:00 has already passed. Pick a later time.",
  },
};

/* ----------------------------------------------------------------------------
   API keys (Design preview)
   -------------------------------------------------------------------------- */

export type ApiKeyAccess = "read_only" | "run_sessions" | "full_automation" | "custom";
export type ApiKeyStatus = "active" | "expired" | "revoked";

export interface ApiKeyPreset {
  id: ApiKeyAccess;
  label: string;
  description: string;
  permissions: string[];
}

export const apiKeyPresets: ApiKeyPreset[] = [
  {
    id: "read_only",
    label: "Read only",
    description: "Read sessions, files and knowledge. Can't start or change anything.",
    permissions: ["Read sessions", "Read files", "Read knowledge"],
  },
  {
    id: "run_sessions",
    label: "Run sessions",
    description: "Start sessions, send messages and read their results.",
    permissions: ["Read sessions", "Start sessions", "Send messages"],
  },
  {
    id: "full_automation",
    label: "Full automation",
    description: "Everything a workspace member can do, including schedules and variable sets.",
    permissions: [
      "Read sessions",
      "Start sessions",
      "Send messages",
      "Manage schedules",
      "Use variable sets",
      "Read and write files",
    ],
  },
  {
    id: "custom",
    label: "Custom",
    description: "Pick exactly what this key can do.",
    permissions: [],
  },
];

export const apiKeyExpiryOptions = [
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "1y", label: "1 year" },
  { id: "never", label: "Never" },
];

export const defaultApiKeyExpiry = "90d";

export interface ApiKey {
  id: string;
  name: string;
  /** Mono prefix, for example "ogk_d591f5ad". */
  prefix: string;
  /** "ogk_d591f5ad…". */
  prefixLabel: string;
  access: ApiKeyAccess;
  /** "Run sessions (3 permissions)". */
  accessLabel: string;
  permissions: string[];
  lastUsedLabel: string;
  /** "Never", "31 Mar 2027" or "-". */
  expiresLabel: string;
  status: ApiKeyStatus;
  /** "Active", "Expired" or "Revoked 12 Aug". */
  statusLabel: string;
  createdLabel: string;
  createdBy: string;
}

export const apiKeys: ApiKey[] = [
  {
    id: "key-ci",
    name: "CI pipeline",
    prefix: "ogk_b76d4e32",
    prefixLabel: "ogk_b76d4e32…",
    access: "run_sessions",
    accessLabel: "Run sessions (3 permissions)",
    permissions: ["Read sessions", "Start sessions", "Send messages"],
    lastUsedLabel: "2 hours ago",
    expiresLabel: "Never",
    status: "active",
    statusLabel: "Active",
    createdLabel: "Created 18 Jun 2026",
    createdBy: "Bendik Hansen",
  },
  {
    id: "key-terraform",
    name: "Terraform runner",
    prefix: "ogk_d591f5ad",
    prefixLabel: "ogk_d591f5ad…",
    access: "custom",
    accessLabel: "Custom (4 permissions)",
    permissions: ["Read sessions", "Start sessions", "Use variable sets", "Read files"],
    lastUsedLabel: "Never",
    expiresLabel: "31 Mar 2027",
    status: "active",
    statusLabel: "Active",
    createdLabel: "Created 24 Sep 2026",
    createdBy: "Maria Chen",
  },
  {
    id: "key-staging-smoke",
    name: "Staging smoke tests",
    prefix: "ogk_1c0e77b9",
    prefixLabel: "ogk_1c0e77b9…",
    access: "read_only",
    accessLabel: "Read only",
    permissions: ["Read sessions", "Read files", "Read knowledge"],
    lastUsedLabel: "3 weeks ago",
    expiresLabel: "20 Sep 2026",
    status: "expired",
    statusLabel: "Expired",
    createdLabel: "Created 22 Jun 2026",
    createdBy: "Jonas Berg",
  },
  {
    id: "key-old-deploy",
    name: "Old deploy key",
    prefix: "ogk_9a41d2e0",
    prefixLabel: "ogk_9a41d2e0…",
    access: "full_automation",
    accessLabel: "Full automation",
    permissions: apiKeyPresets[2]!.permissions,
    lastUsedLabel: "12 Aug",
    expiresLabel: "-",
    status: "revoked",
    statusLabel: "Revoked 12 Aug",
    createdLabel: "Created 3 Mar 2026",
    createdBy: "Bendik Hansen",
  },
];

/** The token shown once in step 2 of Create API key. Fake. */
export const newApiKeySecret = {
  name: "Release bot",
  token: "ogk_7e21c9a0_example-token-shown-once-4k9m2p",
  prefixLabel: "ogk_7e21c9a0…",
  expiresLabel: "Expires 25 Dec 2026",
};

/* ----------------------------------------------------------------------------
   Knowledge (Platform engineering)
   -------------------------------------------------------------------------- */

export type KnowledgeType = "decision" | "requirement" | "incident" | "fact" | "note";
export type KnowledgeScope = "workspace" | "personal" | "organization";

export interface KnowledgeEntry {
  id: string;
  title: string;
  type: KnowledgeType;
  typeLabel: string;
  scope: KnowledgeScope;
  collection?: string;
  source?: { kind: "file"; name: string } | { kind: "chat"; name: string };
  content: string;
  updatedAt: string;
  updatedLabel: string;
  author: string;
}

export const knowledgeEntries: KnowledgeEntry[] = [
  {
    id: "kn-second-reviewer",
    title: "Production deploys need a second reviewer",
    type: "decision",
    typeLabel: "Decision",
    scope: "workspace",
    content:
      "Every deploy to production needs approval from a second engineer. The on-call engineer can approve their own hotfix, and must get a review within one working day.",
    updatedAt: "2026-09-18T08:15:00Z",
    updatedLabel: "8 days ago",
    author: "Maria Chen",
  },
  {
    id: "kn-eu-residency",
    title: "EU customer data stays in eu-north-1",
    type: "requirement",
    typeLabel: "Requirement",
    scope: "workspace",
    content:
      "Customer data for EU accounts is stored and processed only in eu-north-1. Backups replicate to eu-west-1. Analytics exports must be aggregated before leaving the region.",
    updatedAt: "2026-09-02T12:40:00Z",
    updatedLabel: "3 weeks ago",
    author: "Bendik Hansen",
  },
  {
    id: "kn-checkout-outage",
    title: "14 Sep checkout outage",
    type: "incident",
    typeLabel: "Incident",
    scope: "workspace",
    collection: "Incidents",
    content:
      "Checkout returned errors for 38 minutes after a connection pool change in checkout-api. Rolled back at 15:12. Follow-up: load test pool changes in staging first.",
    updatedAt: "2026-09-15T09:30:00Z",
    updatedLabel: "11 days ago",
    author: "Jonas Berg",
  },
  {
    id: "kn-staging-readonly",
    title: "Staging DB is read-only for agents",
    type: "fact",
    typeLabel: "Fact",
    scope: "workspace",
    content:
      "Agents connect to the staging database as agent_ro, which can read every table but can't write. Ask the platform team for a scratch schema when a task needs writes.",
    updatedAt: "2026-09-11T14:25:00Z",
    updatedLabel: "2 weeks ago",
    author: "Maria Chen",
  },
  {
    id: "kn-datadog-runbook",
    title: "Runbook: rotating the Datadog keys",
    type: "note",
    typeLabel: "Note",
    scope: "workspace",
    source: { kind: "file", name: "runbook.pdf" },
    content:
      "1. Create new API and app keys in Datadog (EU site). 2. Replace DD_API_KEY and DD_APP_KEY in the Datadog variable set. 3. Revoke the old keys after the next scheduled run succeeds.",
    updatedAt: "2026-08-29T10:00:00Z",
    updatedLabel: "4 weeks ago",
    author: "Bendik Hansen",
  },
];

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

export type ReviewKind = "knowledge" | "instruction" | "skill";

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  kindLabel: string;
  title: string;
  origin: { kind: "chat" | "schedule"; name: string };
  createdLabel: string;
  summary: string;
  diff: DiffLine[];
}

/** Review (3). */
export const reviewItems: ReviewItem[] = [
  {
    id: "review-eu-residency",
    kind: "knowledge",
    kindLabel: "Knowledge",
    title: "EU customer data stays in eu-north-1",
    origin: { kind: "chat", name: "Data residency audit" },
    createdLabel: "2 hours ago",
    summary: "Update to an existing entry",
    diff: [
      {
        kind: "context",
        text: "Customer data for EU accounts is stored and processed only in eu-north-1.",
      },
      { kind: "removed", text: "Backups replicate to eu-west-1." },
      {
        kind: "added",
        text: "Backups replicate to eu-central-1 since the 1 Sep storage migration.",
      },
      {
        kind: "context",
        text: "Analytics exports must be aggregated before leaving the region.",
      },
    ],
  },
  {
    id: "review-draft-prs",
    kind: "instruction",
    kindLabel: "Instruction",
    title: "Add: Always open pull requests as drafts",
    origin: { kind: "schedule", name: "Weekly dependency update PR" },
    createdLabel: "Mon 21 Sep, 09:37",
    summary: "New workspace instruction",
    diff: [
      { kind: "context", text: "## How we work" },
      { kind: "context", text: "- Production changes need a second reviewer." },
      { kind: "context", text: "- Prefer small PRs." },
      { kind: "added", text: "- Always open pull requests as drafts." },
    ],
  },
  {
    id: "review-release-notes",
    kind: "skill",
    kindLabel: "Skill",
    title: "New skill: Release notes",
    origin: { kind: "chat", name: "Cut 2.14" },
    createdLabel: "Thu 24 Sep, 16:02",
    summary: "New skill",
    diff: [
      { kind: "added", text: "# Release notes" },
      { kind: "added", text: "Write release notes from merged pull requests since the last tag." },
      { kind: "added", text: "Group changes as New, Improved and Fixed. Link each PR." },
    ],
  },
];

export interface InstructionRevision {
  id: string;
  author: string;
  createdLabel: string;
  summary: string;
  markdown: string;
}

export const workspaceInstructions = {
  markdown: "## How we work\n\n- Production changes need a second reviewer.\n- Prefer small PRs.",
  revisions: [
    {
      id: "rev-2",
      author: "Bendik Hansen",
      createdLabel: "3 days ago",
      summary: "Added: Prefer small PRs.",
      markdown:
        "## How we work\n\n- Production changes need a second reviewer.\n- Prefer small PRs.",
    },
    {
      id: "rev-1",
      author: "Maria Chen",
      createdLabel: "Created 18 Sep",
      summary: "Created the instructions",
      markdown: "## How we work\n\n- Production changes need a second reviewer.",
    },
  ] satisfies InstructionRevision[],
};

export const organizationIdentity = {
  name: "Acme Robotics",
  identity: "Acme Robotics builds warehouse robots and the software fleet that runs them.",
  mission: "Make every warehouse shift safer and calmer with robots people trust.",
  editedLabel: "Edited by Bendik Hansen on 12 Sep",
};

export type LearningMode = "automatic" | "review_first" | "off";

export const learningModes: Array<{ id: LearningMode; label: string }> = [
  { id: "automatic", label: "Automatic" },
  { id: "review_first", label: "Review first" },
  { id: "off", label: "Off" },
];

export const learningSettings = {
  shared: {
    title: "Shared chats in Design preview",
    knowledge: "automatic" as LearningMode,
    instructions: "review_first" as LearningMode,
    skills: "review_first" as LearningMode,
  },
  private: {
    title: "Your private chats (all workspaces)",
    knowledge: "automatic" as LearningMode,
    instructions: "automatic" as LearningMode,
    skills: "automatic" as LearningMode,
  },
  overridesLabel: "2 schedules use different settings",
};

/* ----------------------------------------------------------------------------
   Capabilities
   -------------------------------------------------------------------------- */

export type CapabilityKind = "connection" | "skill" | "plugin";
export type CapabilityStatus =
  | "connected"
  | "needs_reconnect"
  | "unavailable"
  | "installed"
  | "available";

export interface Capability {
  id: string;
  name: string;
  description: string;
  kind: CapabilityKind;
  /** "By Google", "From vercel-labs on skills.sh". */
  byLine: string;
  status: CapabilityStatus;
  /** Reason or next step for needs-reconnect and unavailable. */
  statusDetail?: string;
  ownership?: "personal" | "workspace";
  /** Key for a brand logo, when one exists. */
  logoKey?: string;
  monogram: string;
  /** CTA in product words: "Connect Gmail". */
  actionLabel?: string;
}

export const connectedCapabilities: Capability[] = [
  {
    id: "cap-gmail",
    name: "Gmail",
    description: "Search, read, draft, and send email from your Gmail.",
    kind: "connection",
    byLine: "By Google",
    status: "connected",
    ownership: "personal",
    logoKey: "gmail",
    monogram: "G",
  },
  {
    id: "cap-linear",
    name: "Linear",
    description: "Create, update and search issues and projects.",
    kind: "connection",
    byLine: "By Linear",
    status: "needs_reconnect",
    statusDetail: "Sign in again to keep using Linear.",
    ownership: "workspace",
    logoKey: "linear",
    monogram: "L",
    actionLabel: "Reconnect Linear",
  },
  {
    id: "cap-posthog",
    name: "PostHog",
    description: "Product analytics, feature flags, and session insights.",
    kind: "connection",
    byLine: "By PostHog",
    status: "connected",
    ownership: "workspace",
    logoKey: "posthog",
    monogram: "P",
  },
];

export const popularCapabilities: Capability[] = [
  {
    id: "cap-github",
    name: "GitHub",
    description: "Read code, open pull requests and review issues.",
    kind: "connection",
    byLine: "By GitHub",
    status: "unavailable",
    statusDetail:
      "GitHub isn't available on this OpenGeni server yet. An admin needs to add the GitHub App.",
    logoKey: "github",
    monogram: "G",
  },
  {
    id: "cap-slack",
    name: "Slack",
    description: "Chat with OpenGeni in Slack, or let it read and send messages as you.",
    kind: "connection",
    byLine: "By Slack",
    status: "available",
    logoKey: "slack",
    monogram: "S",
    actionLabel: "Connect Slack",
  },
  {
    id: "cap-atlassian",
    name: "Jira & Confluence",
    description: "Search and update Jira issues and Confluence pages.",
    kind: "connection",
    byLine: "By Atlassian",
    status: "available",
    logoKey: "atlassian",
    monogram: "J",
    actionLabel: "Connect Jira & Confluence",
  },
  {
    id: "cap-google-drive",
    name: "Google Drive",
    description: "Read the folders you choose and publish finished documents.",
    kind: "connection",
    byLine: "By Google",
    status: "available",
    logoKey: "google-drive",
    monogram: "D",
    actionLabel: "Connect Google Drive",
  },
  {
    id: "cap-notion",
    name: "Notion",
    description: "Search and update pages and databases.",
    kind: "connection",
    byLine: "By Notion",
    status: "available",
    logoKey: "notion",
    monogram: "N",
    actionLabel: "Connect Notion",
  },
  {
    id: "cap-airtable",
    name: "Airtable",
    description: "Bases, tables, and records.",
    kind: "connection",
    byLine: "By Airtable",
    status: "available",
    logoKey: "airtable",
    monogram: "A",
    actionLabel: "Connect Airtable",
  },
  {
    id: "cap-front",
    name: "Front",
    description: "Shared inbox conversations and contacts.",
    kind: "connection",
    byLine: "By Front",
    status: "available",
    logoKey: "front",
    monogram: "F",
    actionLabel: "Connect Front",
  },
];

export const skillCapabilities: Capability[] = [
  {
    id: "skill-agent-browser",
    name: "Agent browser",
    description: "Browse websites, fill in forms and take screenshots.",
    kind: "skill",
    byLine: "From vercel-labs on skills.sh",
    status: "available",
    monogram: "A",
    actionLabel: "Install",
  },
  {
    id: "skill-web-design",
    name: "Web design guidelines",
    description: "Review interfaces against layout, type and accessibility rules.",
    kind: "skill",
    byLine: "From vercel-labs on skills.sh",
    status: "available",
    monogram: "W",
    actionLabel: "Install",
  },
  {
    id: "skill-release-notes",
    name: "Release notes",
    description: "Write release notes from merged pull requests since the last tag.",
    kind: "skill",
    byLine: "Made in this workspace",
    status: "installed",
    monogram: "R",
  },
];

/* ----------------------------------------------------------------------------
   Chats (referenced by usage and review fixtures)
   -------------------------------------------------------------------------- */

export const chats = [
  { id: "chat-q3-revenue", title: "Q3 revenue review", updatedLabel: "Yesterday" },
  { id: "chat-data-residency", title: "Data residency audit", updatedLabel: "2 hours ago" },
  { id: "chat-cut-2-14", title: "Cut 2.14", updatedLabel: "Thu 24 Sep" },
];
