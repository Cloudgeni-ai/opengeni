#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSettings, type Settings } from "@opengeni/config";
import {
  createSandboxClient,
  runRigSetupHook,
  terminateManagedSandboxSession,
} from "@opengeni/runtime";

const MAX_SETUP_SCRIPT_CHARS = 131_072;
const samples = integerArgument("--samples", 3);
const image = stringArgument("--image", "opengeni-sandbox:local");

if (samples < 1 || samples > 10) throw new Error("--samples must be between 1 and 10");

const settings: Settings = {
  ...getSettings(),
  sandboxBackend: "docker",
  dockerImage: image,
};

type Receipt = {
  case: string;
  sample: number;
  scriptChars: number;
  scriptBytes: number;
  createMs: number;
  coldSetupMs: number;
  warmSetupMs: number;
  coldTerminal: string;
  warmTerminal: string;
};

const receipts: Receipt[] = [];
for (const scriptCase of [
  { label: "tiny", scriptChars: 512, content: "repeated" as const },
  {
    label: "max-repeated-unicode",
    scriptChars: MAX_SETUP_SCRIPT_CHARS,
    content: "repeated" as const,
  },
  {
    label: "max-high-entropy-ascii",
    scriptChars: MAX_SETUP_SCRIPT_CHARS,
    content: "high-entropy" as const,
  },
]) {
  for (let sample = 1; sample <= samples; sample += 1) {
    const workspaceBaseDir = await mkdtemp(join(tmpdir(), "opengeni-rig-docker-bench-"));
    const client = createSandboxClient({ ...settings, dockerWorkspaceBaseDir: workspaceBaseDir });
    if (!client.create) throw new Error("Docker sandbox client has no create operation");
    let session: unknown;
    try {
      const createStarted = performance.now();
      session = await client.create();
      const createMs = performance.now() - createStarted;
      const versionId = randomUUID();
      const proofPath = `/tmp/opengeni-rig-docker-proof-${versionId}`;
      const script = setupScript(scriptCase, proofPath);
      const contentHash = createHash("sha256").update(script, "utf8").digest("hex");
      const descriptor = {
        rigId: "11111111-1111-4111-8111-111111111111",
        versionId,
        rigName: `docker-benchmark-${scriptCase.label}`,
        script,
        timeoutMs: 30_000,
        contentHash: `sha256:${contentHash}`,
      };

      const coldEvents: string[] = [];
      const coldStarted = performance.now();
      await runRigSetupHook(session as never, {
        environment: {},
        rigSetup: descriptor,
        onRuntimeEvent: (event) => coldEvents.push(event.type),
      });
      const coldSetupMs = performance.now() - coldStarted;

      const warmEvents: string[] = [];
      const warmStarted = performance.now();
      await runRigSetupHook(session as never, {
        environment: {},
        rigSetup: descriptor,
        onRuntimeEvent: (event) => warmEvents.push(event.type),
      });
      const warmSetupMs = performance.now() - warmStarted;

      const proof = await exec(session, `test "$(cat '${proofPath}')" = ran && printf verified`);
      if (!proof.includes("verified")) throw new Error(`setup proof failed: ${proof}`);
      receipts.push({
        case: scriptCase.label,
        sample,
        scriptChars: script.length,
        scriptBytes: Buffer.byteLength(script, "utf8"),
        createMs,
        coldSetupMs,
        warmSetupMs,
        coldTerminal: terminal(coldEvents),
        warmTerminal: terminal(warmEvents),
      });
    } finally {
      if (session) {
        await terminateManagedSandboxSession(
          client,
          (session as { state?: unknown }).state,
          session,
        ).catch(() => undefined);
      }
      await rm(workspaceBaseDir, { recursive: true, force: true });
    }
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      modelCalls: 0,
      image,
      invariant:
        "Each fresh Docker sandbox executes the exact frozen setup once; the second invocation on that same box skips through the durable marker.",
      summaries: summarize(receipts),
      receipts,
    },
    null,
    2,
  )}\n`,
);

function setupScript(
  scriptCase: { scriptChars: number; content: "repeated" | "high-entropy" },
  proofPath: string,
): string {
  const prefix = `set -eu\nprintf ran > '${proofPath}'\n#`;
  const suffix = "\n";
  const remaining = scriptCase.scriptChars - prefix.length - suffix.length;
  const padding =
    scriptCase.content === "repeated" ? "界".repeat(remaining) : highEntropyAscii(remaining);
  const script = `${prefix}${padding}${suffix}`;
  if (script.length !== scriptCase.scriptChars) {
    throw new Error(`script has ${script.length} chars, expected ${scriptCase.scriptChars}`);
  }
  return script;
}

function highEntropyAscii(length: number): string {
  let state = 0x9e3779b9;
  let result = "";
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Shell-comment-safe printable ASCII. Avoid CR/LF so the payload remains
    // one comment and never changes the benchmark's setup behavior.
    result += String.fromCharCode(33 + ((state >>> 0) % 94));
  }
  return result;
}

async function exec(session: unknown, cmd: string): Promise<string> {
  const target = session as {
    exec?: (args: {
      cmd: string;
      yieldTimeMs: number;
      maxOutputTokens: number;
    }) => Promise<unknown>;
    execCommand?: (args: {
      cmd: string;
      yieldTimeMs: number;
      maxOutputTokens: number;
    }) => Promise<unknown>;
  };
  const run = target.exec ?? target.execCommand;
  if (!run) throw new Error("Docker sandbox session has no exec operation");
  const result = await run.call(target, { cmd, yieldTimeMs: 30_000, maxOutputTokens: 1_000 });
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as { output?: unknown; stdout?: unknown; stderr?: unknown };
  return [record.output, record.stdout, record.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function terminal(events: string[]): string {
  return events.find((event) => event !== "rig.setup.started") ?? "missing";
}

function summarize(allReceipts: Receipt[]) {
  const groups = new Map<string, Receipt[]>();
  for (const receipt of allReceipts) {
    const group = groups.get(receipt.case) ?? [];
    group.push(receipt);
    groups.set(receipt.case, group);
  }
  return [...groups.entries()].map(([label, group]) => ({
    case: label,
    scriptChars: group[0]!.scriptChars,
    scriptBytes: group[0]!.scriptBytes,
    createMedianMs: median(group.map((receipt) => receipt.createMs)),
    coldSetupMedianMs: median(group.map((receipt) => receipt.coldSetupMs)),
    warmSetupMedianMs: median(group.map((receipt) => receipt.warmSetupMs)),
  }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(3));
}

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const parsed = Number.parseInt(index < 0 ? "" : (process.argv[index + 1] ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArgument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? "" : (process.argv[index + 1] ?? "").trim();
  return value || fallback;
}
