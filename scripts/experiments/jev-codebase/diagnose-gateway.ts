import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";
import { loadSnapshot, validateAnswers, type Judgment } from "./core";
import { investigateCompact } from "./compact-investigation";
import { batchedJudge } from "./batched-judge";
import { budgetState } from "./iteration-ledger";
import { observedGatewayFetch, diagnosticSignal } from "./gateway-diagnostics";
import { nonnegativeAmount, validateCases } from "./trajectory";
import { meteredGatewayCall } from "./gateway-call";

async function main() {
  if (process.env.JEV_ALLOW_LIVE !== "1") throw new Error("live_opt_in_required");
  const key = process.env.VERCEL_AI_GATEWAY_API_KEY;
  if (!key) throw new Error("missing_key");
  const profile = process.argv[2] ?? "minimal";
  const option = (name: string) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const required = (name: string) => {
    const value = option(name);
    if (!value) throw new Error(`${name}_required`);
    return value;
  };
  if (!["minimal", "code", "replay", "batches"].includes(profile))
    throw new Error("invalid_profile");
  const runId = required("--out"),
    ledgerPath = required("--ledger");
  const history = () =>
    readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
  const append = (v: unknown) =>
    appendFileSync(ledgerPath, JSON.stringify(v) + "\n", { mode: 0o600 });
  let activeRequestId: string | null = null;
  const gateway = createGateway({
    apiKey: key,
    fetch: observedGatewayFetch((row) =>
      appendFileSync(
        runId + "/transport.jsonl",
        JSON.stringify({ requestId: activeRequestId, ...row }) + "\n",
        { mode: 0o600 },
      ),
    ),
  });
  const catalog: any = await (await fetch("https://ai-gateway.vercel.sh/v1/models")).json();
  const model = catalog.data.find((m: any) => m.id === "typesafe-ai/jev");
  const rate = nonnegativeAmount(model?.pricing?.input);
  if (rate <= 0 || nonnegativeAmount(model?.pricing?.output) !== 0)
    throw new Error("pricing_unverified");
  const credits = await gateway.getCredits();
  if (!(Number(credits.balance) > 0)) throw new Error("credit_unavailable");
  mkdirSync(runId, { recursive: true, mode: 0o700 });
  writeFileSync(
    runId + "/manifest.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        model,
        profile,
        limitRequests: 496,
        limitUsd: 2.13,
        concurrency: 1,
        retries: 0,
        requestTimeoutMs: 30000,
        baseline: budgetState(history()),
        goal: "Capture safe Gateway diagnostics and compare question batching",
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  const invoke = async (payload: any, caseId: string, combined = false, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    try {
      const r = await meteredGatewayCall(
        {
          model: "typesafe-ai/jev",
          stage: "diagnostic_" + profile,
          runId,
          attribution: { caseId, arm: "diagnostic" },
          price: {
            input: rate,
            output: 0,
            cached: nonnegativeAmount(model.pricing.input_cache_read ?? rate),
          },
          maxUsd: 2.13,
          maxRequests: 496,
          maxOutput: 0,
          retries: 0,
          secret: key,
          history,
          append: (row) => {
            append(row);
            if (["completed", "failed"].includes(row.kind))
              appendFileSync(runId + "/results.jsonl", JSON.stringify(row) + "\n", { mode: 0o600 });
          },
          onStart: (id) => {
            activeRequestId = id;
            appendFileSync(runId + "/payloads.jsonl", JSON.stringify({ id, ...payload }) + "\n", {
              mode: 0o600,
            });
          },
        },
        payload,
        () =>
          evaluate({
            model: gateway.evaluationModel("typesafe-ai/jev"),
            ...payload,
            maxRetries: 0,
            abortSignal: diagnosticSignal(signal, combined),
          }),
      );
      signal?.throwIfAborted();
      validateAnswers(payload.questions, r.answers as Record<string, Judgment>);
      appendFileSync(
        runId + "/answers.jsonl",
        JSON.stringify({ id: activeRequestId, answers: r.answers }) + "\n",
        { mode: 0o600 },
      );
      console.log(JSON.stringify({ caseId, ok: true }));
      return r.answers as Record<string, Judgment>;
    } catch (error) {
      if (error instanceof Error && error.message === "transient_provider_unavailable") {
        console.log(JSON.stringify({ caseId, ok: false, error: error.message }));
        throw new Error("diagnostic_transient", { cause: error });
      }
      throw error;
    }
  };
  if (profile === "minimal")
    for (let i = 0; i < 12; i++)
      try {
        await invoke(
          {
            state: { build: "failed", deployed: false },
            questions: {
              next: {
                type: "choice",
                instructions: "Select the next step for this failed build.",
                criteria: {
                  investigate: "Investigate the failed build.",
                  announce: "Announce a successful deployment.",
                  unknown: "Insufficient evidence.",
                },
              },
            },
          },
          `minimal-${i}`,
        );
      } catch (e) {
        if ((e as Error).message !== "diagnostic_transient") throw e;
      }
  if (profile === "code") {
    const snapshot = loadSnapshot(required("--root"), required("--revision"), required("--subdir"));
    const cases = JSON.parse(readFileSync(required("--cases"), "utf8"));
    validateCases(cases);
    for (let repeat = 0; repeat < 3; repeat++)
      for (const c of cases)
        try {
          await investigateCompact(
            snapshot,
            { question: c.question, context: c.context },
            (state, questions, signal) =>
              invoke({ state, questions }, `${c.id}-${repeat}`, false, signal),
          );
        } catch (e) {
          if ((e as Error).message !== "diagnostic_transient") throw e;
        }
  }
  if (profile === "replay") {
    const saved = readFileSync(required("--payloads"), "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    const chosen = required("--payload-ids")
      .split(",")
      .map((id) => {
        const p = saved.find((x) => x.id === id);
        if (!p) throw new Error("payload_not_found");
        return p;
      });
    for (let repeat = 0; repeat < 3; repeat++)
      for (const [i, p] of chosen.entries())
        for (const combined of [false, true])
          try {
            await invoke(
              { state: JSON.parse(JSON.stringify(p.state)), questions: p.questions },
              `replay-${i}-${repeat}-${combined ? "combined" : "direct"}`,
              combined,
            );
          } catch (e) {
            if ((e as Error).message !== "diagnostic_transient") throw e;
          }
  }
  if (profile === "batches") {
    const saved = readFileSync(required("--payloads"), "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    const p = saved.find((x) => x.id === required("--payload-id"));
    if (!p) throw new Error("payload_not_found");
    for (let repeat = 0; repeat < 3; repeat++)
      for (const mode of repeat % 2 ? ["batch", "whole"] : ["whole", "batch"]) {
        let batch = 0;
        try {
          if (mode === "whole")
            await invoke({ state: p.state, questions: p.questions }, `whole-${repeat}`);
          else
            await batchedJudge((state, questions) =>
              invoke({ state, questions }, `batch-${repeat}-${batch++}`),
            )(p.state, p.questions);
        } catch (e) {
          if ((e as Error).message !== "diagnostic_transient") throw e;
        }
      }
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
