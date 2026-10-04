import { expect, test } from "bun:test";
import { z } from "zod";
import { callSpec, computeOracle, fixtureId, sessionSpec } from "./oracle";
import {
  assertOrganizationLedger,
  assertLegacyCacheWire,
  compareMeasurements,
  computeWorkspaceOracle,
  assertWorkspaceCreditFields,
} from "./assertions";
import {
  assertBenchmarkClusterName,
  classifyInsightsSql,
  sanitizeEvidence,
  summarizeExplain,
} from "./auth";
import { attestRetainedMigrationEdit, type Fixture } from "./seed";

test("fixture preflight rejects other local clusters before mutation", () => {
  expect(() => assertBenchmarkClusterName("opengeni-bench2768")).not.toThrow();
  for (const name of [undefined, null, "", "opengeni-dev", "opengeni-bench2768-other"]) {
    expect(() => assertBenchmarkClusterName(name)).toThrow("dedicated opengeni-bench2768 cluster");
  }
});

test("price-card calls and charging are independent of analytical helpers", () => {
  expect(callSpec(0).chargedMicros).toBe(101);
  expect(callSpec(72).payer).toBe("subscription");
  expect(callSpec(144).payer).toBe("own_key");
  expect(callSpec(72).chargedMicros).toBe(0);
  expect(callSpec(0).estimatedProviderMicros).toBeNull();
  expect(callSpec(0).ledgerPresent).toBe(false);
  expect(callSpec(0).missingSession).toBe(true);
  expect(callSpec(1).totalTokens).toBe(112);
});

test("capture distinguishes complete amount readers and legacy rolling helpers", () => {
  expect(
    classifyInsightsSql("select * from opengeni_private.workspace_insights_amount_fact_rows(1)"),
  ).toBe("workspace_model_bundle");
  expect(
    classifyInsightsSql(
      "select * from opengeni_private.visible_workspace_insights_model_fact_rows(1)",
    ),
  ).toBe("workspace_model_bundle");
  expect(
    classifyInsightsSql(
      "select * from opengeni_private.complete_workspace_insights_usage_projection(1)",
    ),
  ).toBe("workspace_usage_bundle");
  expect(
    classifyInsightsSql("select * from opengeni_private.organization_private_chat_usage(1)"),
  ).toBe("organization_private_chats");
});
test("legacy cache wire keeps numeric aggregate zero but nullable raw call data", () => {
  const snapshot = {
    models: [{ cachedTokens: 0, cacheInputTokens: 0, cacheWriteTokens: 0 }],
    series: [],
    recentCalls: [{ cachedTokens: null, cacheWriteTokens: null }],
  };
  expect(assertLegacyCacheWire(snapshot).every((r) => r.ok)).toBe(true);
  expect(
    assertLegacyCacheWire({
      ...snapshot,
      models: [{ cachedTokens: null, cacheInputTokens: 0, cacheWriteTokens: 0 }],
    }).some((r) => !r.ok),
  ).toBe(true);
});

test("evidence exports preserve measurements but cannot replay auth or environment credentials", () => {
  const raw = {
    durationMs: 123,
    fixtureAdminRole: "fixture-maintenance",
    sql: "select real_production_function($1)",
    parameters: ["synthetic-workspace"],
    setup: [
      {
        sql: "select set_config($1,$2,true)",
        parameters: ["signedContext", "actor-signed-fixture"],
      },
    ],
    note: "postgres://local-user:fixture-password@127.0.0.1/db credential-long-value",
  };
  const safe = sanitizeEvidence(raw, ["credential-long-value"]);
  expect(safe.durationMs).toBe(123);
  expect(safe.parameters).toEqual(raw.parameters);
  expect(JSON.stringify(safe)).not.toContain("actor-signed-fixture");
  expect(JSON.stringify(safe)).not.toContain("fixture-password");
  expect(JSON.stringify(safe)).not.toContain("credential-long-value");
  expect(raw.setup[0]!.parameters[1]).toBe("actor-signed-fixture");
});

test("nested plan summary parses actual auto_explain JSON without dropping row and buffer proof", () => {
  const nested = {
    "Query Text": "WITH actual_facts AS MATERIALIZED (...) SELECT ...",
    Settings: { work_mem: "64MB" },
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "usage_events",
      "Actual Rows": 4_000_005,
      "Actual Loops": 1,
      "Shared Read Blocks": 123,
    },
  };
  const summary = summarizeExplain({
    nestedPlans: [{ message: `duration: 345.678 ms  plan:\n${JSON.stringify(nested)}` }],
  });
  expect(summary.nested[0].durationMs).toBe(345.678);
  expect(summary.nested[0].hotNodes[0].rows).toBe(4_000_005);
  expect(summary.nested[0].hotNodes[0].sharedRead).toBe(123);
});
test("comparison flags strict greater-than20percent and retains production failures separately", () => {
  const row = (name: string, durationMs: number, outcome = "completed") => ({
    name,
    durationMs,
    outcome,
  });
  const compared = compareMeasurements(
    [row("fast", 100), row("slow", 100), row("timeout", 10000, "failed")],
    [row("fast", 120), row("slow", 121), row("timeout", 9000), row("new", 2)],
  );
  expect(compared.find((r) => r.name === "fast")!.regressionOver20Percent).toBe(false);
  expect(compared.find((r) => r.name === "slow")!.regressionOver20Percent).toBe(true);
  expect(compared.find((r) => r.name === "timeout")!.comparable).toBe(false);
  expect(compared.find((r) => r.name === "timeout")!.baselineFailures).toBe(1);
  expect(compared.find((r) => r.name === "new")!.newScope).toBe(true);
});
test("tree ownership includes hidden descendants of shared roots", () => {
  expect(sessionSpec(264).privateSession).toBe(false);
  expect(sessionSpec(266).privateSession).toBe(true);
  expect(sessionSpec(266).rootId).toBe(sessionSpec(264).id);
  expect(sessionSpec(266).ownerIndex).toBe(67);
  expect(fixtureId("session", 8)).toMatch(/^[a-f0-9-]{36}$/);
  expect(z.string().uuid().safeParse(fixtureId("session", 8)).success).toBe(true);
  expect(z.string().uuid().safeParse(fixtureId("workspace-b", 0)).success).toBe(true);
});
test("approved root/session drilldowns exclude hidden facts while unscoped amounts remain complete", () => {
  const all = computeWorkspaceOracle(24_000, "ytd");
  const root = computeWorkspaceOracle(24_000, "ytd", { rootSessionId: fixtureId("session", 264) });
  const completeRoot = computeOracle(24_000, {
    workspaceKey: "shared-a",
    rootSessionId: fixtureId("session", 264),
  });
  expect(root.totals.calls).toBe(3);
  expect(completeRoot.totals.calls).toBe(4);
  expect(all.totals.calls).toBeGreaterThan(
    computeOracle(24_000, { workspaceKey: "shared-a", visibleOnly: true }).totals.calls,
  );
  expect(
    computeWorkspaceOracle(24_000, "ytd", { sessionId: fixtureId("session", 266) }).totals.calls,
  ).toBe(0);
});
test("released workspace credit fields each use their own independent oracle", () => {
  const oracle = computeWorkspaceOracle(24_000, "ytd");
  const snapshot = {
    creditUsd: oracle.totals.creditMicros / 1e6,
    workspaceCreditUsd: oracle.totals.ledgerMicros / 1e6,
  };
  expect(
    assertWorkspaceCreditFields(snapshot, oracle.totals, oracle.totals).every((row) => row.ok),
  ).toBe(true);
  expect(
    assertWorkspaceCreditFields(
      { ...snapshot, workspaceCreditUsd: snapshot.creditUsd },
      oracle.totals,
      oracle.totals,
    ).some((row) => !row.ok),
  ).toBe(true);
});
test("retained migration attestation permits only explicit payer edit with forward repair", () => {
  const before =
    "WHEN provider IN ('codex-subscription', 'supergrok-subscription') THEN 'subscription'";
  const after =
    "WHEN provider IN ('codex-subscription', 'supergrok-subscription',\n            'workspace-claude-subscription', 'organization-claude-subscription') THEN 'subscription'";
  const additions = ["0592_insights_claude_subscription_payers.sql"];
  expect(
    attestRetainedMigrationEdit(
      "0590_complete_insights_usage_amounts.sql",
      before,
      after,
      additions,
    ).forwardRepair,
  ).toBe(additions[0]!);
  expect(() =>
    attestRetainedMigrationEdit("0590_complete_insights_usage_amounts.sql", before, after, []),
  ).toThrow();
  expect(() =>
    attestRetainedMigrationEdit(
      "0590_complete_insights_usage_amounts.sql",
      before,
      after + " GRANT",
      additions,
    ),
  ).toThrow();
  expect(() =>
    attestRetainedMigrationEdit(
      "0591_insights_aggregate_query_plans.sql",
      before,
      after,
      additions,
    ),
  ).toThrow();
});
test("oracle conserves all three payer totals but charge/fact amounts intentionally differ", () => {
  const oracle = computeOracle(432);
  expect(Object.values(oracle.payers).reduce((n, r) => n + r.calls, 0)).toBe(oracle.totals.calls);
  expect(oracle.payers.subscription.creditMicros).toBe(0);
  expect(oracle.payers.own_key.creditMicros).toBe(0);
  expect(oracle.totals.ledgerMicros).not.toBe(oracle.totals.creditMicros);
  expect(oracle.creditDebits).toBe(oracle.totals.ledgerMicros);
  expect(oracle.costEvents + oracle.tokensEvents).toBe(432 * 2 - 1 + 205);
});

test("millions-call oracle exercises the private-owner cap in one shared workspace", () => {
  const oracle = computeOracle(2_000_000, { workspaceKey: "shared-a" });
  expect(oracle.privateOwners.length).toBeGreaterThan(200);
  expect(oracle.payers.opengeni_credits.calls).toBeGreaterThan(0);
  expect(oracle.payers.subscription.calls).toBeGreaterThan(0);
  expect(oracle.payers.own_key.calls).toBeGreaterThan(0);
  expect(oracle.totals.estimatedProviderKnownCalls).toBeLessThan(oracle.totals.calls);
  expect(oracle.privateLedger.length).toBeGreaterThan(200);
  expect(oracle.privateLedger.every((row) => row.ownerIndex !== 0)).toBe(true);
});

test("prepared org-private assertions bind independent charges to workspace/member and enforce cost order", () => {
  const fixture: Fixture = {
    version: "2768-v2",
    calls: 24_000,
    accountId: fixtureId("account", 0),
    workspaceA: fixtureId("workspace-a", 0),
    workspaceB: fixtureId("workspace-b", 0),
    actorSubjectId: "user:bench2768-person-0",
    templateSessionId: fixtureId("template", 0),
  };
  const oracle = computeOracle(fixture.calls);
  const result = {
    totals: [
      {
        eventType: "model.cost",
        unit: "usd_micros",
        quantity: String(oracle.totals.ledgerMicros),
        eventCount: String(oracle.costEvents),
      },
    ],
    privateChatsTruncated: oracle.privateLedger.length > 200,
    privateChats: oracle.privateLedger.slice(0, 200).map((r) => ({
      workspaceId: r.workspaceKey === "shared-a" ? fixture.workspaceA : fixture.workspaceB,
      membershipId: fixtureId("member", r.ownerIndex),
      name: null,
      totals: [{ eventType: "model.cost", unit: "usd_micros", quantity: String(r.creditMicros) }],
    })),
  };
  expect(assertOrganizationLedger(result, fixture, "ytd").every((r) => r.ok)).toBe(true);
  result.privateChats[0]!.membershipId = fixtureId("member", 0);
  expect(assertOrganizationLedger(result, fixture, "ytd").some((r) => !r.ok)).toBe(true);
});
