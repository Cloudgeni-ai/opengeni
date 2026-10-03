import type { Fixture } from "./seed";
import {
  NOW,
  START_MS,
  computeOracle,
  subject,
  sessionSpec,
  fixtureId,
  SESSION_COUNT,
  type OracleFilter,
  type Totals,
} from "./oracle";

export type Assertion = { name: string; ok: boolean; expected?: unknown; actual?: unknown };
type Json = Record<string, any>;
const fields = [
  "calls",
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "cacheInputTokens",
  "cacheWriteTokens",
  "tokenKnownCalls",
  "cacheKnownCalls",
  "totalTokens",
  "creditMicros",
  "estimatedProviderMicros",
  "estimatedProviderKnownCalls",
] as const;
export function windowSince(period: string): number {
  return period === "today"
    ? Date.parse("2026-09-14T00:00:00Z")
    : period === "week"
      ? Date.parse("2026-09-08T00:00:00Z")
      : period === "month"
        ? Date.parse("2026-09-01T00:00:00Z")
        : START_MS;
}
const eq = (name: string, actual: unknown, expected: unknown): Assertion => ({
  name,
  ok: JSON.stringify(actual) === JSON.stringify(expected),
  expected,
  actual,
});
const sum = (rows: Json[], key: string) => rows.reduce((n, r) => n + Number(r[key] ?? 0), 0);

/** V1 aggregate cache quantities are numeric (unknown contributors coalesce to
 * zero); raw per-call cache values remain nullable. Do not silently adopt the
 * deferred nullable aggregate-cache contract in this benchmark. */
export function assertLegacyCacheWire(snapshot: Json): Assertion[] {
  const numeric = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return [
    ...["models", "series"].map((key) =>
      eq(
        `v1 ${key} cache amounts stay numeric`,
        (snapshot[key] ?? []).every((row: Json) =>
          ["cachedTokens", "cacheInputTokens", "cacheWriteTokens"].every((field) =>
            numeric(row[field]),
          ),
        ),
        true,
      ),
    ),
    eq(
      "v1 raw recent-call cache remains numeric or null",
      (snapshot.recentCalls ?? []).every((row: Json) =>
        ["cachedTokens", "cacheWriteTokens"].every(
          (field) => row[field] === null || numeric(row[field]),
        ),
      ),
      true,
    ),
  ];
}

export function compareMeasurements(baseline: Json[], current: Json[]) {
  const median = (rows: Json[]) => {
    const values = rows
      .filter((r) => r.outcome === "completed")
      .map((r) => Number(r.durationMs))
      .sort((a, b) => a - b);
    if (!values.length) return null;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  };
  return [...new Set(current.map((r) => String(r.name)))].sort().map((name) => {
    const before = baseline.filter((r) => r.name === name);
    const after = current.filter((r) => r.name === name);
    const baselineMs = median(before),
      currentMs = median(after);
    return {
      name,
      baselineMs,
      currentMs,
      deltaPercent: baselineMs && currentMs != null ? (currentMs / baselineMs - 1) * 100 : null,
      regressionOver20Percent:
        baselineMs != null && currentMs != null && currentMs > baselineMs * 1.2,
      baselineFailures: before.filter((r) => r.outcome !== "completed").length,
      currentFailures: after.filter((r) => r.outcome !== "completed").length,
      comparable: baselineMs != null && currentMs != null,
      newScope: before.length === 0,
    };
  });
}

export function assertOrganizationModels(
  result: Json,
  fixture: Fixture,
  period: string,
): Assertion[] {
  const oracle = computeOracle(fixture.calls, { since: windowSince(period) });
  const checks = [
    eq("models are capped independently of payer totals", result.models.length, 50),
    eq("model cap is disclosed", result.modelsTruncated, true),
    eq("three uncapped payer groups", (result.payers ?? []).map((r: Json) => r.payer).sort(), [
      "opengeni_credits",
      "own_key",
      "subscription",
    ]),
  ];
  for (const field of fields)
    checks.push(
      eq(`organization all-fact ${field}`, sum(result.billing, field), oracle.totals[field]),
    );
  for (const [payer, totals] of Object.entries(oracle.payers)) {
    const actual = result.payers?.find((r: Json) => r.payer === payer);
    for (const field of fields)
      checks.push(
        eq(`payer ${payer} ${field}`, Number(actual?.[field] ?? -1), totals[field as keyof Totals]),
      );
    checks.push(eq(`payer ${payer} has no billingPath`, actual && "billingPath" in actual, false));
    checks.push(
      eq(
        `payer ${payer} exact v1 totals shape`,
        actual ? Object.keys(actual).sort() : [],
        ["payer", ...fields].sort(),
      ),
    );
  }
  return checks;
}

export function assertOrganizationLedger(
  result: Json,
  fixture: Fixture,
  period: string,
): Assertion[] {
  const oracle = computeOracle(fixture.calls, { since: windowSince(period) });
  const cost = result.totals.find(
    (r: Json) => r.eventType === "model.cost" && r.unit === "usd_micros",
  );
  const privateChats = result.privateChats ?? [];
  const expectedPrivate = oracle.privateLedger.slice(0, 200);
  const privateCost = (r: Json) =>
    Number(
      r.totals?.find((t: Json) => t.eventType === "model.cost" && t.unit === "usd_micros")
        ?.quantity ?? 0,
    );
  return [
    eq(
      "organization charged total includes hidden and missing-session usage",
      Number(cost?.quantity ?? 0),
      oracle.totals.ledgerMicros,
    ),
    eq(
      "organization charged event count is not fact count",
      Number(cost?.eventCount ?? 0),
      oracle.costEvents,
    ),
    eq("organization privateChats default array", Array.isArray(result.privateChats), true),
    eq("organization privateChats cap disclosed", typeof result.privateChatsTruncated, "boolean"),
    eq("organization privateChats bounded", (result.privateChats?.length ?? 0) <= 200, true),
    eq(
      "organization privateChats exact prepared count",
      privateChats.length,
      expectedPrivate.length,
    ),
    eq(
      "organization privateChats truncation matches independent groups",
      result.privateChatsTruncated,
      oracle.privateLedger.length > 200,
    ),
    eq(
      "organization privateChats cost descending",
      privateChats.every(
        (r: Json, i: number) => !i || privateCost(privateChats[i - 1]) >= privateCost(r),
      ),
      true,
    ),
    eq(
      "organization privateChats approved shape",
      privateChats.every(
        (r: Json) =>
          Object.keys(r).sort().join(",") ===
          ["workspaceId", "membershipId", "name", "totals"].sort().join(","),
      ),
      true,
    ),
    eq(
      "organization privateChats independent amount/member association",
      privateChats
        .map((r: Json) => ({
          workspaceId: r.workspaceId,
          membershipId: r.membershipId,
          creditMicros: privateCost(r),
        }))
        .sort((a: Json, b: Json) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      expectedPrivate
        .map((r) => ({
          workspaceId: r.workspaceKey === "shared-a" ? fixture.workspaceA : fixture.workspaceB,
          membershipId: fixtureId("member", r.ownerIndex),
          creditMicros: r.creditMicros,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ),
    eq(
      "organization privateChats no Personal workspaces",
      (result.privateChats ?? []).every((r: Json) =>
        [fixture.workspaceA, fixture.workspaceB].includes(r.workspaceId),
      ),
      true,
    ),
    eq(
      "organization privateChats does not include caller",
      (result.privateChats ?? []).every((r: Json) => r.name !== "Benchmark Person 0"),
      true,
    ),
  ];
}

export function computeWorkspaceOracle(calls: number, period: string, filter: OracleFilter = {}) {
  return computeOracle(calls, {
    since: windowSince(period),
    workspaceKey: "shared-a",
    ...filter,
    // Explicit lead ruling: root/session drilldowns retain ordinary visibility.
    visibleOnly: Boolean(filter.rootSessionId || filter.sessionId || filter.visibleOnly),
  });
}

export function assertWorkspaceCreditFields(
  snapshot: Json,
  model: Totals,
  ledger: Totals,
): Assertion[] {
  return [
    eq(
      "workspace legacy model credit uses fact oracle",
      Math.round(snapshot.creditUsd * 1e6),
      model.creditMicros,
    ),
    eq(
      "workspace authoritative charge uses independent ledger oracle",
      Math.round(snapshot.workspaceCreditUsd * 1e6),
      ledger.ledgerMicros,
    ),
  ];
}

export function assertWorkspace(
  result: Json,
  fixture: Fixture,
  period: string,
  filter: OracleFilter = {},
): Assertion[] {
  const snapshot = result.snapshot;
  const oracle = computeWorkspaceOracle(fixture.calls, period, filter);
  const checks = [
    eq("workspace modelCalls includes hidden facts", snapshot.modelCalls, oracle.totals.calls),
    eq("workspace models conserve calls", sum(snapshot.models, "calls"), oracle.totals.calls),
    eq(
      "workspace models conserve tokens",
      sum(snapshot.models, "totalTokens"),
      oracle.totals.totalTokens,
    ),
    eq(
      "workspace estimated pricing known-call denominator",
      snapshot.estimatedProviderCostKnownCalls,
      oracle.totals.estimatedProviderKnownCalls,
    ),
    eq(
      "workspace estimated provider USD",
      Math.round(snapshot.estimatedProviderUsd * 1e6),
      oracle.totals.estimatedProviderMicros,
    ),
    eq("workspace privateChats defaults to array", Array.isArray(snapshot.privateChats), true),
    eq("workspace privateChats bounded", (snapshot.privateChats?.length ?? 0) <= 200, true),
    ...assertLegacyCacheWire(snapshot),
    eq(
      "workspace legacy cached-token total",
      sum(snapshot.models, "cachedTokens"),
      oracle.totals.cachedTokens,
    ),
    eq(
      "workspace legacy cache-input total",
      sum(snapshot.models, "cacheInputTokens"),
      oracle.totals.cacheInputTokens,
    ),
    eq(
      "workspace legacy unknown cache-write aggregates stay zero",
      sum(snapshot.models, "cacheWriteTokens"),
      oracle.totals.cacheWriteTokens,
    ),
  ];
  // These released fields are intentionally distinct. The usage bundle stays
  // workspace-wide even when the model drilldown is narrowed.
  const scoped = Boolean(
    filter.provider || filter.model || filter.rootSessionId || filter.sessionId,
  );
  const ledgerOracle = scoped ? computeWorkspaceOracle(fixture.calls, period) : oracle;
  checks.push(...assertWorkspaceCreditFields(snapshot, oracle.totals, ledgerOracle.totals));
  checks.push(
    eq("projects conserve all scoped calls", sum(snapshot.projects, "calls"), oracle.totals.calls),
  );
  checks.push(
    eq(
      "projects conserve all scoped tokens",
      sum(snapshot.projects, "tokens"),
      oracle.totals.totalTokens,
    ),
  );
  checks.push(
    eq("series conserves all scoped calls", sum(snapshot.series, "calls"), oracle.totals.calls),
  );
  const privateChats = snapshot.privateChats ?? [];
  if (filter.rootSessionId || filter.sessionId)
    checks.push(eq("root/session drilldowns suppress privateChats", privateChats, []));
  else {
    const expected = oracle.privateOwners.slice(0, 200);
    const amounts = (rows: Json[]) =>
      rows
        .map((r) => ({
          calls: r.calls,
          tokens: r.tokens,
          creditMicros: Math.round(r.creditUsd * 1e6),
          estimatedMicros: Math.round(r.estimatedProviderUsd * 1e6),
          known: r.estimatedProviderCostKnownCalls,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    checks.push(
      eq(
        "privateChats preserve per-owner amount associations",
        amounts(privateChats),
        amounts(
          expected.map((r) => ({
            calls: r.calls,
            tokens: r.totalTokens,
            creditUsd: r.creditMicros / 1e6,
            estimatedProviderUsd: r.estimatedProviderMicros / 1e6,
            estimatedProviderCostKnownCalls: r.estimatedProviderKnownCalls,
          })),
        ),
      ),
    );
    checks.push(
      eq(
        "privateChats groups hidden SESSION owners",
        privateChats.map((r: Json) => r.tokens).sort((a: number, b: number) => b - a),
        expected.map((r) => r.totalTokens).sort((a, b) => b - a),
      ),
    );
    checks.push(
      eq(
        "privateChats same provider/model filters",
        privateChats.map((r: Json) => r.calls).sort((a: number, b: number) => b - a),
        expected.map((r) => r.calls).sort((a, b) => b - a),
      ),
    );
    checks.push(
      eq(
        "privateChats token descending",
        privateChats.every((r: Json, i: number) => !i || privateChats[i - 1].tokens >= r.tokens),
        true,
      ),
    );
    for (const [actualKey, expectedKey, usd] of [
      ["creditUsd", "creditMicros", true],
      ["estimatedProviderUsd", "estimatedProviderMicros", true],
      ["estimatedProviderCostKnownCalls", "estimatedProviderKnownCalls", false],
    ] as const)
      checks.push(
        eq(
          `privateChats ${actualKey} uses the same scoped owner facts`,
          privateChats
            .map((r: Json) => (usd ? Math.round(r[actualKey] * 1e6) : r[actualKey]))
            .sort((a: number, b: number) => b - a),
          expected.map((r) => r[expectedKey]).sort((a, b) => b - a),
        ),
      );
    checks.push(
      eq(
        "privateChats unique opaque person keys",
        new Set(privateChats.map((r: Json) => r.ownerKey)).size,
        privateChats.length,
      ),
    );
    checks.push(
      eq(
        "privateChats opaque keys do not expose raw subjects",
        privateChats.every(
          (r: Json) =>
            typeof r.ownerKey === "string" &&
            !r.ownerKey.startsWith("user:") &&
            !r.ownerKey.includes(subject(0)),
        ),
        true,
      ),
    );
    checks.push(
      eq(
        "privateChats other people not caller",
        privateChats.every((r: Json) => r.you === false),
        true,
      ),
    );
    checks.push(
      eq(
        "privateChats approved shape",
        privateChats.every(
          (r: Json) =>
            Object.keys(r).sort().join(",") ===
            [
              "ownerKey",
              "name",
              "you",
              "calls",
              "tokens",
              "creditUsd",
              "estimatedProviderUsd",
              "estimatedProviderCostKnownCalls",
            ]
              .sort()
              .join(","),
        ),
        true,
      ),
    );
  }
  const visibleDetails = JSON.stringify({
    drivers: snapshot.drivers,
    recentCalls: snapshot.recentCalls,
    floor: snapshot.floor,
    diagnostics: snapshot.diagnostics,
    warmGroups: snapshot.warmGroups,
    liveWarm: snapshot.liveWarm,
    deepestSessionTitle: snapshot.deepestSessionTitle,
  });
  let hiddenLeak = false;
  for (let i = 0; i < SESSION_COUNT; i++) {
    const s = sessionSpec(i);
    if (
      s.privateSession &&
      s.ownerIndex !== 0 &&
      (visibleDetails.includes(s.id) || visibleDetails.includes(`HIDDEN_BENCH_${i}"`))
    )
      hiddenLeak = true;
  }
  checks.push(
    eq("visible detail never leaks other owners' hidden session identity/title", hiddenLeak, false),
  );
  checks.push(eq("frozen UTC window end", snapshot.windowEnd, NOW.toISOString()));
  return checks;
}
