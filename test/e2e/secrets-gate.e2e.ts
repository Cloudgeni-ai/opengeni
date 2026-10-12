/**
 * Secrets full-stack gate as a bun test (dossier §13.6 "E2E-1 to E2E-12").
 * Opt-in: it needs a running localstack for the worktree under test.
 *
 *   SECRETS_GATE_WORKTREE=<wt> SECRETS_GATE_SLOT=3 SECRETS_GATE_NAME=sv-w7 \
 *   [SECRETS_GATE_SCENARIOS=all] [SECRETS_GATE_MODEL=gpt-6-sol] [SECRETS_GATE_EVIDENCE=<dir>] \
 *     bun --no-env-file test --timeout 7200000 ./test/e2e/secrets-gate.e2e.ts
 *
 * The gate runs once; each selected scenario is then reported as its own test,
 * failing with the scenario's reason (missing feature, failed checks, or a
 * harness step not implemented yet).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { type GateSummary, runGate } from "../../scripts/verify/secrets-gate";
import { selectScenarios } from "../../scripts/verify/secrets-e2e/scenarios";

const worktree = process.env.SECRETS_GATE_WORKTREE;
const scenarios = selectScenarios(process.env.SECRETS_GATE_SCENARIOS ?? "all");

describe.skipIf(!worktree)("secrets full-stack gate", () => {
  let summary: GateSummary;

  beforeAll(async () => {
    const root = resolve(worktree!);
    summary = await runGate({
      worktree: root,
      slot: Number(process.env.SECRETS_GATE_SLOT ?? "3"),
      name: process.env.SECRETS_GATE_NAME ?? "sv-w7",
      scenarios,
      model: process.env.SECRETS_GATE_MODEL ?? "gpt-6-sol",
      evidenceDir:
        process.env.SECRETS_GATE_EVIDENCE ??
        join(root, ".agent/evidence", `gate-${new Date().toISOString().replace(/[:.]/gu, "-")}`),
      allowUp: process.env.SECRETS_GATE_UP === "1",
      machineUp: process.env.SECRETS_GATE_MACHINE_UP === "1",
      keepCanaries: false,
      log: (line) => console.log(`[gate] ${line}`),
    });
  }, 7_200_000);

  for (const scenario of scenarios) {
    test(`${scenario.id}: ${scenario.title}`, () => {
      const result = summary.results.find((row) => row.id === scenario.id);
      expect(result, `${scenario.id} did not run`).toBeDefined();
      expect(
        { status: result!.status, reason: result!.reason ?? null },
        `${scenario.id} ${result!.status}: ${result!.reason ?? ""}`,
      ).toEqual({ status: "passed", reason: null });
    });
  }
});
