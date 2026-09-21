import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";
import { hash, validateAnswers } from "./core";
import { meteredGatewayCall } from "./gateway-call";
import { budgetState } from "./iteration-ledger";
import { observedGatewayFetch } from "./gateway-diagnostics";
import {
  evaluateDirect,
  TYPESAFE_MODEL,
  TYPESAFE_INPUT_RATE,
  listNativeModels,
  assertNativeCredential,
} from "./typesafe-direct";
import { nonnegativeAmount } from "./trajectory";
import { DIRECT_PASS_BUDGET } from "./direct-budget";

async function main() {
  if (process.env.JEV_ALLOW_LIVE !== "1") throw new Error("live_opt_in_required");
  const nativeKey = process.env.JEV_API_KEY,
    gatewayKey = process.env.VERCEL_AI_GATEWAY_API_KEY;
  if (!nativeKey || !gatewayKey) throw new Error("route_key_missing");
  assertNativeCredential(nativeKey, gatewayKey);
  const required = (k: string) => {
    const i = process.argv.indexOf(k);
    if (i < 0 || !process.argv[i + 1]) throw new Error(k + "_required");
    return resolve(process.argv[i + 1]);
  };
  const out = required("--out"),
    ledgerPath = required("--ledger"),
    planPath = required("--plan");
  const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const lines = (p: string) =>
    readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  const append = (p: string, v: unknown) =>
    appendFileSync(p, JSON.stringify(v) + "\n", { mode: 0o600 });
  const plan = json(planPath) as { file: string; id: string; label: string }[];
  if (plan.length !== 4) throw new Error("expected_four_frozen_payloads");
  const payloads = plan.map((p) => {
    const saved = lines(p.file).find((r) => r.id === p.id);
    if (!saved) throw new Error("missing_saved_payload");
    return { label: p.label, payload: { state: saved.state, questions: saved.questions } };
  });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  let requestId: string | null = null;
  const gateway = createGateway({
    apiKey: gatewayKey,
    fetch: observedGatewayFetch((row) => append(out + "/transport.jsonl", { requestId, ...row })),
  });
  const catalog = (await (
    await fetch("https://ai-gateway.vercel.sh/v1/models", { signal: AbortSignal.timeout(30000) })
  ).json()) as any;
  const card = catalog.data.find((r: any) => r.id === "typesafe-ai/jev");
  const price = {
    input: nonnegativeAmount(card?.pricing?.input),
    output: nonnegativeAmount(card?.pricing?.output),
    cached: nonnegativeAmount(card?.pricing?.input_cache_read ?? card?.pricing?.input),
  };
  if (price.output !== 0) throw new Error("unexpected_output_pricing");
  if (!(Number((await gateway.getCredits()).balance) > 0))
    throw new Error("gateway_credit_unavailable");
  const nativeModels = await listNativeModels(nativeKey, gatewayKey);
  const docs = await (
    await fetch("https://docs.typesafe.ai/models.md", { signal: AbortSignal.timeout(30000) })
  ).text();
  if (!docs.includes("jev-1.13.0") || !docs.includes("0.042"))
    throw new Error("native_pricing_reverify_required");
  writeFileSync(out + "/native-models-documentation.txt", docs, { flag: "wx", mode: 0o600 });
  writeFileSync(
    out + "/manifest.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        nativeModels,
        nativeModel: TYPESAFE_MODEL,
        nativeInputRate: TYPESAFE_INPUT_RATE,
        gatewayCard: card,
        baseline: budgetState(lines(ledgerPath)),
        maxRequests: 536,
        maxUsd: 2.28,
        passBudget: DIRECT_PASS_BUDGET,
        concurrency: 1,
        retries: 0,
        timeoutMs: 30000,
        plan,
        payloads: payloads.map((p) => ({
          label: p.label,
          hash: hash(JSON.stringify(p.payload)),
          questions: Object.keys(p.payload.questions).length,
        })),
        protocol:
          "One direct synthetic smoke then two alternating-route repetitions of four unchanged historical payloads. No controller or schema-content changes. Native pinned version versus unverified Gateway upstream version; distinct credentials/accounts may also differ.",
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  const invoke = async (route: "direct" | "gateway", label: string, payload: any) => {
    const t = performance.now();
    try {
      const r = await meteredGatewayCall(
        {
          model: route === "direct" ? TYPESAFE_MODEL : "typesafe-ai/jev",
          stage: "route_probe",
          runId: out,
          attribution: { route, caseId: label, arm: "diagnostic" },
          price:
            route === "direct"
              ? { input: TYPESAFE_INPUT_RATE, output: 0, cached: TYPESAFE_INPUT_RATE }
              : price,
          maxUsd: 2.28,
          passBudget: DIRECT_PASS_BUDGET,
          maxRequests: 536,
          maxOutput: 0,
          retries: 0,
          costPolicy: route === "direct" ? "typesafe_catalog" : "reported",
          secret: route === "direct" ? nativeKey : gatewayKey,
          history: () => lines(ledgerPath),
          append: (row) => append(ledgerPath, row),
          onStart: (id) => {
            requestId = id;
            append(out + "/payloads.jsonl", { id, route, ...payload });
          },
        },
        payload,
        () =>
          route === "direct"
            ? evaluateDirect(payload, { apiKey: nativeKey, signal: AbortSignal.timeout(30000) })
            : evaluate({
                model: gateway.evaluationModel("typesafe-ai/jev"),
                ...payload,
                maxRetries: 0,
                abortSignal: AbortSignal.timeout(30000),
              }),
      );
      validateAnswers(payload.questions, r.answers);
      append(out + "/results.jsonl", {
        requestId,
        route,
        label,
        ok: true,
        elapsedMs: performance.now() - t,
        usage: r.usage,
        answers: r.answers,
        resolvedModel: r.response?.modelId,
      });
      console.log(JSON.stringify({ route, label, ok: true }));
    } catch (error) {
      append(out + "/results.jsonl", {
        requestId,
        route,
        label,
        ok: false,
        elapsedMs: performance.now() - t,
        error: error instanceof Error ? error.message : "unknown",
      });
      if (!(error instanceof Error) || error.message !== "transient_provider_unavailable")
        throw error;
      console.log(JSON.stringify({ route, label, ok: false }));
    }
  };
  await invoke("direct", "synthetic-smoke", {
    state: { build: "failed" },
    questions: {
      next: {
        type: "choice",
        instructions: "Select the next action for this build.",
        criteria: {
          investigate: "Investigate the failed build",
          announce: "Announce successful deployment",
        },
      },
    },
  });
  for (let repeat = 0; repeat < 2; repeat++)
    for (const [i, p] of payloads.entries())
      for (const route of ((repeat + i) % 2 ? ["direct", "gateway"] : ["gateway", "direct"]) as (
        | "direct"
        | "gateway"
      )[])
        await invoke(route, `${p.label}-${repeat}`, p.payload);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "route_probe_failed");
  process.exitCode = 1;
});
