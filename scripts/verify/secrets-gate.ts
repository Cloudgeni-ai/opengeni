#!/usr/bin/env bun
/**
 * Secrets full-stack gate (dossier §12 E2E-1..E2E-12, §13.6, §17.1).
 *
 * Takes a worktree, makes sure its localstack is up (optionally starting,
 * seeding and logging in), starts the fake-login suite on the slot's ports,
 * probes which secrets features exist, seeds canaries, and then runs:
 *   1. scripted scenarios on the model-free `directive` turn worker;
 *   2. real-model scenarios through the Vercel AI Gateway (`--model`);
 *   3. the canary sweep (E2E-11) and the upgrade path (E2E-12).
 * Each scenario writes `<evidence>/<id>/result.json` (plus value-free turn
 * trails and scrubbed tool calls); the run writes `summary.json` and `summary.md`.
 * Scenarios whose product features are missing fail with `missing_feature`.
 *
 *   bun --no-env-file scripts/verify/secrets-gate.ts --worktree <wt> --slot 3 --name sv-w7 \
 *     [--scenarios all|E2E-1,E2E-6|BASE-*] [--model kimi-k3] [--evidence <dir>] \
 *     [--up] [--machine-up] [--keep-canaries]
 *
 * Exit 0 only when every selected scenario passed.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  type FakeLoginServer,
  DEFAULT_FAKE_LOGIN_ACCOUNTS,
  startFakeLoginServer,
} from "../../packages/testing/src/fake-login";
import { runSweep, stackSweepSources } from "./secrets-canary-sweep";
import { type FeatureReport, probeFeatures } from "./secrets-e2e/features";
import { type KnownValue, writeCanaryFile } from "./secrets-e2e/scan";
import {
  type ScenarioContext,
  type ScenarioResult,
  type Scenario,
  runScenario,
  selectScenarios,
} from "./secrets-e2e/scenarios";
import {
  StackApi,
  type StackState,
  ensureStack,
  fakeLoginPorts,
  listMachines,
  machineUp,
  scriptedWorkerActive,
  startScriptedWorker,
  stopScriptedWorker,
} from "./secrets-e2e/stack";
import { MissingFeatureError, seedCanaries } from "./secrets-seed-canaries";

export type GateOptions = {
  worktree: string;
  slot: number;
  name: string;
  scenarios: Scenario[];
  model: string;
  evidenceDir: string;
  allowUp: boolean;
  machineUp: boolean;
  keepCanaries: boolean;
  log: (line: string) => void;
};

export type GateSummary = {
  startedAt: string;
  finishedAt: string;
  worktree: string;
  sha: string;
  stack: { name: string; web: string; api: string; slot: number };
  model: string;
  features: FeatureReport;
  results: ScenarioResult[];
  passed: boolean;
};

function gitSha(worktree: string): string {
  const result = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"], { stdout: "pipe" });
  return result.stdout.toString().trim();
}

export async function runGate(options: GateOptions): Promise<GateSummary> {
  const startedAt = new Date().toISOString();
  const log = options.log;
  mkdirSync(options.evidenceDir, { recursive: true });
  const stack = await ensureStack({
    name: options.name,
    worktree: options.worktree,
    slot: options.slot,
    modelKey: true,
    allowUp: options.allowUp,
    log,
  });
  log(`stack ${stack.name}: web ${stack.web} api ${stack.api}`);
  const owner = new StackApi(stack, "owner");
  const member = new StackApi(stack, "member");
  const viewer = new StackApi(stack, "viewer");
  const workspaceId = await owner.workspaceId();

  const ports = fakeLoginPorts(options.slot);
  const fakeLogLines: string[] = [];
  const fakeLogin: FakeLoginServer = await startFakeLoginServer({
    port: ports.port,
    iframePort: ports.iframePort,
    accounts: DEFAULT_FAKE_LOGIN_ACCOUNTS,
    log: (line) => fakeLogLines.push(`${new Date().toISOString()} ${line}`),
  });
  log(`fake-login ${fakeLogin.url} (cross-origin ${fakeLogin.crossOriginUrl})`);

  const wasScripted = scriptedWorkerActive(stack);
  const knownValues: KnownValue[] = [];
  const canaryFile = join(options.evidenceDir, "canaries.json");
  const results: ScenarioResult[] = [];
  let features = {} as FeatureReport;
  try {
    // Probe with the directive worker so the tool surface is inspected too.
    ensureScripted(stack, true, log);
    if (options.machineUp && options.scenarios.some((scenario) => scenario.id === "E2E-6")) {
      if (!(await listMachines(owner, workspaceId)).some((machine) => machine.online)) {
        log("bringing the connected machine online (machine.sh up)");
        const up = machineUp(stack);
        if (up.exitCode !== 0) log(`machine.sh up failed: ${up.stderr.slice(-400)}`);
      }
    }
    features = await probeFeatures({
      stack,
      owner,
      workspaceId,
      scriptedWorkerActive: true,
      harnessRoot: resolve(import.meta.dir, "../.."),
    });
    for (const probe of Object.values(features)) {
      log(`feature ${probe.present ? "present" : "MISSING"} ${probe.id}: ${probe.detail}`);
    }
    writeFileSync(
      join(options.evidenceDir, "features.json"),
      `${JSON.stringify(features, null, 2)}\n`,
    );

    if (features.vaults_api?.present) {
      try {
        const file = await seedCanaries(owner, workspaceId);
        writeCanaryFile(canaryFile, file);
        knownValues.push(...file.values.map(({ label, value }) => ({ label, value })));
        log(`seeded canaries: ${file.values.map((value) => value.label).join(", ")}`);
      } catch (error) {
        log(`canary seeding failed: ${(error as Error).message}`);
        if (!(error instanceof MissingFeatureError)) throw error;
      }
    }
    for (const account of DEFAULT_FAKE_LOGIN_ACCOUNTS) {
      knownValues.push({
        label: `fake-login:${account.username}:password`,
        value: account.password,
      });
    }

    const machines = await listMachines(owner, workspaceId);
    const machine = machines.find((row) => row.online);
    const context: ScenarioContext = {
      stack,
      owner,
      member,
      viewer,
      workspaceId,
      features,
      fakeLogin,
      model: options.model,
      knownValues,
      evidenceDir: options.evidenceDir,
      ...(machine ? { machineSandboxId: machine.id } : {}),
      log,
      sweep: (values, sweepOptions) => sweepStack(stack, values, sweepOptions),
    };
    const phases: [string, (scenario: Scenario) => boolean, boolean | null][] = [
      ["scripted", (scenario) => scenario.mode === "scripted", true],
      ["real", (scenario) => scenario.mode === "real", false],
      [
        "sweep+upgrade",
        (scenario) => scenario.mode === "sweep" || scenario.mode === "upgrade",
        null,
      ],
    ];
    for (const [phase, matches, scripted] of phases) {
      const selected = options.scenarios.filter(matches);
      if (selected.length === 0) continue;
      if (scripted !== null) ensureScripted(stack, scripted, log);
      log(`phase ${phase}: ${selected.map((scenario) => scenario.id).join(", ")}`);
      for (const scenario of selected) {
        const result = await runScenario(scenario, context);
        results.push(result);
        log(
          `${result.id} ${result.status.toUpperCase()}${result.reason ? ` - ${result.reason}` : ""}`,
        );
      }
    }
  } finally {
    writeFileSync(join(options.evidenceDir, "fake-login.log"), `${fakeLogLines.join("\n")}\n`);
    writeFileSync(
      join(options.evidenceDir, "fake-login-state.json"),
      `${JSON.stringify(fakeLogin.state(), null, 2)}\n`,
    );
    await fakeLogin.close();
    ensureScripted(stack, wasScripted, log);
    if (!options.keepCanaries && existsSync(canaryFile)) rmSync(canaryFile);
  }
  const order = new Map(options.scenarios.map((scenario, index) => [scenario.id, index]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const summary: GateSummary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    worktree: options.worktree,
    sha: gitSha(options.worktree),
    stack: { name: stack.name, web: stack.web, api: stack.api, slot: options.slot },
    model: options.model,
    features,
    results,
    passed: results.length > 0 && results.every((result) => result.status === "passed"),
  };
  writeFileSync(join(options.evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(options.evidenceDir, "summary.md"), summaryMarkdown(summary));
  return summary;
}

function ensureScripted(stack: StackState, wanted: boolean, log: (line: string) => void): void {
  const active = scriptedWorkerActive(stack);
  if (active === wanted) return;
  log(wanted ? "starting the scripted directive worker" : "restoring the real turn worker");
  const result = wanted ? startScriptedWorker(stack, "directive") : stopScriptedWorker(stack);
  if (result.exitCode !== 0) {
    throw new Error(
      `scripted-turn.sh ${wanted ? "start" : "stop"} failed: ${result.stderr.slice(-400)}`,
    );
  }
}

async function sweepStack(
  stack: StackState,
  values: KnownValue[],
  options: { expectHits: boolean; out: string },
): Promise<{ ok: boolean; summary: string }> {
  const report = await runSweep({
    ...stackSweepSources(stack),
    values,
    keyNames: options.expectHits ? [] : ["secretAnswers"],
    allDatabases: true,
    dirs: [],
    temporalLimit: options.expectHits ? 25 : 500,
    allow: [],
    log: () => {},
  });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  const locations = [...report.hits, ...report.allowed].map(
    (hit) => `${hit.label}@${hit.location} x${hit.count}`,
  );
  const ok = options.expectHits ? report.missingLabels.length === 0 : report.clean;
  return {
    ok,
    summary: `${report.hits.length} unexpected hit groups; ${locations.slice(0, 8).join(", ")}${
      locations.length > 8 ? ", ..." : ""
    }; errors ${report.errors.length}`,
  };
}

function summaryMarkdown(summary: GateSummary): string {
  const lines = [
    `# Secrets gate run`,
    "",
    `- Worktree: ${summary.worktree} at ${summary.sha}`,
    `- Stack: ${summary.stack.name} (slot ${summary.stack.slot}, web ${summary.stack.web})`,
    `- Model: ${summary.model}`,
    `- Started ${summary.startedAt}, finished ${summary.finishedAt}`,
    `- Result: ${summary.passed ? "PASSED" : "NOT PASSED"}`,
    "",
    "| Scenario | Mode | Status | Reason |",
    "|---|---|---|---|",
    ...summary.results.map(
      (result) =>
        `| ${result.id} | ${result.mode} | ${result.status} | ${(result.reason ?? "").replaceAll("|", "\\|").slice(0, 300)} |`,
    ),
    "",
    "## Features",
    "",
    ...Object.values(summary.features).map(
      (probe) => `- ${probe.present ? "present" : "missing"} \`${probe.id}\`: ${probe.detail}`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      worktree: { type: "string", default: process.cwd() },
      slot: { type: "string", default: "3" },
      name: { type: "string" },
      scenarios: { type: "string", default: "all" },
      model: { type: "string", default: "kimi-k3" },
      evidence: { type: "string" },
      up: { type: "boolean", default: false },
      "machine-up": { type: "boolean", default: false },
      "keep-canaries": { type: "boolean", default: false },
    },
  });
  const worktree = resolve(flags.worktree!);
  const name = flags.name ?? `sv-${basename(worktree)}`;
  const evidenceDir = resolve(
    flags.evidence ??
      join(worktree, ".agent/evidence", `gate-${new Date().toISOString().replace(/[:.]/gu, "-")}`),
  );
  const summary = await runGate({
    worktree,
    slot: Number(flags.slot),
    name,
    scenarios: selectScenarios(flags.scenarios),
    model: flags.model!,
    evidenceDir,
    allowUp: flags.up!,
    machineUp: flags["machine-up"]!,
    keepCanaries: flags["keep-canaries"]!,
    log: (line) => console.log(`[gate] ${line}`),
  });
  console.log(`[gate] evidence ${evidenceDir}`);
  console.log(`[gate] ${summary.passed ? "PASSED" : "NOT PASSED"}`);
  return summary.passed ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`[gate] error: ${(error as Error).stack ?? error}`);
    process.exit(2);
  }
}
