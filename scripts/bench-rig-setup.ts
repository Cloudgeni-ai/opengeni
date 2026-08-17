#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRigSetupHook } from "@opengeni/runtime";

const MAX_SETUP_SCRIPT_CHARS = 131_072;
const samples = integerArgument("--samples", 3);
const roundTripLatenciesMs = integerListArgument("--round-trip-ms", [0, 20, 100]);

if (samples < 1 || samples > 20) throw new Error("--samples must be between 1 and 20");

type ScriptCase = {
  label: string;
  scriptChars: number;
  padding: string;
};

const cases: ScriptCase[] = [
  { label: "tiny", scriptChars: 512, padding: "x" },
  { label: "near-inline-boundary", scriptChars: 32 * 1024, padding: "x" },
  { label: "max-ascii", scriptChars: MAX_SETUP_SCRIPT_CHARS, padding: "x" },
  // The public contract limits JavaScript characters, not UTF-8 bytes. A BMP
  // code point therefore exercises the largest ordinary byte payload admitted
  // by the same 131,072-character API limit without using malformed surrogates.
  { label: "max-three-byte-unicode", scriptChars: MAX_SETUP_SCRIPT_CHARS, padding: "界" },
];

type Measurement = {
  case: string;
  commandBytes: number;
  commandCount: number;
  elapsedMs: number;
  phase: "cold" | "warm";
  roundTripMs: number;
  scriptBytes: number;
  scriptChars: number;
};

const measurements: Measurement[] = [];
for (const scriptCase of cases) {
  for (const roundTripMs of roundTripLatenciesMs) {
    for (let sample = 0; sample < samples; sample += 1) {
      const versionId = randomUUID();
      const runReceiptPath = join(tmpdir(), `opengeni-rig-bench-${versionId}`);
      const script = setupScript(scriptCase, runReceiptPath);
      const contentHash = createHash("sha256").update(script, "utf8").digest("hex");
      const workspace = await mkdtemp(join(tmpdir(), "opengeni-rig-setup-workspace-"));
      const session = shellSession(workspace, roundTripMs);
      const descriptor = {
        rigId: "11111111-1111-4111-8111-111111111111",
        versionId,
        rigName: `benchmark-${scriptCase.label}`,
        script,
        timeoutMs: 30_000,
        contentHash: `sha256:${contentHash}`,
      };
      try {
        for (const phase of ["cold", "warm"] as const) {
          session.reset();
          const startedAt = performance.now();
          await runRigSetupHook(session as never, {
            environment: {},
            rigSetup: descriptor,
          });
          const elapsedMs = performance.now() - startedAt;
          measurements.push({
            case: scriptCase.label,
            commandBytes: session.commandBytes(),
            commandCount: session.commandCount(),
            elapsedMs,
            phase,
            roundTripMs,
            scriptBytes: Buffer.byteLength(script, "utf8"),
            scriptChars: script.length,
          });
        }
        const receipts = (await readFile(runReceiptPath, "utf8")).trim().split("\n");
        if (receipts.length !== 1 || receipts[0] !== "ran") {
          throw new Error(`rig setup executed ${receipts.length} times instead of exactly once`);
        }
      } finally {
        await Promise.all([
          rm(workspace, { force: true, recursive: true }),
          rm(runReceiptPath, { force: true }),
          rm(`/tmp/opengeni/rig-setup/rig-setup-${versionId}.done`, { force: true }),
          rm(`/tmp/opengeni/rig-setup/rig-setup-content-${contentHash}.done`, { force: true }),
          rm(`/tmp/opengeni/rig-setup/rig-setup-content-${contentHash}.done.lock`, {
            force: true,
            recursive: true,
          }),
        ]);
      }
    }
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      invariant:
        "The exact frozen setup script executes once on a cold box; every warm invocation observes the same marker and skips without dropping rig functionality.",
      configuration: { samples, roundTripLatenciesMs, maxSetupScriptChars: MAX_SETUP_SCRIPT_CHARS },
      measurements: summarize(measurements),
    },
    null,
    2,
  )}\n`,
);

function setupScript(scriptCase: ScriptCase, receiptPath: string): string {
  const prefix = `set -eu\nprintf 'ran\\n' >> '${receiptPath}'\n#`;
  const suffix = "\n";
  const remaining = scriptCase.scriptChars - prefix.length - suffix.length;
  if (remaining < 0) throw new Error(`${scriptCase.label} is too small for the benchmark prologue`);
  const script = `${prefix}${scriptCase.padding.repeat(remaining)}${suffix}`;
  if (script.length !== scriptCase.scriptChars) {
    throw new Error(
      `${scriptCase.label} produced ${script.length} chars, expected ${scriptCase.scriptChars}`,
    );
  }
  return script;
}

function shellSession(workspace: string, roundTripMs: number) {
  let calls: string[] = [];
  return {
    reset() {
      calls = [];
    },
    commandCount() {
      return calls.length;
    },
    commandBytes() {
      return calls.reduce((total, command) => total + Buffer.byteLength(command, "utf8"), 0);
    },
    async exec(args: { cmd: string }) {
      calls.push(args.cmd);
      if (roundTripMs > 0) await Bun.sleep(roundTripMs);
      await mkdir(workspace, { recursive: true });
      // Production sandboxes use GNU base64 (`-d`). macOS ships BSD base64
      // (`-D -i`). Preserve and measure the exact generated command above, and
      // translate only this host execution spelling for the local benchmark.
      const executableCommand =
        globalThis.process.platform === "darwin"
          ? args.cmd.replace(/\bbase64 -d ([^ ]+) > /u, "base64 -D -i $1 > ")
          : args.cmd;
      const process = Bun.spawn(["bash", "-lc", executableCommand], {
        cwd: workspace,
        env: globalThis.process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return { status, output: `${stdout}${stderr}` };
    },
  };
}

function summarize(input: Measurement[]) {
  const groups = new Map<string, Measurement[]>();
  for (const measurement of input) {
    const key = `${measurement.case}:${measurement.roundTripMs}:${measurement.phase}`;
    const group = groups.get(key) ?? [];
    group.push(measurement);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const elapsed = group.map((item) => item.elapsedMs).sort((a, b) => a - b);
    return {
      case: first.case,
      phase: first.phase,
      roundTripMs: first.roundTripMs,
      scriptChars: first.scriptChars,
      scriptBytes: first.scriptBytes,
      commandCount: first.commandCount,
      commandBytes: first.commandBytes,
      medianMs: percentile(elapsed, 0.5),
      p95Ms: percentile(elapsed, 0.95),
    };
  });
}

function percentile(sorted: number[], quantile: number): number {
  return Number(
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!.toFixed(3),
  );
}

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const parsed = Number.parseInt(index < 0 ? "" : (process.argv[index + 1] ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function integerListArgument(name: string, fallback: number[]): number[] {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = (process.argv[index + 1] ?? "")
    .split(",")
    .map((value) => Number.parseInt(value, 10));
  return parsed.length > 0 && parsed.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? parsed
    : fallback;
}
