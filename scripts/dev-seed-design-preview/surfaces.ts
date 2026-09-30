/**
 * Schedules, run history, Knowledge review queue, capabilities and usage data
 * for the design-preview seed. Data only; the main script applies it.
 */
import type { ConversationBuilder } from "./timeline";
import type { RichSessionSeed } from "./rich-sessions";

export type ScheduleSeed = {
  name: string;
  prompt: string;
  schedule: Record<string, unknown>;
  overlapPolicy?: string;
  /**
   * `manual` schedules are created active (no Temporal schedule exists, only
   * Run now fires them). `display` schedules are created paused through the
   * API and flipped to active in the database only, so the UI shows a live
   * cadence while the Temporal schedule stays paused.
   */
  active?: "manual" | "display";
};

export type RunSeed = {
  daysAgo: number;
  status: "succeeded" | "failed" | "skipped";
  minutes: number;
  trigger?: "scheduled" | "manual";
  error?: string;
  /** A generated session for this run (grouped under the task in the rail). */
  session?: { title: string; script: (b: ConversationBuilder) => void };
};

/** New schedules per workspace ("Personal" means the owner's Personal workspace). */
export const EXTRA_SCHEDULES: Record<string, ScheduleSeed[]> = {
  Personal: [
    {
      name: "Morning briefing",
      prompt:
        "Summarize overnight alerts, pull requests waiting on my review and today's calendar in five bullets.",
      schedule: {
        type: "calendar",
        timeZone: "Europe/Oslo",
        hour: 7,
        minute: 30,
        daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
      },
      active: "display",
    },
    {
      name: "Draft Friday update",
      prompt: "Draft my weekly update from merged pull requests and closed Linear issues.",
      schedule: {
        type: "calendar",
        timeZone: "Europe/Oslo",
        hour: 15,
        minute: 0,
        daysOfWeek: ["FRIDAY"],
      },
      active: "display",
    },
    {
      name: "Clean up stale branches",
      prompt: "List my branches with no commits in 30 days and delete the merged ones.",
      schedule: { type: "manual" },
      active: "manual",
    },
    {
      name: "Renew local dev certificates",
      prompt: "Renew the mkcert certificates for the local dev domains and restart the proxy.",
      schedule: {
        type: "once",
        runAt: new Date(Date.now() + 12 * 86_400_000).toISOString(),
        timeZone: "Europe/Oslo",
      },
    },
  ],
  "Platform engineering": [
    {
      name: "Post on-call handover",
      prompt: "Summarize this week's incidents and post the handover to #platform-oncall.",
      schedule: { type: "manual" },
      active: "manual",
    },
  ],
};

/** Existing (seeded paused) schedules shown as active in the UI. */
export const DISPLAY_ACTIVE_SCHEDULES: Record<string, string[]> = {
  "Platform engineering": ["Check AWS cost anomalies", "Weekly dependency update PR"],
  "Customer success": ["Daily ticket digest"],
  "Finance ops": ["Weekly cash position"],
  "Design preview": ["Screenshot regression sweep"],
};

const SCHEDULER = { kind: "service", label: "OpenGeni scheduler", subjectId: "scheduler" } as const;
export const SCHEDULER_INITIATOR = SCHEDULER;

const awsRun = (anomaly: string | null) => (b: ConversationBuilder) => {
  b.user("Compare yesterday's AWS spend with the 14-day average and flag services above 20%.")
    .tool({
      name: "aws__get_cost_and_usage",
      display: {
        toolName: "get_cost_and_usage",
        title: "Get cost and usage",
        accountLabel: "AWS · production",
      },
      args: { granularity: "DAILY", groupBy: "SERVICE", period: "last_15_days" },
      output: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              services: 23,
              yesterdayUsd: anomaly ? 1284.4 : 1012.9,
              avg14dUsd: 1006.2,
            }),
          },
        ],
      },
    })
    .answer(
      anomaly
        ? `**1 anomaly** yesterday: ${anomaly}\n\n| Service | Yesterday | 14-day avg | Change |\n| --- | ---: | ---: | ---: |\n| RDS | $412.80 | $297.10 | **+39%** |\n| EC2 | $604.20 | $588.40 | +3% |\n| S3 | $118.60 | $115.30 | +3% |`
        : `No anomalies yesterday. Total spend $1,012.90 (+0.7% vs the 14-day average); no service moved more than 6%.`,
    );
};

const briefingRun = (alerts: string) => (b: ConversationBuilder) => {
  b.user(
    "Summarize overnight alerts, pull requests waiting on my review and today's calendar in five bullets.",
  )
    .tool({
      name: "github__search_pull_requests",
      display: {
        toolName: "search_pull_requests",
        title: "Search pull requests",
        accountLabel: "GitHub · acme-robotics",
      },
      args: { query: "review-requested:bendik-acme is:open" },
      output: { content: [{ type: "text", text: JSON.stringify({ total: 3 }) }] },
    })
    .answer(
      [
        "**Morning briefing**",
        "",
        `- ${alerts}`,
        "- 3 pull requests wait on your review; #1287 (Terraform state split) is the oldest at 2 days.",
        "- Checkout p95 is back under 300 ms after the index rebuild.",
        "- 10:00 platform sync, 13:30 1:1 with Maria, 15:00 vendor call (Northwind Storage).",
        "- Deploy freeze starts Friday 14:00.",
      ].join("\n"),
    );
};

/** Run history per workspace and task, newest first. */
export const SCHEDULE_RUNS: Record<string, Record<string, RunSeed[]>> = {
  Personal: {
    "Morning briefing": [
      {
        daysAgo: 0.1,
        status: "succeeded",
        minutes: 2,
        session: {
          title: "Morning briefing: db-2 disk alert",
          script: briefingRun("One overnight alert: db-2 disk at 91% (acknowledged, CDC slot)"),
        },
      },
      {
        daysAgo: 1.1,
        status: "succeeded",
        minutes: 3,
        session: {
          title: "Morning briefing: quiet night",
          script: briefingRun("Quiet night: no alerts fired"),
        },
      },
      {
        daysAgo: 4.1,
        status: "succeeded",
        minutes: 2,
        session: {
          title: "Morning briefing: checkout p95 alert",
          script: briefingRun("Checkout p95 alert fired at 03:10 and is still open"),
        },
      },
      {
        daysAgo: 5.1,
        status: "failed",
        minutes: 1,
        error: "GitHub returned 502 Bad Gateway three times; the briefing was not generated.",
      },
      { daysAgo: 6.1, status: "succeeded", minutes: 2 },
    ],
    "Draft Friday update": [
      { daysAgo: 4.3, status: "succeeded", minutes: 4 },
      { daysAgo: 11.3, status: "succeeded", minutes: 5 },
    ],
    "Clean up stale branches": [{ daysAgo: 9, status: "succeeded", minutes: 3, trigger: "manual" }],
  },
  "Platform engineering": {
    "Check AWS cost anomalies": [
      {
        daysAgo: 0.2,
        status: "succeeded",
        minutes: 3,
        session: {
          title: "AWS cost check: RDS up 39%",
          script: awsRun(
            "RDS is up 39% after the db-2 volume grew; expected until the CDC slot is dropped.",
          ),
        },
      },
      {
        daysAgo: 1.2,
        status: "succeeded",
        minutes: 2,
        session: { title: "AWS cost check: no anomalies", script: awsRun(null) },
      },
      {
        daysAgo: 2.2,
        status: "failed",
        minutes: 1,
        error:
          "Cost Explorer throttled the request (ThrottlingException). The next run will retry.",
      },
      {
        daysAgo: 3.2,
        status: "succeeded",
        minutes: 2,
        session: { title: "AWS cost check: spend normal", script: awsRun(null) },
      },
      { daysAgo: 4.2, status: "succeeded", minutes: 3 },
      { daysAgo: 5.2, status: "succeeded", minutes: 2 },
    ],
    "Summarize new Sentry errors": [
      { daysAgo: 1.9, status: "skipped", minutes: 0 },
      { daysAgo: 1.95, status: "succeeded", minutes: 4 },
      { daysAgo: 2.0, status: "succeeded", minutes: 3 },
    ],
    "Weekly dependency update PR": [
      { daysAgo: 1.1, status: "succeeded", minutes: 11 },
      { daysAgo: 8.1, status: "succeeded", minutes: 9 },
      {
        daysAgo: 15.1,
        status: "failed",
        minutes: 6,
        error:
          "Tests failed after bumping @aws-sdk/client-s3 to 3.654.0; no pull request was opened.",
      },
    ],
    "Post on-call handover": [{ daysAgo: 6, status: "succeeded", minutes: 2, trigger: "manual" }],
  },
  "Customer success": {
    "Daily ticket digest": [
      {
        daysAgo: 0.3,
        status: "failed",
        minutes: 1,
        error:
          "Zendesk returned 401 Unauthorized: the API token in the Zendesk variable set was revoked.",
      },
      { daysAgo: 1.3, status: "succeeded", minutes: 3 },
      { daysAgo: 2.3, status: "succeeded", minutes: 4 },
      { daysAgo: 5.3, status: "succeeded", minutes: 3 },
    ],
  },
  "Finance ops": {
    "Weekly cash position": [
      { daysAgo: 1.2, status: "succeeded", minutes: 2 },
      { daysAgo: 8.2, status: "succeeded", minutes: 2 },
    ],
  },
  "Design preview": {
    "Screenshot regression sweep": [
      { daysAgo: 0.4, status: "succeeded", minutes: 7 },
      { daysAgo: 1.4, status: "succeeded", minutes: 8 },
      {
        daysAgo: 2.4,
        status: "failed",
        minutes: 3,
        error:
          "3 of 42 pages differ from the baseline by more than 2%: /settings/keys, /fleet, /billing.",
      },
    ],
  },
};

/** Sessions generated by schedule runs, as ordinary rich session seeds. */
export function scheduledRunSessions(
  workspace: string,
): (RichSessionSeed & { scheduledTask: string })[] {
  const out: (RichSessionSeed & { scheduledTask: string })[] = [];
  for (const [task, runs] of Object.entries(SCHEDULE_RUNS[workspace] ?? {})) {
    for (const run of runs) {
      if (!run.session) continue;
      out.push({
        title: run.session.title,
        hoursAgo: run.daysAgo * 24 - run.minutes / 60,
        scheduledTask: task,
        initiator: SCHEDULER,
        script: run.session.script,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export type PendingKnowledgeSeed = {
  title: string;
  kind: "fact" | "decision" | "requirement" | "incident" | "note";
  content: string;
  /** Session the proposal came from (shown as "From chat"). */
  fromSession: string;
};

export const PENDING_KNOWLEDGE: Record<string, PendingKnowledgeSeed[]> = {
  "Platform engineering": [
    {
      title: "EKS 1.31 needs ingress-nginx 4.11+ and keda 2.15+",
      kind: "fact",
      content:
        "Both charts shipped flowcontrol.apiserver.k8s.io/v1beta3 objects, which Kubernetes 1.31 removes. Bump them before upgrading the control plane.",
      fromSession: "Upgrade Kubernetes to 1.31 in staging",
    },
    {
      title: "Inactive replication slots can fill the database disk",
      kind: "incident",
      content:
        "db-2 reached 91% disk because the analytics_cdc slot was inactive and retained 158 GB of WAL. Alert on inactive slots retaining more than 10 GB.",
      fromSession: "Triage disk pressure alert on db-2",
    },
    {
      title: "Plan Kubernetes upgrades for the Tuesday window",
      kind: "decision",
      content:
        "Control-plane upgrades run in the Tuesday 10:00-12:00 window, after chart bumps have soaked for 30 minutes.",
      fromSession: "Upgrade Kubernetes to 1.31 in staging",
    },
  ],
  Personal: [
    {
      title: "Payout idempotency keys must not include the attempt number",
      kind: "requirement",
      content:
        "A payout retry must reuse the same idempotency key (payout:<payoutId>). Including the attempt number can pay twice when a worker dies after sending.",
      fromSession: "Migrate billing worker to the Postgres queue",
    },
    {
      title: "Check for invalid indexes after maintenance",
      kind: "note",
      content:
        "An interrupted REINDEX CONCURRENTLY leaves an invalid index that Postgres ignores. Run `select indexrelid::regclass from pg_index where not indisvalid` after every maintenance window.",
      fromSession: "Why is p95 latency up on /checkout?",
    },
  ],
};

/** Published personal Knowledge in the owner's Personal workspace. */
export const PERSONAL_KNOWLEDGE: {
  group: string;
  entries: { title: string; kind: string; content: string }[];
}[] = [
  {
    group: "My working notes",
    entries: [
      {
        title: "I review pull requests before 10:00",
        kind: "note",
        content: "Batch review requests in the morning; afternoons are for focused work.",
      },
      {
        title: "Staging database is walrus-2",
        kind: "fact",
        content:
          "Staging runs on walrus-2 (Postgres 16) in eu-north-1. walrus-primary was retired in August.",
      },
      {
        title: "Use squash merges for infrastructure PRs",
        kind: "decision",
        content:
          "Infrastructure pull requests are squash-merged so each Terraform change is one revertible commit.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Capabilities (custom MCP servers shown as connected, no network probe)
// ---------------------------------------------------------------------------

export const CAPABILITIES: Record<string, { name: string; domain: string; description: string }[]> =
  {
    "Platform engineering": [
      {
        name: "Acme deploy tools",
        domain: "mcp.deploy.acme.dev",
        description: "Deploy, rollback and release notes.",
      },
      {
        name: "Acme inventory",
        domain: "mcp.inventory.acme.dev",
        description: "Robot fleet and parts inventory.",
      },
    ],
    Personal: [
      {
        name: "Acme notes",
        domain: "mcp.notes.acme.dev",
        description: "Personal notes and bookmarks.",
      },
    ],
  };

// ---------------------------------------------------------------------------
// Usage (Insights)
// ---------------------------------------------------------------------------

export const USAGE_MODELS = [
  {
    provider: "openai",
    model: "gpt-6-astra",
    billing: "opengeni_credits",
    share: 0.55,
    costPerKToken: 0.9,
  },
  {
    provider: "codex-subscription",
    model: "gpt-5.5-codex",
    billing: "external",
    share: 0.35,
    costPerKToken: 0,
  },
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    billing: "opengeni_credits",
    share: 0.1,
    costPerKToken: 3.2,
  },
] as const;

// ---------------------------------------------------------------------------
// Workspace integrations (Developer page): credential provider and webhooks
// ---------------------------------------------------------------------------

/**
 * Endpoints use the reserved `.example` TLD, so nothing is ever reachable:
 * a real turn would get a `refresh_failed` notice from the credential
 * provider, and a live webhook delivery fails at DNS. Seeded delivery history
 * is inserted already settled, so the delivery pump never picks it up.
 */
export type WebhookSeed = {
  url: string;
  description: string;
  eventTypes: string[];
  enabled?: boolean;
  /** Seeded delivery history. */
  history: "healthy" | "failing" | "none";
};

export const INTEGRATIONS: Record<
  string,
  { credentialProvider?: { url: string; timeoutMs: number }; webhooks: WebhookSeed[] }
> = {
  "Platform engineering": {
    credentialProvider: {
      url: "https://platform-api.acme.example/opengeni/credentials",
      timeoutMs: 8000,
    },
    webhooks: [
      {
        url: "https://ops-dashboard.acme.example/hooks/opengeni",
        description: "Ops dashboard: every finished, failed or stopped turn.",
        eventTypes: ["turn.completed", "turn.failed", "turn.cancelled"],
        history: "healthy",
      },
      {
        url: "https://pager-bridge.acme.example/opengeni/attention",
        description: "On-call bridge: session status, approvals and questions waiting on a person.",
        eventTypes: [
          "session.status.changed",
          "session.requiresAction",
          "session.humanInput.requested",
          "turn.failed",
        ],
        history: "failing",
      },
      {
        url: "https://warehouse.acme.example/ingest/opengeni-status",
        description: "Session status stream for the analytics warehouse (paused during migration).",
        eventTypes: ["session.status.changed"],
        enabled: false,
        history: "none",
      },
    ],
  },
  "Customer success": {
    webhooks: [
      {
        url: "https://helpdesk-sync.acme.example/opengeni",
        description: "Post agent results back to the Zendesk ticket.",
        eventTypes: ["turn.completed", "turn.failed"],
        history: "healthy",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Variable sets beyond the workspace-scoped ones in the main seed
// ---------------------------------------------------------------------------

export type VariableSetSeed = {
  name: string;
  description: string;
  scope: "workspace" | "user" | "organization";
  vars: Record<string, string>;
  updates?: Record<string, string[]>;
};

/** All values are fake. `user` sets are the owner's own; `organization` sets are shared. */
export const EXTRA_VARIABLE_SETS: Record<string, VariableSetSeed[]> = {
  Personal: [
    {
      name: "My GitHub",
      description: "Personal access token for my forks and draft pull requests.",
      scope: "user",
      vars: {
        MY_GITHUB_PAT: "ghp_fakepersonaltoken0001",
        MY_GITHUB_USER: "bendik-acme",
        FORK_REMOTE: "git@github.com:bendik-acme/platform.git",
      },
      updates: { MY_GITHUB_PAT: ["ghp_fakepersonaltoken0002"] },
    },
    {
      name: "Home lab",
      description: "Tailscale and Proxmox access for side projects.",
      scope: "user",
      vars: {
        TAILSCALE_AUTHKEY: "tskey-auth-fake-0001",
        PROXMOX_URL: "https://pve.home.example:8006",
        PROXMOX_TOKEN_ID: "bendik@pve!seed",
        PROXMOX_TOKEN_SECRET: "fake-proxmox-secret",
      },
    },
    {
      name: "Scratch",
      description: "Throwaway values for trying things out.",
      scope: "workspace",
      vars: { FEATURE_FLAG_OVERRIDES: "new-checkout-summary=off", LOG_LEVEL: "debug" },
    },
  ],
  "Platform engineering": [
    {
      name: "Acme shared: Sentry",
      description: "Organization-wide Sentry read access for every workspace.",
      scope: "organization",
      vars: {
        SENTRY_ORG: "acme-robotics",
        SENTRY_AUTH_TOKEN: "sntrys_fake_0001",
        SENTRY_URL: "https://sentry.acme.example",
      },
      updates: { SENTRY_AUTH_TOKEN: ["sntrys_fake_0002"] },
    },
    {
      name: "Terraform state",
      description: "Backend credentials for the shared Terraform state bucket.",
      scope: "workspace",
      vars: {
        TF_STATE_BUCKET: "acme-tfstate-eu-north-1",
        TF_STATE_LOCK_TABLE: "acme-tf-locks",
      },
    },
  ],
};

/** Variable sets attached to seeded sessions, by workspace and session title. */
export const SESSION_VARIABLE_SETS: Record<string, Record<string, string[]>> = {
  "Platform engineering": {
    "Upgrade Kubernetes to 1.31 in staging": ["AWS production", "Terraform state"],
    "Break down September AWS spend": ["AWS production"],
    "Triage disk pressure alert on db-2": ["Staging database", "Datadog"],
    "Plan the Q4 reliability sprint": ["Acme shared: Sentry"],
  },
  Personal: {
    "Migrate billing worker to the Postgres queue": ["My GitHub"],
    "Refactor auth middleware to session handles": ["My GitHub", "Scratch"],
  },
  "Customer success": { "Weekly escalation review": ["Zendesk", "HubSpot"] },
  "Finance ops": { "Build the Q3 spend overview": ["Accounting system"] },
};

// ---------------------------------------------------------------------------
// Sandbox environments (rigs)
// ---------------------------------------------------------------------------

export type RigSeed = {
  name: string;
  description: string;
  scope?: "workspace" | "organization" | "user";
  setupScript: string;
  checks: { name: string; command: string }[];
  credentialHooks?: string[];
  variableSets?: string[];
  /** A later version, to show version history. */
  nextVersion?: { setupScript: string; changelog: string };
  /**
   * Result of the latest check run on the active version. Without a sandbox
   * backend the real verifier always fails, so the seed records a newer run.
   */
  health: { passed: true } | { passed: false; failing: string; output: string };
};

/**
 * Creating one starts the ordinary verification workflow. With no sandbox
 * backend configured it records an unsupported provider-image build instead of
 * provisioning anything. The Personal workspace grant lacks `rigs:manage`, so
 * environments live in shared workspaces only.
 */
export const RIGS: Record<string, RigSeed[]> = {
  "Platform engineering": [
    {
      name: "Node 22 + pnpm",
      description: "Web and API services: Node 22, pnpm and Playwright browsers.",
      setupScript: [
        "corepack enable",
        "corepack prepare pnpm@9.12.0 --activate",
        "pnpm config set store-dir /workspace/.pnpm-store",
        "npx --yes playwright@1.48.0 install --with-deps chromium",
      ].join("\n"),
      checks: [
        { name: "Node version", command: "node --version | grep -q '^v22'" },
        { name: "pnpm available", command: "pnpm --version" },
      ],
      variableSets: ["GitHub automation"],
      health: { passed: true },
      nextVersion: {
        setupScript: [
          "corepack enable",
          "corepack prepare pnpm@9.15.0 --activate",
          "pnpm config set store-dir /workspace/.pnpm-store",
          "npx --yes playwright@1.49.1 install --with-deps chromium",
        ].join("\n"),
        changelog: "Bump pnpm to 9.15 and Playwright to 1.49.",
      },
    },
    {
      name: "Terraform toolbox",
      description: "Terraform, tflint, terraform-docs and the AWS CLI for infra work.",
      setupScript: [
        "curl -fsSL https://github.com/terraform-linters/tflint/releases/download/v0.53.0/tflint_linux_amd64.zip -o /tmp/tflint.zip",
        "unzip -o /tmp/tflint.zip -d /usr/local/bin",
        "pip install --quiet awscli==1.35.0",
      ].join("\n"),
      checks: [
        { name: "Terraform", command: "terraform version" },
        { name: "tflint", command: "tflint --version" },
      ],
      credentialHooks: ["aws-sso-login"],
      variableSets: ["AWS production", "Terraform state"],
      health: { passed: true },
    },
    {
      name: "Python analytics",
      description: "Polars, DuckDB and Jupyter for cost and telemetry analysis.",
      setupScript: "pip install --quiet polars==1.9.0 duckdb==1.1.1 jupyterlab==4.2.5",
      checks: [{ name: "Imports", command: "python -c 'import polars, duckdb'" }],
      variableSets: ["Datadog"],
      health: {
        passed: false,
        failing: "Imports",
        output: [
          "Traceback (most recent call last):",
          '  File "<string>", line 1, in <module>',
          "ModuleNotFoundError: No module named 'duckdb'",
        ].join("\n"),
      },
    },
    {
      name: "Acme base: security tools",
      description: "Organization-wide scanners every workspace can use.",
      scope: "organization",
      setupScript:
        "pip install --quiet semgrep==1.90.0 && curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin v0.56.2",
      checks: [
        { name: "Semgrep", command: "semgrep --version" },
        { name: "Trivy", command: "trivy --version" },
      ],
      health: { passed: true },
    },
  ],
};
