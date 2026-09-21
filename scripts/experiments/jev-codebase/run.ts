import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_LIMITS, POLICY_VERSION, hash, investigate, loadSnapshot, rankChunks, termsFor, type Request } from "./core";
import { createJudge, preflight, type Arm, type Receipt } from "./gateway";

// This executable is an experiment, not a registered OpenGeni tool or authority boundary.
// All output goes outside the investigated snapshot; raw source remains local.
const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const mode = args[0];
type Case = Request & { id: string; split: string; expectedAnswer: string; requiredPaths: string[]; category: string; oracleRationale: string };

async function main() {
  if (mode === "preflight") {
    const result = await preflight();
    console.log(JSON.stringify({ available: true, prices: result.prices, checkedAt: result.checkedAt })); return;
  }
  if (mode !== "benchmark" && mode !== "investigate" && mode !== "plan") throw new Error("use_plan_benchmark_investigate_or_preflight");
  const root = option("--root");
  if (!root) throw new Error("root_required");
  const snapshotStart = performance.now();
  const snapshot = loadSnapshot(root, option("--revision", "HEAD"), option("--subdir", ""));
  const snapshotMs = performance.now() - snapshotStart;
  if (mode === "plan") {
    console.log(JSON.stringify({ revision: snapshot.revision, digest: snapshot.digest, chunks: snapshot.chunks.length, excluded: snapshot.excluded, limited: snapshot.limited, snapshotMs })); return;
  }
  const output = resolve(option("--out", `runs/${new Date().toISOString().replace(/[:.]/g, "-")}`)!);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  // Exclusive manifest creation prevents rerunning paid work into an existing run directory.
  const setup = await preflight();
  const maxRequests = Number(option("--max-requests", "80"));
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 80) throw new Error("invalid_request_budget");
  const implementationDigest = hash(["core.ts", "gateway.ts", "run.ts", "bun.lock"].map(p => readFileSync(`${import.meta.dir}/${p}`, "utf8")).join("\n"));
  const manifest = { version: 1, policyVersion: POLICY_VERSION, implementationDigest, bunVersion: Bun.version, createdAt: new Date().toISOString(), revision: snapshot.revision, snapshotDigest: snapshot.digest, snapshotMs, prices: setup.prices, priceCheckedAt: setup.checkedAt, maxRequests, maxUsd: 0.50, concurrency: 1, retries: 0, limits: { ...DEFAULT_LIMITS, maxSteps: 4 }, note: "Local application guard, not provider-enforced budget. Main-agent costs are not measured by this script benchmark." };
  writeFileSync(`${output}/manifest.json`, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  const journal = `${output}/requests.jsonl`;
  if (mode === "investigate") {
    const requestPath = option("--request"); if (!requestPath) throw new Error("request_file_required");
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as Request;
    const result = await investigate(snapshot, request, createJudge("jev", setup, journal, maxRequests), manifest.limits);
    writeFileSync(`${output}/result.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result)); return;
  }
  const casePath = option("--cases"); if (!casePath) throw new Error("cases_required");
  const allCases = JSON.parse(readFileSync(casePath, "utf8")) as Case[];
  const cases = allCases.filter(c => !option("--split") || c.split === option("--split"));
  if (!cases.length) throw new Error("no_cases");
  writeFileSync(`${output}/cases-digest.json`, JSON.stringify({ sha256: hash(JSON.stringify(cases)), ids: cases.map(c => c.id), note: "Labels and rationale are never passed to either model." }, null, 2), { mode: 0o600 });
  const records: unknown[] = [];
  for (const [index, c] of cases.entries()) {
    const request: Request = { question: c.question, context: c.context, searchHints: c.searchHints, requestedOutput: c.requestedOutput ?? "answer_if_supported" };
    const lexical = rankChunks(snapshot.chunks, termsFor(request)).slice(0, 4);
    const lexicalPaths = new Set(lexical.map(e => e.path));
    records.push({ caseId: c.id, arm: "lexical-top4", requiredPathRecall: c.requiredPaths.length ? c.requiredPaths.filter(p => lexicalPaths.has(p)).length / c.requiredPaths.length : null, returnedChars: lexical.reduce((n, e) => n + e.text.length, 0), note: "Retrieval-only diagnostic, not an answer baseline." });
    const only = option("--arm");
    if (only && only !== "jev" && only !== "llm") throw new Error("invalid_arm");
    const arms: Arm[] = only ? [only as Arm] : index % 2 ? ["llm", "jev"] : ["jev", "llm"];
    for (const arm of arms) {
      const result = await investigate(snapshot, request, createJudge(arm, setup, journal, maxRequests), manifest.limits);
      const paths = new Set(result.evidence.map(e => e.path));
      const row = { caseId: c.id, split: c.split, category: c.category, arm, expectedAnswer: c.expectedAnswer, answerCorrect: result.answer === c.expectedAnswer, wrongDecisive: result.answer !== "indecisive" && result.answer !== c.expectedAnswer, requiredPathRecall: c.requiredPaths.length ? c.requiredPaths.filter(p => paths.has(p)).length / c.requiredPaths.length : null, returnedChars: result.evidence.reduce((n, e) => n + e.text.length, 0), result };
      records.push(row);
      writeFileSync(`${output}/results.json`, JSON.stringify(records, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ caseId: c.id, arm, status: result.status, answer: result.answer, correct: row.answerCorrect, recall: row.requiredPathRecall, elapsedMs: result.elapsedMs }));
      if (result.status === "error") throw new Error("benchmark_stopped_on_error");
    }
  }
  const receipts: Receipt[] = readFileSync(journal, "utf8").trim().split("\n").map(s => JSON.parse(s));
  const costs = Object.fromEntries((["jev", "llm"] as Arm[]).map(arm => {
    const rows = receipts.filter(r => r.kind === "completed" && r.arm === arm);
    return [arm, { calls: rows.length, inputTokens: rows.reduce((s, r) => s + r.inputTokens!, 0), outputTokens: rows.reduce((s, r) => s + r.outputTokens!, 0), nominalUsd: rows.reduce((s, r) => s + r.nominalUsd!, 0), reportedUsd: rows.every(r => r.reportedUsd !== null) ? rows.reduce((s, r) => s + r.reportedUsd!, 0) : null }];
  }));
  writeFileSync(`${output}/costs.json`, JSON.stringify(costs, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, costs }));
}

main().catch(() => { console.error("Experiment stopped. Inspect the local allowlisted journal; no automatic retry or provider fallback was performed."); process.exitCode = 1; });