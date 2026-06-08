import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

interface Args {
  previousDigest: string;
  currentDigest: string;
  postRollbackConformance: string;
  forwardRollConformance: string;
  rollbackSeconds: number;
  outFile: string;
}

const args = parseArgs(process.argv.slice(2), process.env);
const postRollback = parseConformance(args.postRollbackConformance);
const forwardRoll = parseConformance(args.forwardRollConformance);
const metrics = {
  digestPinnedRollback: isShaDigest(args.previousDigest) && isShaDigest(args.currentDigest),
  previousArtifactRestored: args.previousDigest !== args.currentDigest && isShaDigest(args.previousDigest),
  postRollbackConformancePassed: postRollback.ok === true,
  forwardRollConformancePassed: forwardRoll.ok === true,
  rollbackSeconds: args.rollbackSeconds,
  previousDigest: args.previousDigest,
  currentDigest: args.currentDigest,
};
const ok = metrics.digestPinnedRollback
  && metrics.previousArtifactRestored
  && metrics.postRollbackConformancePassed
  && metrics.forwardRollConformancePassed
  && Number.isFinite(metrics.rollbackSeconds)
  && metrics.rollbackSeconds > 0;

const output = {
  ok,
  checks: [{
    id: "rollback",
    status: ok ? "passed" : "failed",
    detail: ok
      ? `rollback and forward-roll conformance passed in ${metrics.rollbackSeconds}s`
      : "rollback evidence is incomplete or failed",
    evidence: [args.postRollbackConformance, args.forwardRollConformance],
    metrics,
  }],
};

await mkdir(dirname(args.outFile), { recursive: true });
await Bun.write(args.outFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));

if (!ok) {
  process.exit(1);
}
process.exit(0);

function parseConformance(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`conformance evidence ${path} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    previousDigest: env.OPENGENI_ROLLBACK_PREVIOUS_DIGEST ?? "",
    currentDigest: env.OPENGENI_ROLLBACK_CURRENT_DIGEST ?? "",
    postRollbackConformance: env.OPENGENI_ROLLBACK_POST_CONFORMANCE ?? "",
    forwardRollConformance: env.OPENGENI_ROLLBACK_FORWARD_CONFORMANCE ?? "",
    rollbackSeconds: Number(env.OPENGENI_ROLLBACK_SECONDS ?? 0),
    outFile: env.OPENGENI_ROLLBACK_OUT_FILE ?? ".agent/generated/staging/rollback.json",
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--previous-digest") {
      out.previousDigest = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--current-digest") {
      out.currentDigest = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--post-rollback-conformance") {
      out.postRollbackConformance = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--forward-roll-conformance") {
      out.forwardRollConformance = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--rollback-seconds") {
      out.rollbackSeconds = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--out") {
      out.outFile = requiredNext(values, ++index, value);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  for (const [field, value] of Object.entries({
    previousDigest: out.previousDigest,
    currentDigest: out.currentDigest,
    postRollbackConformance: out.postRollbackConformance,
    forwardRollConformance: out.forwardRollConformance,
  })) {
    if (!value) {
      throw new Error(`${field} is required`);
    }
  }
  return out;
}

function isShaDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}
