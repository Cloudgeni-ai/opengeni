#!/usr/bin/env bun
// Confirms a canary cohort that the publish job already wrote, then emits the
// exact Site package pins. It holds no registry credentials and never publishes,
// so re-running a failed confirmation job only waits longer for npm.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CanaryReceiptStore } from "./canary-publication-receipts";
import { verifyCanaryController } from "./canary-source-admission";
import {
  canarySitePins,
  CanaryVisibilityPending,
  confirmCanaryCohort,
  parseCanaryCohort,
  readRegistryPackage,
  workflowCanarySequence,
} from "./publish-canary";

export function admitCanaryConfirmation(env: Record<string, string | undefined>, head: string) {
  verifyCanaryController(env, head);
  if (env.NODE_AUTH_TOKEN || env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !env.CANARY_COHORT) {
    throw new Error("Canary confirmation runs without publish credentials on a handed-off cohort");
  }
  workflowCanarySequence(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
  const cohort = parseCanaryCohort(env.CANARY_COHORT, {
    source: env.SOURCE_SHA!,
    workflowSource: head,
    runId: env.GITHUB_RUN_ID!,
  });
  if (Number(cohort.attempt) > Number(env.GITHUB_RUN_ATTEMPT)) {
    throw new Error("Canary cohort handoff comes from a later attempt");
  }
  return cohort;
}

export async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status !== 0) throw new Error("Canary controller HEAD cannot be resolved");
  const cohort = admitCanaryConfirmation(process.env, head.stdout.trim());
  mkdirSync(join(root, ".release"), { recursive: true });
  const custody = new CanaryReceiptStore(join(root, ".release/canary-confirmation-receipts"), {
    source: cohort.source,
    workflowSource: cohort.workflowSource,
    runId: cohort.runId,
    attempt: process.env.GITHUB_RUN_ATTEMPT!,
  });
  custody.record("COHORT_HANDOFF_ADMITTED", {
    publisherAttempt: cohort.attempt,
    packages: cohort.packages,
    packageCount: cohort.packages.length,
  });
  try {
    await confirmCanaryCohort(cohort.packages, readRegistryPackage, { custody });
  } catch (error) {
    custody.record("CONFIRMATION_FAILED", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    if (error instanceof CanaryVisibilityPending) {
      process.stdout.write(
        `::error::${error.message}. npm accepted every write of this run; it has not finished ` +
          "processing them. Re-run this failed job to keep waiting without publishing again.\n",
      );
    }
    throw error;
  }
  const pins = canarySitePins(cohort.packages);
  const pinsPath = join(root, ".release/site-package-versions.json");
  writeFileSync(pinsPath, JSON.stringify(pins, null, 2), { flag: "wx", mode: 0o600 });
  custody.record("SITE_PINS_WRITTEN", {
    sha256: createHash("sha256").update(readFileSync(pinsPath)).digest("hex"),
    count: Object.keys(pins).length,
    metadataOnly: true,
  });
  for (const pkg of cohort.packages) {
    process.stdout.write(`${pkg.name}@${pkg.version} confirmed with provenance\n`);
  }
}

if (import.meta.main) await main();
