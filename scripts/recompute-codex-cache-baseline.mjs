#!/usr/bin/env node
// Recompute the Codex CLI prompt-cache baseline from local rollout files.
//
// This is a one-shot analysis artifact, not part of the build. It exists so the
// "96% token-weighted cached ratio" figure in
// docs/design/prompt-cache-affinity.md stays reproducible rather than asserted.
//
// Source: ~/.codex/sessions/**/rollout-*.jsonl (one file per Codex CLI session).
// Per model call, Codex emits an `event_msg` whose `payload.type == "token_count"`
// and whose `payload.info.last_token_usage` is THAT single call's usage:
//     input_tokens         -- total input tokens for the call (INCLUSIVE of cached)
//     cached_input_tokens  -- the cached subset of input_tokens
// Verified: total_token_usage.input_tokens accumulates and each step equals the
// next last_token_usage.input_tokens, so last_token_usage is genuinely per-call;
// and cached_input_tokens never exceeds input_tokens (it is a subset).
//
// Cached ratio for a call        = cached_input_tokens / input_tokens
// Token-weighted global ratio    = sum(cached_input_tokens) / sum(input_tokens)
//
// Usage: node scripts/recompute-codex-cache-baseline.mjs [sessionsDir]
// Default sessionsDir = ~/.codex/sessions
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.argv[2] ?? join(homedir(), ".codex", "sessions");

async function listRollouts(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listRollouts(full)));
    } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function percentile(sorted, q) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] * (1 - (pos - lo)) + sorted[hi] * (pos - lo);
}

const files = (await listRollouts(root)).sort();

let filesWithCalls = 0;
let totalCalls = 0;
let nullInfoEvents = 0;
let zeroInputCalls = 0;
let cachedGtInput = 0;
let sumInput = 0;
let sumCached = 0;
const perCall = []; // unweighted per-call cached ratio (input>0)
const sessions = []; // { calls, input, cached } per file

for (const path of files) {
  let calls = 0;
  let input = 0;
  let cached = 0;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"token_count"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = rec?.payload;
    if (payload?.type !== "token_count") continue;
    const info = payload.info;
    if (!info) {
      nullInfoEvents += 1;
      continue;
    }
    const last = info.last_token_usage ?? {};
    const inp = last.input_tokens;
    if (inp === undefined || inp === null) continue;
    const c = last.cached_input_tokens ?? 0;
    if (c > inp) cachedGtInput += 1;
    calls += 1;
    input += inp;
    cached += c;
    if (inp > 0) perCall.push(c / inp);
    else zeroInputCalls += 1;
  }
  if (calls > 0) {
    filesWithCalls += 1;
    totalCalls += calls;
    sumInput += input;
    sumCached += cached;
    sessions.push({ calls, input, cached });
  }
}

const tw = sumInput > 0 ? sumCached / sumInput : NaN;
perCall.sort((a, b) => a - b);
const p = (q) => (percentile(perCall, q) * 100).toFixed(2);
const below50 = perCall.filter((r) => r < 0.5).length;

const long = sessions.filter((s) => s.calls >= 10 && s.input >= 200_000);
const longRatios = long
  .filter((s) => s.input > 0)
  .map((s) => s.cached / s.input)
  .sort((a, b) => a - b);
const longPooledIn = long.reduce((a, s) => a + s.input, 0);
const longPooledCached = long.reduce((a, s) => a + s.cached, 0);

const fmt = (n) => n.toLocaleString("en-US");
console.log("====================================================================");
console.log("CODEX CLI PROMPT-CACHE BASELINE — recomputed from local rollouts");
console.log("====================================================================");
console.log(`sessions dir                 : ${root}`);
console.log(`rollout files scanned        : ${files.length}`);
console.log(`files with >=1 measured call : ${filesWithCalls}`);
console.log(`model calls measured         : ${fmt(totalCalls)}`);
console.log(`  token_count w/o usage skipped: ${fmt(nullInfoEvents)}`);
console.log(`  zero-input calls (excl ratio): ${fmt(zeroInputCalls)}`);
console.log(`  SANITY cached>input (must be 0): ${cachedGtInput}`);
console.log("");
console.log(`sum(input_tokens)            : ${fmt(sumInput)}`);
console.log(`sum(cached_input_tokens)     : ${fmt(sumCached)}`);
console.log(`TOKEN-WEIGHTED cached ratio  : ${(tw * 100).toFixed(2)}%   <-- headline`);
console.log("");
console.log("Per-call cached ratio (unweighted, input>0):");
console.log(`  calls counted              : ${fmt(perCall.length)}`);
console.log(
  `  p10 / p25 / p50 / p75 / p90 : ${p(0.1)}% / ${p(0.25)}% / ${p(0.5)}% / ${p(0.75)}% / ${p(0.9)}%`,
);
console.log(
  `  calls <50% cached (cold)   : ${fmt(below50)} (${((below50 / perCall.length) * 100).toFixed(2)}%)`,
);
console.log("");
console.log("Long agentic sessions (>=10 calls AND >=200k total input):");
console.log(`  qualifying sessions        : ${long.length}`);
console.log(`  per-session ratio median   : ${(percentile(longRatios, 0.5) * 100).toFixed(2)}%`);
console.log(
  `  pooled token-weighted      : ${((longPooledCached / longPooledIn) * 100).toFixed(2)}%`,
);
