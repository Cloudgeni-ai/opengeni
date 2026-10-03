import { createHash } from "node:crypto";

export const FIXTURE_VERSION = "2768-v2";
export const NOW = new Date("2026-09-14T12:00:00.000Z");
export const SESSION_COUNT = 24_000;
export const OWNER_COUNT = 205;
export const MODEL_COUNT = 72;
export const DEFAULT_CALLS = 2_000_000;
export const START_MS = Date.parse("2026-01-01T00:00:00Z");
export const DAY_MS = 86_400_000;
export const PAYERS = ["opengeni_credits", "subscription", "own_key"] as const;
export type Payer = (typeof PAYERS)[number];

export function fixtureId(kind: string, index: number): string {
  const hex = createHash("md5").update(`${FIXTURE_VERSION}:${kind}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function subject(index: number): string {
  return `user:bench2768-person-${index}`;
}

const sessionCache = new Map<number, ReturnType<typeof uncachedSessionSpec>>();
function uncachedSessionSpec(index: number) {
  const group = Math.floor(index / 4);
  const rootIndex = group * 4;
  const isolatedPrivateChild =
    index % 4 === 2 && group % 11 === 0 && group % 3 !== 1 && group % 17 !== 0;
  const ownerIndex = (group + Number(isolatedPrivateChild)) % OWNER_COUNT;
  const personal = group % 17 === 0;
  const workspaceKey = personal
    ? `personal:${ownerIndex}`
    : group % 17 === 1
      ? "shared-b"
      : "shared-a";
  const privateSession = personal || group % 3 === 1 || (index % 4 === 2 && group % 11 === 0);
  return {
    index,
    group,
    rootIndex,
    ownerIndex,
    personal,
    workspaceKey,
    privateSession,
    id: fixtureId("session", index),
    rootId: fixtureId("session", rootIndex),
    ownerSubjectId: subject(ownerIndex),
  };
}

export function sessionSpec(index: number) {
  let value = sessionCache.get(index);
  if (!value) {
    value = uncachedSessionSpec(index);
    sessionCache.set(index, value);
  }
  return value;
}

/** Specification of original calls, not a SELECT from any analytical or billing table. */
export function callSpec(index: number) {
  const session = sessionSpec(index % SESSION_COUNT);
  const payer = PAYERS[Math.floor(index / MODEL_COUNT) % 3]!;
  const modelIndex = index % MODEL_COUNT;
  const provider =
    payer === "subscription"
      ? modelIndex % 2 === 0
        ? "codex-subscription"
        : "supergrok-subscription"
      : modelIndex % 2 === 0
        ? "openai"
        : "anthropic";
  // A known deterministic price card, independent of production price/aggregate helpers.
  const chargedMicros = payer === "opengeni_credits" ? 101 + (index % 97) : 0;
  const inputTokens = 100 + (index % 901);
  const outputTokens = 10 + (index % 101);
  const estimatedProviderMicros = index % 7 === 0 ? null : 41 + (index % 89);
  const missingSession = index % 9973 === 0;
  const ledgerPresent = index % 10007 !== 0;
  const occurredMs = START_MS + (index % 257) * DAY_MS + (index % 3600) * 1000;
  return {
    index,
    session,
    payer,
    modelIndex,
    model: `bench-model-${modelIndex}`,
    provider,
    chargedMicros,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens: Math.floor(inputTokens / 3),
    estimatedProviderMicros,
    missingSession,
    ledgerPresent,
    occurredMs,
  };
}

export type Totals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheInputTokens: number;
  cacheWriteTokens: number;
  tokenKnownCalls: number;
  cacheKnownCalls: number;
  totalTokens: number;
  creditMicros: number;
  estimatedProviderMicros: number;
  estimatedProviderKnownCalls: number;
  ledgerMicros: number;
  ledgerEvents: number;
};
export function emptyTotals(): Totals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheInputTokens: 0,
    cacheWriteTokens: 0,
    tokenKnownCalls: 0,
    cacheKnownCalls: 0,
    totalTokens: 0,
    creditMicros: 0,
    estimatedProviderMicros: 0,
    estimatedProviderKnownCalls: 0,
    ledgerMicros: 0,
    ledgerEvents: 0,
  };
}

export type OracleFilter = {
  since?: number;
  until?: number;
  workspaceKey?: string;
  provider?: string;
  model?: string;
  rootSessionId?: string;
  sessionId?: string;
  visibleOnly?: boolean;
  actorIndex?: number;
};

/** Executable independent oracle: iterate the original price-card schedule in JS. */
export function computeOracle(calls: number, filter: OracleFilter = {}) {
  const totals = emptyTotals();
  const payers = Object.fromEntries(PAYERS.map((payer) => [payer, emptyTotals()])) as Record<
    Payer,
    Totals
  >;
  const privateOwners = new Map<number, Totals>();
  const privateLedger = new Map<
    string,
    { workspaceKey: string; ownerIndex: number; creditMicros: number; tokens: number }
  >();
  let missingSessions = 0;
  let missingLedger = 0;
  let creditDebits = 0;
  let costEvents = 0;
  let tokensEvents = 0;
  for (let index = 0; index < calls; index++) {
    const c = callSpec(index);
    if (
      c.occurredMs < (filter.since ?? START_MS) ||
      c.occurredMs >= (filter.until ?? NOW.getTime())
    )
      continue;
    if (filter.workspaceKey && c.session.workspaceKey !== filter.workspaceKey) continue;
    if (filter.provider && c.provider !== filter.provider) continue;
    if (filter.model && c.model !== filter.model) continue;
    if (filter.rootSessionId && (c.missingSession || c.session.rootId !== filter.rootSessionId))
      continue;
    if (filter.sessionId && (c.missingSession || c.session.id !== filter.sessionId)) continue;
    const hidden =
      c.missingSession ||
      (c.session.privateSession && c.session.ownerIndex !== (filter.actorIndex ?? 0));
    if (filter.visibleOnly && hidden) continue;
    missingSessions += Number(c.missingSession);
    missingLedger += Number(!c.ledgerPresent);
    creditDebits += c.ledgerPresent ? c.chargedMicros : 0;
    costEvents += Number(c.ledgerPresent);
    tokensEvents++;
    const ownerTotals =
      !c.missingSession && hidden && !c.session.personal
        ? (privateOwners.get(c.session.ownerIndex) ?? emptyTotals())
        : null;
    for (const row of [totals, payers[c.payer], ...(ownerTotals ? [ownerTotals] : [])]) {
      row.calls++;
      row.inputTokens += c.inputTokens;
      row.outputTokens += c.outputTokens;
      row.cachedTokens += c.cachedTokens;
      row.cacheInputTokens += c.inputTokens;
      // Source cache-write value is unknown/null: released v1 sums it as zero.
      row.cacheWriteTokens += 0;
      row.tokenKnownCalls++;
      row.cacheKnownCalls++;
      row.totalTokens += c.totalTokens;
      row.creditMicros += c.chargedMicros;
      row.estimatedProviderMicros += c.estimatedProviderMicros ?? 0;
      row.estimatedProviderKnownCalls += Number(c.estimatedProviderMicros !== null);
      row.ledgerMicros += c.ledgerPresent ? c.chargedMicros : 0;
      row.ledgerEvents += Number(c.ledgerPresent);
    }
    if (ownerTotals) privateOwners.set(c.session.ownerIndex, ownerTotals);
    if (ownerTotals) {
      const key = `${c.session.workspaceKey}:${c.session.ownerIndex}`;
      const row = privateLedger.get(key) ?? {
        workspaceKey: c.session.workspaceKey,
        ownerIndex: c.session.ownerIndex,
        creditMicros: 0,
        tokens: 0,
      };
      row.creditMicros += c.ledgerPresent ? c.chargedMicros : 0;
      row.tokens += c.totalTokens;
      privateLedger.set(key, row);
    }
  }
  // Ledger-only charges with no model fact: known missing-fact reconciliation case.
  const ledgerOnlyAt = Date.parse("2026-09-14T03:00:00Z");
  if (
    !filter.provider &&
    !filter.model &&
    !filter.rootSessionId &&
    !filter.sessionId &&
    (!filter.workspaceKey || filter.workspaceKey === "shared-a") &&
    ledgerOnlyAt >= (filter.since ?? START_MS) &&
    ledgerOnlyAt < (filter.until ?? NOW.getTime())
  ) {
    totals.ledgerMicros += 205 * 17;
    totals.ledgerEvents += 205;
    creditDebits += 205 * 17;
    costEvents += 205;
  }
  return {
    totals,
    payers,
    creditDebits,
    costEvents,
    tokensEvents,
    missingSessions,
    missingLedger,
    privateLedger: [...privateLedger.values()].sort(
      (a, b) => b.creditMicros - a.creditMicros || b.tokens - a.tokens,
    ),
    privateOwners: [...privateOwners]
      .map(([ownerIndex, amount]) => ({ ownerIndex, ...amount }))
      .sort((a, b) => b.totalTokens - a.totalTokens || a.ownerIndex - b.ownerIndex),
  };
}
