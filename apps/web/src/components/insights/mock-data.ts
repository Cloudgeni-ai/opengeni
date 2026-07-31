/**
 * Preview rollups shaped like queries we can run today (or with thin joins).
 *
 * Primary sources:
 * - usage_events: model.tokens, model.cost, sandbox.warm_*, agent_run.*,
 *   scheduled_task.fired, file.*, document.*, api_key.request
 *   (+ session_id, turn_id, turn_attempt_id, origin, initiator_*)
 * - sessions / turns / goals: live status, active goal, pause fence
 * - sandbox leases: warm/idle compute
 * - codex_capacity_waiters + credential snapshots: capacity waits (not $)
 * - session_events: approvals / steers (audit timeline — not model memory)
 *
 * Account credit balance stays on Organization settings; this page attributes
 * workspace consumption only.
 */

export const INSIGHTS_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Matches usage_events.origin check constraint. */
export type UsageOrigin =
  | "user"
  | "scheduled_task"
  | "api"
  | "goal"
  | "system"
  | "compaction";

/** Live session states we can derive from sessions + turns + waiters + control. */
export type SessionFloorState =
  | "running"
  | "approval"
  | "capacity"
  | "paused"
  | "failed"
  | "idle"
  | "compacting";

export type AttentionItem = {
  id: string;
  /** Durable signal class */
  source:
    | "turn.approval"
    | "codex_capacity_waiter"
    | "sandbox.warm_idle"
    | "scheduled_task.denial_loop";
  title: string;
  detail: string;
  sessionId?: string;
  sinceLabel: string;
};

export type FloorSession = {
  id: string;
  title: string;
  state: SessionFloorState;
  /** Age of active turn attempt, or time since last settlement */
  ageLabel: string;
  /**
   * Recent attributed model.cost + warm_cost for this session tree ($/h).
   * null when no recent meter rows.
   */
  burnUsdPerHour: number | null;
  /** Effective sandbox backend or machine route */
  route: string;
  /** initiator_kind + initiator_subject_id (or schedule/api key label) */
  initiatorLabel: string;
  origin: UsageOrigin | "mixed";
  /** Whether turns are Codex-externally-billed (credit $ ≈ 0) */
  billing: "credits" | "codex" | "mixed";
};

export type SpendDriver = {
  id: string;
  /** Grouping key we can implement */
  groupBy: "root_session" | "schedule" | "api_key" | "origin" | "warm_idle";
  label: string;
  /** sum(model.cost + sandbox.warm_cost) in USD for the window */
  creditUsd: number;
  /** sum(model.tokens) */
  tokens: number;
  pctOfCreditUsd: number;
  deltaUsdVsPrior: number;
};

export type MeterDay = {
  day: (typeof INSIGHTS_DAYS)[number];
  /** sum(model.cost) / 1e6 */
  modelCostUsd: number;
  /** sum(sandbox.warm_cost) / 1e6 */
  warmCostUsd: number;
  /** sum(model.tokens) */
  tokens: number;
  /** count turns with Codex external billing (model.cost audit 0 path) */
  codexTurns: number;
  /** capacity waiter rows opened that day */
  capacityWaitsStarted: number;
  /** agent_run.completed */
  runsCompleted: number;
};

/** Window totals — all from usage_events unless noted. */
export const WINDOW = {
  label: "Last 7 days",
  priorLabel: "Prior 7 days",
  /** sum(model.cost) */
  modelCostUsd: 145.2,
  priorModelCostUsd: 82.4,
  /** sum(sandbox.warm_cost) */
  warmCostUsd: 41.2,
  priorWarmCostUsd: 18.8,
  /** sum(model.tokens) */
  tokens: 128_600_000,
  priorTokens: 71_200_000,
  /** count agent_run.completed */
  runsCompleted: 891,
  priorRunsCompleted: 640,
  /** turns on Codex external-billing path (not in modelCostUsd) */
  codexTurns: 412,
  priorCodexTurns: 388,
  /** sessions with an active goal row */
  goalsActive: 6,
  /** goal status transitions to completed in window (goal events) */
  goalsCompleted: 14,
  /** open codex_capacity_waiters now */
  capacityWaitingNow: 2,
  /** turns waiting on approval now */
  approvalWaitingNow: 1,
  /** warm leases with 0 active turns for >2h */
  warmIdleNow: 1,
  /** static/managed cap mirrors (entitlements) */
  tokenCap: 200_000_000,
  runCap: 2000,
} as const;

export const DAYS: MeterDay[] = [
  {
    day: "Mon",
    modelCostUsd: 12,
    warmCostUsd: 3,
    tokens: 11_200_000,
    codexTurns: 48,
    capacityWaitsStarted: 0,
    runsCompleted: 98,
  },
  {
    day: "Tue",
    modelCostUsd: 14,
    warmCostUsd: 4,
    tokens: 12_800_000,
    codexTurns: 52,
    capacityWaitsStarted: 1,
    runsCompleted: 110,
  },
  {
    day: "Wed",
    modelCostUsd: 18,
    warmCostUsd: 5,
    tokens: 16_100_000,
    codexTurns: 61,
    capacityWaitsStarted: 0,
    runsCompleted: 124,
  },
  {
    day: "Thu",
    modelCostUsd: 41,
    warmCostUsd: 9,
    tokens: 28_400_000,
    codexTurns: 70,
    capacityWaitsStarted: 3,
    runsCompleted: 168,
  },
  {
    day: "Fri",
    modelCostUsd: 28,
    warmCostUsd: 8,
    tokens: 22_100_000,
    codexTurns: 55,
    capacityWaitsStarted: 2,
    runsCompleted: 142,
  },
  {
    day: "Sat",
    modelCostUsd: 19,
    warmCostUsd: 6,
    tokens: 19_200_000,
    codexTurns: 78,
    capacityWaitsStarted: 4,
    runsCompleted: 131,
  },
  {
    day: "Sun",
    modelCostUsd: 13.2,
    warmCostUsd: 6.2,
    tokens: 18_800_000,
    codexTurns: 48,
    capacityWaitsStarted: 1,
    runsCompleted: 118,
  },
];

/** sum(model.tokens) group by usage_events.origin */
export const TOKENS_BY_ORIGIN: Array<{ origin: UsageOrigin; tokens: number }> = [
  { origin: "goal", tokens: 51_000_000 },
  { origin: "user", tokens: 42_000_000 },
  { origin: "scheduled_task", tokens: 28_000_000 },
  { origin: "compaction", tokens: 7_600_000 },
  { origin: "api", tokens: 0 },
  { origin: "system", tokens: 0 },
];

/**
 * Credit $ drivers: sum(model.cost + warm_cost) attributed by
 * root session / schedule id / api key subject / warm-with-no-turn.
 */
export const CREDIT_DRIVERS: SpendDriver[] = [
  {
    id: "drv-iam",
    groupBy: "root_session",
    label: "refactor-iam-bindings (session tree)",
    creditUsd: 71.2,
    tokens: 38_400_000,
    pctOfCreditUsd: 38,
    deltaUsdVsPrior: 61,
  },
  {
    id: "drv-tf",
    groupBy: "schedule",
    label: "tf-plan-hourly (schedule)",
    creditUsd: 29.1,
    tokens: 14_200_000,
    pctOfCreditUsd: 16,
    deltaUsdVsPrior: 21.4,
  },
  {
    id: "drv-ci",
    groupBy: "api_key",
    label: "ci-opengeni (API key)",
    creditUsd: 18.4,
    tokens: 9_100_000,
    pctOfCreditUsd: 10,
    deltaUsdVsPrior: 9.1,
  },
  {
    id: "drv-warm",
    groupBy: "warm_idle",
    label: "Warm idle (no active turn)",
    creditUsd: 23.2,
    tokens: 0,
    pctOfCreditUsd: 12,
    deltaUsdVsPrior: 11,
  },
  {
    id: "drv-other",
    groupBy: "origin",
    label: "All other credit-billed work",
    creditUsd: 44.5,
    tokens: 66_900_000,
    pctOfCreditUsd: 24,
    deltaUsdVsPrior: -1.7,
  },
];

export const ATTENTION: AttentionItem[] = [
  {
    id: "att-approval",
    source: "turn.approval",
    title: "Approval waiting",
    detail: "azure-landing-zone · shell:apply · maja@",
    sessionId: "sess-landing",
    sinceLabel: "4h 12m",
  },
  {
    id: "att-capacity",
    source: "codex_capacity_waiter",
    title: "Codex capacity wait",
    detail: "nightly-drift-sweep · active goal · waiter fence v18",
    sessionId: "sess-drift",
    sinceLabel: "2h 01m",
  },
  {
    id: "att-warm",
    source: "sandbox.warm_idle",
    title: "Warm sandbox idle",
    detail: "sg_modal_7f2a · $4.80 warm_cost · 0 active turns",
    sinceLabel: "6h 02m",
  },
  {
    id: "att-schedule",
    source: "scheduled_task.denial_loop",
    title: "Schedule denials",
    detail: "tf-plan-hourly · 14 denials today · still enabled",
    sinceLabel: "12m since last fire",
  },
];

export const FLOOR_SESSIONS: FloorSession[] = [
  {
    id: "sess-landing",
    title: "azure-landing-zone",
    state: "approval",
    ageLabel: "4h 12m",
    burnUsdPerHour: 0,
    route: "modal",
    initiatorLabel: "subject:maja@",
    origin: "user",
    billing: "credits",
  },
  {
    id: "sess-drift",
    title: "nightly-drift-sweep",
    state: "capacity",
    ageLabel: "2h 01m",
    burnUsdPerHour: 0,
    route: "codex",
    initiatorLabel: "schedule:nightly-drift",
    origin: "scheduled_task",
    billing: "codex",
  },
  {
    id: "sess-iam",
    title: "refactor-iam-bindings",
    state: "running",
    ageLabel: "11h 40m",
    burnUsdPerHour: 6.4,
    route: "modal",
    initiatorLabel: "steer←lars@",
    origin: "goal",
    billing: "credits",
  },
  {
    id: "sess-docs",
    title: "docs-memory-curation",
    state: "running",
    ageLabel: "38m",
    burnUsdPerHour: 0.4,
    route: "docker",
    initiatorLabel: "api_key:ci-opengeni",
    origin: "api",
    billing: "credits",
  },
  {
    id: "sess-runbook",
    title: "customer-runbook-bot",
    state: "paused",
    ageLabel: "—",
    burnUsdPerHour: 0,
    route: "selfhosted:build-3",
    initiatorLabel: "subject:inge@",
    origin: "user",
    billing: "credits",
  },
  {
    id: "sess-tf",
    title: "tf-plan-hourly",
    state: "failed",
    ageLabel: "12m ago",
    burnUsdPerHour: null,
    route: "modal",
    initiatorLabel: "schedule:tf-plan-hourly",
    origin: "scheduled_task",
    billing: "credits",
  },
  {
    id: "sess-pack",
    title: "pack-azure-verify",
    state: "idle",
    ageLabel: "22m ago",
    burnUsdPerHour: null,
    route: "modal",
    initiatorLabel: "goal",
    origin: "goal",
    billing: "credits",
  },
  {
    id: "sess-slack",
    title: "slack-triage-helper",
    state: "running",
    ageLabel: "1h 05m",
    burnUsdPerHour: 0.15,
    route: "selfhosted:ops-1",
    initiatorLabel: "subject:slack-bot",
    origin: "user",
    billing: "credits",
  },
  {
    id: "sess-compact",
    title: "compact-heavy-thread",
    state: "compacting",
    ageLabel: "4m",
    burnUsdPerHour: 0.9,
    route: "codex",
    initiatorLabel: "origin:compaction",
    origin: "compaction",
    billing: "codex",
  },
];

export const WARM_LEASES = [
  {
    id: "sg_modal_7f2a",
    backend: "modal",
    warmLabel: "6h 02m",
    activeSessions: 0,
    status: "idle" as const,
    /** Recent warm_cost attributed while idle */
    warmCostUsd: 4.8,
  },
  {
    id: "sg_modal_91c0",
    backend: "modal",
    warmLabel: "11h 40m",
    activeSessions: 3,
    status: "active" as const,
    warmCostUsd: 18.2,
  },
  {
    id: "sg_docker_dev",
    backend: "docker",
    warmLabel: "38m",
    activeSessions: 1,
    status: "active" as const,
    warmCostUsd: 0.9,
  },
];

/** scheduled_task.fired + attributed usage + admission denials */
export const SCHEDULE_ROWS = [
  {
    id: "sched-tf",
    name: "tf-plan-hourly",
    fires: 168,
    creditUsd: 29.1,
    tokens: 14_200_000,
    denials: 14,
    billing: "credits" as const,
  },
  {
    id: "sched-drift",
    name: "nightly-drift-sweep",
    fires: 7,
    creditUsd: 0,
    tokens: 0,
    denials: 2,
    billing: "codex" as const,
  },
  {
    id: "sched-memory",
    name: "memory-digest-06:00",
    fires: 7,
    creditUsd: 4.2,
    tokens: 2_100_000,
    denials: 0,
    billing: "credits" as const,
  },
];

export const SESSION_TREE = [
  {
    id: "root",
    label: "refactor-iam-bindings",
    role: "root" as const,
    creditUsd: 25.4,
    tokens: 12_100_000,
    state: "running",
    initiatorLabel: "steer←lars@",
  },
  {
    id: "c1",
    label: "enumerate-bindings",
    role: "child" as const,
    creditUsd: 14.2,
    tokens: 6_800_000,
    state: "idle",
    initiatorLabel: "agent",
  },
  {
    id: "c2",
    label: "rewrite-module-a",
    role: "child" as const,
    creditUsd: 11.1,
    tokens: 5_200_000,
    state: "running",
    initiatorLabel: "agent",
  },
  {
    id: "c3",
    label: "rewrite-module-b",
    role: "child" as const,
    creditUsd: 9.8,
    tokens: 4_900_000,
    state: "running",
    initiatorLabel: "agent",
  },
  {
    id: "c4",
    label: "verify-plan",
    role: "child" as const,
    creditUsd: 6.4,
    tokens: 3_100_000,
    state: "approval",
    initiatorLabel: "agent",
  },
];

export type TraceTarget = {
  driverId: string;
  label: string;
};

export function formatUsd(value: number, digits = 2): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(digits)}`;
}

export function formatDeltaUsd(value: number): string {
  if (value === 0) return "$0.00";
  const sign = value > 0 ? "+" : "−";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function pctDelta(current: number, prior: number): number {
  if (prior === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - prior) / prior) * 100);
}

export function creditTotalUsd(): number {
  return WINDOW.modelCostUsd + WINDOW.warmCostUsd;
}

export function priorCreditTotalUsd(): number {
  return WINDOW.priorModelCostUsd + WINDOW.priorWarmCostUsd;
}
