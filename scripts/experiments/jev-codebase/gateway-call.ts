import { hash } from "./core";
import { budgetState, transientStatus, type LedgerRow } from "./iteration-ledger";
import { safeGatewayError } from "./gateway-diagnostics";
import { nonnegativeAmount } from "./trajectory";
import { journaledTransientFailure } from "./transient-failure";

export interface CallOptions {
  model: string;
  stage: string;
  runId: string;
  attribution: LedgerRow;
  price: { input: number; output: number; cached: number };
  maxUsd: number;
  maxRequests: number;
  maxOutput: number;
  retries: number;
  passBudget?: {
    baselineAttempts: number;
    baselineUsd: number;
    maxAdditionalAttempts: number;
    maxAdditionalUsd: number;
  };
  costPolicy?: "reported" | "typesafe_catalog";
  retryDelayMs?: number;
  secret?: string;
  history: () => LedgerRow[];
  append: (row: LedgerRow) => void;
  onStart?: (id: string) => void;
}

/** Each attempt is independently reserved and journaled; no implicit SDK retries. */
export async function meteredGatewayCall(
  options: CallOptions,
  payload: unknown,
  invoke: () => Promise<any>,
): Promise<any> {
  const o = options;
  if (o.costPolicy === "typesafe_catalog" && o.model !== "jev-1.13.0")
    throw new Error("invalid_catalog_cost_policy");
  const serialized = JSON.stringify(payload),
    bytes = Buffer.byteLength(serialized);
  const history = o.history();
  for (const failure of history.filter((r) => r.kind === "failed" && r.statusCode === 400)) {
    const original = history.find((r) => r.kind === "started" && r.id === failure.id);
    if (original?.payloadHash === hash(serialized))
      throw new Error("unchanged_bad_request_payload");
  }
  if (bytes > 180000) throw new Error("request_size_budget");
  const reservedUsd =
    (o.costPolicy === "typesafe_catalog" ? Math.max(64000, bytes + 8192) : bytes + 8192) *
      o.price.input +
    o.maxOutput * o.price.output;
  for (let attempt = 0; ; attempt++) {
    const budget = budgetState(o.history());
    if (o.passBudget) {
      const b = o.passBudget;
      if (budget.attempts < b.baselineAttempts || budget.used + 1e-9 < b.baselineUsd)
        throw new Error("pass_baseline_missing");
      if (
        budget.attempts - b.baselineAttempts >= b.maxAdditionalAttempts ||
        budget.used - b.baselineUsd + reservedUsd > b.maxAdditionalUsd
      )
        throw new Error("pass_budget_exhausted");
    }
    if (budget.attempts >= o.maxRequests || budget.used + reservedUsd > o.maxUsd)
      throw new Error("experiment_budget_exhausted");
    const base = {
      ...o.attribution,
      runId: o.runId,
      id: crypto.randomUUID(),
      stage: o.stage,
      attempt,
      model: o.model,
      timestamp: new Date().toISOString(),
      payloadHash: hash(serialized),
      payloadBytes: bytes,
    };
    o.append({ ...base, kind: "started", reservedUsd });
    const start = performance.now();
    try {
      o.onStart?.(base.id);
      const r = await invoke();
      const inputTokens = r.usage?.inputTokens,
        outputTokens = r.usage?.outputTokens;
      const cachedTokens = r.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
      if (
        ![inputTokens, outputTokens, cachedTokens].every((n) => Number.isFinite(n) && n >= 0) ||
        cachedTokens > inputTokens
      )
        throw new Error("invalid_usage");
      let reportedUsd: number | null = null;
      try {
        reportedUsd = nonnegativeAmount(r.providerMetadata?.gateway?.cost);
      } catch {
        /* retain known usage */
      }
      const nominalUsd =
        (inputTokens - cachedTokens) * o.price.input +
        cachedTokens * o.price.cached +
        outputTokens * o.price.output;
      o.append({
        ...base,
        kind: "completed",
        elapsedMs: performance.now() - start,
        inputTokens,
        outputTokens,
        cachedTokens,
        reasoningTokens: r.usage.outputTokenDetails?.reasoningTokens ?? null,
        usage: r.usage,
        nominalUsd,
        reportedUsd,
        resolvedModel: r.response?.modelId,
        generationId: r.providerMetadata?.gateway?.generationId,
        nativeRequestId: r.providerMetadata?.typesafe?.requestId,
        costBasis:
          o.costPolicy === "typesafe_catalog"
            ? "catalog_estimate_not_invoice"
            : "reported_and_catalog",
        finishReason: r.finishReason ?? null,
      });
      if (reportedUsd === null && o.costPolicy !== "typesafe_catalog")
        throw new Error("cost_unavailable");
      if (Math.max(nominalUsd, reportedUsd ?? 0) > reservedUsd)
        throw new Error("reservation_exceeded");
      return r;
    } catch (error) {
      const diagnostics = safeGatewayError(error, o.secret);
      o.append({
        ...base,
        kind: "failed",
        elapsedMs: performance.now() - start,
        errorName: diagnostics.name ?? "unknown",
        statusCode: diagnostics.statusCode,
        billingUnknown: true,
        diagnostics,
      });
      if (!transientStatus(diagnostics.statusCode))
        throw new Error("provider_or_usage_failure", { cause: error });
      o.append({
        kind: "transient_reserved",
        failedId: base.id,
        reservedUsd,
        timestamp: new Date().toISOString(),
        statusCode: diagnostics.statusCode,
      });
      if (attempt >= o.retries) throw journaledTransientFailure(base.id, o.history(), error);
      await Bun.sleep(o.retryDelayMs ?? 1000);
    }
  }
}
