import { unlink } from "node:fs/promises";
import { getSettings } from "@opengeni/config";
import {
  recordingStorageKey,
  uploadRecordingArtifact,
  type RecordingProcess,
} from "@opengeni/runtime";
import { createObjectStorage } from "@opengeni/storage";

if (process.env.OPENGENI_RECORDING_UPLOAD_PROFILE !== "1") {
  throw new Error("Set OPENGENI_RECORDING_UPLOAD_PROFILE=1 to authorize the temporary storage PUT");
}

const MIB = 1024 * 1024;
const sizeBytes = positiveInteger("OPENGENI_RECORDING_UPLOAD_BYTES", 32 * MIB);
const hardLimitMiB = positiveNumber("OPENGENI_RECORDING_UPLOAD_HARD_LIMIT_MIB", 50);
const settings = getSettings();
const storage = createObjectStorage(settings);
if (!storage) throw new Error("Object storage is not configured");

const recordingId = crypto.randomUUID();
const path = `/tmp/opengeni-recording-upload-profile-${recordingId}.mp4`;
const key = recordingStorageKey("operator-profile", "operator-profile", recordingId, "h264-mp4");
const proc: RecordingProcess = {
  recordingId,
  codec: "h264-mp4",
  boxPath: path,
  pidFile: `${path}.pid`,
  dimensions: [1280, 800],
  framerate: 15,
  startedAt: Date.now(),
  display: ":0",
};

try {
  await runLocal(`truncate -s ${sizeBytes} ${shellQuote(path)}`);
  const upload = await storage.createPutUrl({ key, contentType: "video/mp4" });
  const baselineMiB = await cgroupMemoryMiB();
  const samples: number[] = [baselineMiB];
  const sampler = setInterval(() => {
    void cgroupMemoryMiB().then((value) => samples.push(value));
  }, 25);
  let metadata: Awaited<ReturnType<typeof uploadRecordingArtifact>>;
  try {
    metadata = await uploadRecordingArtifact(
      {
        execCommand: async ({ cmd }: { cmd: string }) => {
          const result = await runLocal(cmd);
          return [
            "Chunk ID: recording-upload-profile",
            `Process exited with code ${result.exitCode}`,
            "Output:",
            result.output,
          ].join("\n");
        },
      },
      proc,
      {
        url: upload.url,
        requiredHeaders: upload.requiredHeaders,
        maxBytes: sizeBytes,
      },
    );
  } finally {
    clearInterval(sampler);
    samples.push(await cgroupMemoryMiB());
  }
  const stored = await storage.getObjectBytes(key);
  if (!stored || stored.bytes.byteLength !== sizeBytes) {
    throw new Error(
      `Stored recording size mismatch: expected ${sizeBytes}, got ${stored?.bytes.byteLength ?? 0}`,
    );
  }
  const peakMiB = Math.max(...samples);
  const incrementalMiB = peakMiB - baselineMiB;
  const result = {
    schemaVersion: 1,
    productionRevision: settings.deploymentRevision,
    sizeBytes,
    metadata,
    memory: {
      baselineCgroupMiB: rounded(baselineMiB),
      peakCgroupMiB: rounded(peakMiB),
      incrementalCgroupMiB: rounded(incrementalMiB),
    },
    thresholds: {
      hardLimitMiB,
      hardLimitMet: incrementalMiB <= hardLimitMiB,
    },
  };
  console.log(`OPENGENI_RECORDING_UPLOAD_RESULT=${JSON.stringify(result)}`);
  if (!result.thresholds.hardLimitMet) process.exitCode = 2;
} finally {
  await storage.deleteObject(key).catch(() => undefined);
  await unlink(path).catch(() => undefined);
}

async function runLocal(command: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: [stdout, stderr].filter(Boolean).join("\n") };
}

async function cgroupMemoryMiB(): Promise<number> {
  const raw = await Bun.file("/sys/fs/cgroup/memory.current").text();
  const bytes = Number(raw.trim());
  if (!Number.isFinite(bytes)) throw new Error(`Invalid cgroup memory.current value: ${raw}`);
  return bytes / MIB;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}
