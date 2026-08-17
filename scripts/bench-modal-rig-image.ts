#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";

import type { Settings } from "@opengeni/config";
import { getSettings } from "@opengeni/config";
import {
  buildImmutableProviderImage,
  createSandboxClient,
  deleteModalCheckpointSnapshot,
  runRigSetupHook,
  terminateModalSandboxById,
} from "@opengeni/runtime";
import { rigProviderImageContentMarkerCommand } from "../apps/worker/src/activities/rig-verification";

const MAX_SETUP_SCRIPT_CHARS = 131_072;
const LARGE_PAYLOAD_BYTES = integerArgument("--large-payload-bytes", 256 * 1024 * 1024);
const live = process.argv.includes("--live");

if (!live) {
  throw new Error("real Modal capacity is gated; rerun with --live");
}
if (LARGE_PAYLOAD_BYTES < 0 || LARGE_PAYLOAD_BYTES > 1024 * 1024 * 1024) {
  throw new Error("--large-payload-bytes must be between 0 and 1073741824");
}

const configured = getSettings();
const settings: Settings = {
  ...configured,
  sandboxBackend: "modal",
  modalAppName: process.env.OPENGENI_MODAL_SMOKE_APP ?? "opengeni-rig-image-perf-lab",
  modalImageRef: process.env.OPENGENI_MODAL_SMOKE_IMAGE ?? "python:3.12-slim",
  modalImageId: undefined,
  modalWorkspacePersistence: "snapshot_directory",
  modalTimeoutSeconds: 900,
  modalIdleTimeoutSeconds: 300,
};

type CaseResult = {
  case: string;
  setupScriptChars: number;
  setupScriptBytes: number;
  persistentPayloadBytes: number;
  baseCreateMs: number;
  fallbackSetupMs: number;
  nativeSetupWrite: {
    count: number;
    bytes: number[];
    durationsMs: number[];
  };
  snapshotMs: number;
  providerImageId: string;
  coldBoots: Array<{
    createMs: number;
    markerProbeMs: number;
    terminalEvent: string;
  }>;
  cleanup: {
    baseBox: "deleted" | "not_created";
    imageBoxes: number;
    providerImage: "deleted" | "not_created" | "not_found";
  };
};

const results: CaseResult[] = [];
for (const descriptor of [
  { label: "small", scriptChars: 512, payloadBytes: 0, padding: "x" },
  {
    label: "max-unicode-plus-large-image",
    scriptChars: MAX_SETUP_SCRIPT_CHARS,
    payloadBytes: LARGE_PAYLOAD_BYTES,
    padding: "界",
  },
] as const) {
  results.push(await runCase(descriptor));
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      invariant:
        "The complete setup executes once before snapshot publication; every independently cold-booted provider image retains its bytes and skips setup through the exact trusted content marker.",
      modelCalls: 0,
      results,
    },
    null,
    2,
  )}\n`,
);

async function runCase(descriptor: {
  label: string;
  scriptChars: number;
  payloadBytes: number;
  padding: string;
}): Promise<CaseResult> {
  const runId = randomUUID();
  const receipt = `/var/tmp/opengeni-rig-bench-${runId}.log`;
  const payload = `/opt/opengeni-rig-bench-${runId}.bin`;
  const setupScript = makeSetupScript(descriptor, receipt, payload);
  const contentHash = `sha256:${createHash("sha256").update(setupScript, "utf8").digest("hex")}`;
  const rigSetup = {
    rigId: "11111111-1111-4111-8111-111111111111",
    versionId: runId,
    rigName: `modal-rig-benchmark-${descriptor.label}`,
    script: setupScript,
    timeoutMs: 180_000,
    contentHash,
  };
  const baseClient = createSandboxClient(settings);
  let baseSandboxId: string | null = null;
  let built: Awaited<ReturnType<typeof buildImmutableProviderImage>> = null;
  const imageSandboxIds: string[] = [];
  let imageClient: ReturnType<typeof createSandboxClient> | null = null;
  let completed: Omit<CaseResult, "cleanup"> | null = null;
  const cleanup: CaseResult["cleanup"] = {
    baseBox: "not_created",
    imageBoxes: 0,
    providerImage: "not_created",
  };

  try {
    const baseCreateStarted = performance.now();
    const baseSession = await baseClient.create!();
    const baseCreateMs = performance.now() - baseCreateStarted;
    baseSandboxId = sandboxIdFromSession(baseSession);

    const nativeSetupWrite = instrumentSandboxWrites(baseSession);

    const fallbackStarted = performance.now();
    await runRigSetupHook(baseSession, { environment: {}, runAs: "root", rigSetup });
    const fallbackSetupMs = performance.now() - fallbackStarted;
    await assertBox(baseSession, receipt, payload, descriptor.payloadBytes);

    await exec(baseSession, rigProviderImageContentMarkerCommand(contentHash));
    const snapshotStarted = performance.now();
    built = await buildImmutableProviderImage({
      backend: "modal",
      settings,
      session: baseSession,
      requestId: randomUUID(),
      timeoutMs: settings.sandboxSnapshotTimeoutMs,
    });
    const snapshotMs = performance.now() - snapshotStarted;
    if (!built?.imageId || !built.providerBindingKey) {
      throw new Error("Modal provider image benchmark received no owned image identity");
    }

    const imageSettings: Settings = {
      ...settings,
      modalImageRef: undefined,
      modalImageId: built.imageId,
      modalWorkspacePersistence: "snapshot_directory",
    };
    imageClient = createSandboxClient(imageSettings);
    const coldBoots: CaseResult["coldBoots"] = [];
    for (let sample = 0; sample < 2; sample += 1) {
      const createStarted = performance.now();
      const session = await imageClient.create!();
      const createMs = performance.now() - createStarted;
      imageSandboxIds.push(sandboxIdFromSession(session));
      const sessionImageId = (session.state as { imageId?: unknown }).imageId;
      if (sessionImageId !== built.imageId) {
        throw new Error(
          `provider image identity mismatch: expected ${built.imageId}, got ${String(sessionImageId)}`,
        );
      }
      const events: string[] = [];
      const probeStarted = performance.now();
      await runRigSetupHook(session, {
        environment: {},
        runAs: "root",
        rigSetup: { ...rigSetup, verifiedProviderImageId: built.imageId },
        onRuntimeEvent: (event) => events.push(event.type),
      });
      const markerProbeMs = performance.now() - probeStarted;
      await assertBox(session, receipt, payload, descriptor.payloadBytes);
      const terminalEvent = events.find((type) => type !== "rig.setup.started") ?? "missing";
      if (terminalEvent !== "rig.setup.skipped") {
        throw new Error(`provider image reran setup instead of skipping: ${events.join(",")}`);
      }
      coldBoots.push({ createMs, markerProbeMs, terminalEvent });
    }

    completed = {
      case: descriptor.label,
      setupScriptChars: setupScript.length,
      setupScriptBytes: Buffer.byteLength(setupScript, "utf8"),
      persistentPayloadBytes: descriptor.payloadBytes,
      baseCreateMs,
      fallbackSetupMs,
      nativeSetupWrite: nativeSetupWrite.measurement,
      snapshotMs,
      providerImageId: built.imageId,
      coldBoots,
    };
  } finally {
    if (imageSandboxIds.length > 0) {
      const deleted = await Promise.allSettled(
        imageSandboxIds
          .reverse()
          .map(async (sandboxId) => await terminateModalSandboxById(settings, sandboxId)),
      );
      cleanup.imageBoxes = deleted.filter(
        (result) => result.status === "fulfilled" && result.value,
      ).length;
    }
    if (baseSandboxId) {
      await terminateModalSandboxById(settings, baseSandboxId);
      cleanup.baseBox = "deleted";
    }
    if (built?.imageId && built.providerBindingKey) {
      cleanup.providerImage = await deleteModalCheckpointSnapshot(
        settings,
        built.providerBindingKey,
        built.imageId,
      );
    }
  }
  if (!completed) throw new Error("Modal provider image benchmark did not complete");
  return { ...completed, cleanup };
}

function instrumentSandboxWrites(session: unknown): {
  measurement: CaseResult["nativeSetupWrite"];
} {
  const target = session as {
    writeSandboxFile?: (path: string, content: string | Uint8Array) => Promise<void>;
  };
  const original = target.writeSandboxFile?.bind(target);
  if (!original) {
    return { measurement: { count: 0, bytes: [], durationsMs: [] } };
  }
  const measurement: CaseResult["nativeSetupWrite"] = {
    count: 0,
    bytes: [],
    durationsMs: [],
  };
  target.writeSandboxFile = async (path, content) => {
    const bytes =
      typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
    const startedAt = performance.now();
    try {
      await original(path, content);
    } finally {
      measurement.count += 1;
      measurement.bytes.push(bytes);
      measurement.durationsMs.push(Number((performance.now() - startedAt).toFixed(3)));
    }
  };
  return { measurement };
}

function makeSetupScript(
  descriptor: { scriptChars: number; payloadBytes: number; padding: string },
  receipt: string,
  payload: string,
): string {
  const prefix = [
    "set -eu",
    `printf 'ran\\n' >> '${receipt}'`,
    descriptor.payloadBytes > 0
      ? `head -c ${descriptor.payloadBytes} /dev/urandom > '${payload}'`
      : `: > '${payload}'`,
    `test "$(wc -l < '${receipt}')" -eq 1`,
    `test "$(wc -c < '${payload}')" -eq ${descriptor.payloadBytes}`,
    "#",
  ].join("\n");
  const suffix = "\n";
  const remaining = descriptor.scriptChars - prefix.length - suffix.length;
  if (remaining < 0) throw new Error("rig setup benchmark case is too small");
  const script = `${prefix}${descriptor.padding.repeat(remaining)}${suffix}`;
  if (script.length !== descriptor.scriptChars) {
    throw new Error(`setup script has ${script.length} chars, expected ${descriptor.scriptChars}`);
  }
  return script;
}

async function assertBox(
  session: unknown,
  receipt: string,
  payload: string,
  payloadBytes: number,
): Promise<void> {
  const output = await exec(
    session,
    `test "$(wc -l < '${receipt}')" -eq 1 && test "$(wc -c < '${payload}')" -eq ${payloadBytes} && printf verified`,
  );
  if (!output.includes("verified"))
    throw new Error(`provider image verification failed: ${output}`);
}

async function exec(session: unknown, command: string): Promise<string> {
  const target = session as {
    exec?: (input: {
      cmd: string;
      yieldTimeMs: number;
      maxOutputTokens: number;
      runAs?: string;
    }) => Promise<unknown>;
    execCommand?: (input: {
      cmd: string;
      yieldTimeMs: number;
      maxOutputTokens: number;
      runAs?: string;
    }) => Promise<unknown>;
  };
  const run = target.exec ?? target.execCommand;
  if (!run) throw new Error("Modal session exposes no exec seam");
  const result = await run.call(target, {
    cmd: command,
    runAs: "root",
    yieldTimeMs: 180_000,
    maxOutputTokens: 2_000,
  });
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const record = result as { output?: unknown; stdout?: unknown; stderr?: unknown };
    return [record.output, record.stdout, record.stderr]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  }
  return String(result ?? "");
}

function sandboxIdFromSession(session: unknown): string {
  const sandboxId = (session as { state?: { sandboxId?: unknown } }).state?.sandboxId;
  if (typeof sandboxId !== "string" || !sandboxId) {
    throw new Error("Modal benchmark session has no sandbox id");
  }
  return sandboxId;
}

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}
