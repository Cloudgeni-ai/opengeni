/**
 * Committed performance budgets for the hot database routines and queries that
 * GK rounds 1-13 made cheap. `perf-budgets-postgres.test.ts` measures each one
 * on one production-shaped, multi-tenant fixture and fails when a measurement
 * exceeds its budget here. How to read a failure and how to change a budget on
 * purpose: docs/perf-budgets.md.
 *
 * Units are deterministic work counters, never time:
 * - `buffers`: shared buffers (hit + read) of EXPLAIN (ANALYZE, BUFFERS) on the
 *   outermost statement, which counts every statement a routine runs inside it.
 * - `calls`: function calls the statement makes, from pg_stat_get_xact_function_calls.
 * - `statements`: database statements one application call sends.
 *
 * `measured` is the largest value seen at the commit that set the budget, on
 * PostgreSQL 16 (the CI test image, pgvector 0.8.7) and PostgreSQL 17, with
 * the planner pinned to its defaults. A `buffers` budget is twice that,
 * rounded up to the next multiple of 10; a `calls` or `statements` budget is
 * twice that and at least 3 more. Ordinary drift passes and a change of plan
 * shape does not.
 */
export type PerfBudgetUnit = "buffers" | "calls" | "statements";

export type PerfBudget = {
  /** What one measurement runs, in words. */
  readonly routine: string;
  readonly unit: PerfBudgetUnit;
  /** Fail above this. */
  readonly budget: number;
  /** The largest value at the commit that set `budget` (documentation only). */
  readonly measured: number;
  /** The change that made it cheap, and what regressed before it. */
  readonly guards: string;
};

export const PERF_BUDGET_DOC = "docs/perf-budgets.md";

export const PERF_BUDGETS = {
  // #8243 (1695); regressed by #8168 (1567): 10.2M buffers / 3.5 s per admission in production.
  scheduled_admission: {
    routine: "create_scheduled_agent_run_with_admission into a long scheduled chat",
    unit: "buffers",
    budget: 670,
    measured: 333,
    guards:
      "#8243 migration 1695 (bounded effective/latest turn reads); #8168 migration 1567 regressed it",
  },
  // #8201: the effective model of a chat walked every start since a settings write;
  // without index 1589 it reads every turn of the chat (1,351 buffers here).
  effective_model_read: {
    routine: "effectiveSessionPolicyQuery for a long scheduled chat",
    unit: "buffers",
    budget: 470,
    measured: 235,
    guards: "#8201 (newest 16 starts, then person/API turns; index 1589)",
  },
  // #8201: GET /scheduled-tasks read each target chat with a full getSession.
  schedule_targets_reads: {
    routine: "getSessionToolConfigs for every target chat of a schedule-heavy workspace",
    unit: "buffers",
    budget: 220,
    measured: 109,
    guards: "#8201 (one batched read of target chats)",
  },
  schedule_targets_statements: {
    routine: "getSessionToolConfigs statements for every target chat",
    unit: "statements",
    budget: 5,
    measured: 2,
    guards: "#8201 (24 session reads for 8 schedules became 1)",
  },
  // #8197 (1576/1577): the balance read summed the account's whole ledger.
  credit_balance_read: {
    routine: "getBillingBalance for an organization with a large ledger",
    unit: "buffers",
    budget: 30,
    measured: 15,
    guards: "#8197 migrations 1576-1577 (credit_ledger_account_totals)",
  },
  read_organization_plan_balance: {
    routine: "read_organization_plan_balance for an organization with a large ledger",
    unit: "buffers",
    budget: 10,
    measured: 2,
    guards: "#8197",
  },
  // #8197 (1578): a per-account nested loop when nothing was due (every minute).
  list_subscription_plan_maintenance_accounts: {
    routine: "list_subscription_plan_maintenance_accounts(50), steady state",
    unit: "buffers",
    budget: 8640,
    measured: 4318,
    guards: "#8197 migration 1578",
  },
  // #8197 (1579): the trial check read every ledger row of the account.
  free_plan_credit_eligible: {
    routine: "free_plan_credit_eligible for a busy organization, with and without its trial",
    unit: "buffers",
    budget: 120,
    measured: 60,
    guards: "#8197 index 1579 (credit_ledger_verified_signup_trial_idx)",
  },
  // #8207 (1582-1585): GC scanned row-secured leases for every artifact.
  checkpoint_gc_claim: {
    routine: "claim_sandbox_checkpoint_artifacts, nothing due, many leases with checkpoints",
    unit: "buffers",
    budget: 980,
    measured: 487,
    guards: "#8207 migrations 1582-1585 (lease projection probes)",
  },
  checkpoint_gc_prune: {
    routine: "prune_deleted_sandbox_checkpoint_artifacts, nothing due",
    unit: "buffers",
    budget: 140,
    measured: 66,
    guards: "#8207 migrations 1582-1585",
  },
  // #8211 (1597): each prune read every delivered row still in its grace window.
  host_export_outbox_prune: {
    routine: "prune_host_export_outbox, nothing due, a full grace window",
    unit: "buffers",
    budget: 120,
    measured: 56,
    guards: "#8211 index 1597",
  },
  // #8211 (1598): the active-goal check read every active goal in the database.
  hands_back_active_goal: {
    routine: "session_hands_back_v1 for a session without an active goal",
    unit: "buffers",
    budget: 60,
    measured: 28,
    guards: "#8211 index 1598 (session_goals_active_session_idx)",
  },
  // #8214 (1620-1662): policies called owner-only definers for every filtered row.
  rls_owner_definer_calls: {
    routine:
      "owner-only policy definer calls of a runtime-role scan past another tenant's sessions",
    unit: "calls",
    budget: 3,
    measured: 0,
    guards: "#8214 (inline owner test before owner-only capability definers)",
  },
  rls_policy_heavy_read: {
    routine: "runtime-role count(*) of sessions past another tenant's sessions",
    unit: "buffers",
    budget: 570,
    measured: 284,
    guards: "#8214",
  },
  // #8215 (1663-1668): the terminal insert re-summed every usage row of the turn.
  terminal_usage_insert: {
    routine: "terminal turn event insert for a turn with thousands of model calls",
    unit: "buffers",
    budget: 220,
    measured: 107,
    guards: "#8215 migrations 1663-1668 (session_turn_credit_totals)",
  },
  // #8221 (1670): planned an 8-way catalog join on each of a connection's first calls.
  editable_artifact_schema_resolver: {
    routine: "resolve_editable_artifact_data_schema, steady state",
    unit: "buffers",
    budget: 40,
    measured: 20,
    guards: "#8221 migration 1670",
  },
  // #8221/#8223/#8226 (1671-1693): replanned on every call; owner RLS claims.
  wake_inventory_child_terminal: {
    routine: "list_pending_child_terminal_wake_repairs_v1(100), steady state",
    unit: "buffers",
    budget: 30,
    measured: 13,
    guards: "#8221 1671, #8223 1672-1677, #8226 1681-1693",
  },
  wake_inventory_quiescence: {
    routine: "list_quiescence_receipt_wake_repairs_v1(100), steady state",
    unit: "buffers",
    budget: 30,
    measured: 13,
    guards: "#8221 1671, #8223 1672-1677, #8226 1681-1693",
  },
  // #8243 (1696 + the lookup split): 184k buffers / 310 ms per call in production.
  lost_provider_session_lookup: {
    routine: "the lost-provider settlement's retained-process session lookup",
    unit: "buffers",
    budget: 130,
    measured: 62,
    guards: "#8243 index 1696 and the owner-arm split of the lookup",
  },
} as const satisfies Record<string, PerfBudget>;

export type PerfBudgetId = keyof typeof PERF_BUDGETS;

/** The failure text: routine, measurement, budget, fixture, and how to update. */
export function perfBudgetFailure(id: PerfBudgetId, measured: number, fixture: string): string {
  const entry: PerfBudget = PERF_BUDGETS[id];
  return [
    `Performance budget exceeded: ${id}`,
    `  routine:  ${entry.routine}`,
    `  measured: ${measured} ${entry.unit} (budget ${entry.budget}; ${entry.measured} when the budget was set)`,
    `  fixture:  ${fixture}`,
    `  guards:   ${entry.guards}`,
    `This routine now does more work on the same data. If that is a regression, fix it.`,
    `If the increase is intended, update the budget deliberately (${PERF_BUDGET_DOC}).`,
  ].join("\n");
}
