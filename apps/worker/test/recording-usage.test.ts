import { describe, expect, test } from "bun:test";
import type { Observability } from "@opengeni/observability";
import { prepareRecordingTrackAudio } from "../src/activities/recording-audio";
import {
  measureRecordingStage,
  RecordingUsage,
  reportRecordingProcessing,
  runMeasuredCommand,
  withRecordingUsage,
} from "../src/activities/recording-usage";
import { ffmpegPath, hasFfmpeg, opusWebm } from "./recording-audio-fixtures";

function recordingObservability() {
  const counters: Array<{ name: string; labels: Record<string, unknown>; amount: number }> = [];
  const histograms: Array<{ name: string; labels: Record<string, unknown>; value: number }> = [];
  const logs: Array<{ message: string; attributes: Record<string, unknown> }> = [];
  const observability = {
    incrementCounter(input: { name: string; labels?: Record<string, unknown>; amount?: number }) {
      counters.push({ name: input.name, labels: input.labels ?? {}, amount: input.amount ?? 1 });
    },
    observeHistogram(input: { name: string; labels?: Record<string, unknown>; value: number }) {
      histograms.push({ name: input.name, labels: input.labels ?? {}, value: input.value });
    },
    info(message: string, attributes: Record<string, unknown> = {}) {
      logs.push({ message, attributes });
    },
  } as unknown as Observability;
  return { observability, counters, histograms, logs };
}

describe("recording usage", () => {
  test.skipIf(!hasFfmpeg)("counts the CPU and memory of the programs a stage runs", async () => {
    const usage = new RecordingUsage();
    const bytes = opusWebm(3);
    await withRecordingUsage(usage, () =>
      measureRecordingStage("prepare", () =>
        prepareRecordingTrackAudio({
          chunks: [
            { chunkNumber: 0, startMilliseconds: 0, durationMilliseconds: 3_000, objectKey: "k" },
          ],
          mimeType: "audio/webm",
          readChunk: async () => bytes,
          ffmpegPath,
        }),
      ),
    );
    await withRecordingUsage(usage, () =>
      measureRecordingStage("segment", () => runMeasuredCommand(ffmpegPath, ["-version"])),
    );
    const prepare = usage.stages().get("prepare")!;
    expect(prepare.processes).toBe(1);
    expect(prepare.cpuSeconds).toBeGreaterThan(0);
    expect(prepare.peakMemoryBytes).toBeGreaterThan(1024 * 1024);
    expect(prepare.memoryByteSeconds).toBeGreaterThan(0);
    expect(prepare.wallSeconds).toBeGreaterThan(0);
    expect(usage.stages().get("segment")?.processes).toBe(1);
  });

  test("work outside a recording, or outside a stage, is not counted", async () => {
    const usage = new RecordingUsage();
    await measureRecordingStage("prepare", async () => undefined);
    await withRecordingUsage(usage, () => runMeasuredCommand("true", []));
    expect(usage.stages().size).toBe(0);
    const missing = await withRecordingUsage(usage, () =>
      measureRecordingStage("segment", () => runMeasuredCommand("/nonexistent/ffmpeg", [])),
    );
    expect(missing.spawnError).toBe(true);
  });

  test("a report publishes each stage under the path that paid for it", () => {
    const usage = new RecordingUsage();
    usage.addWall("transcribe", 12);
    usage.addWall("diarize", 4);
    usage.addProcesses("diarize", [
      { cpuSeconds: 3, maxRssBytes: 100 * 1024 * 1024, wallSeconds: 4 },
      { cpuSeconds: 1, maxRssBytes: 20 * 1024 * 1024, wallSeconds: 2 },
    ]);
    const { observability, counters, histograms, logs } = recordingObservability();
    reportRecordingProcessing(
      observability,
      {
        purpose: "meeting",
        provider: "scribe",
        model: "v2",
        funding: "workspace_key",
        outcome: "complete",
        errorCode: null,
        audioSeconds: 600,
        wallSeconds: 20,
        queueSeconds: 1.5,
        preparedBytes: 2_000_000,
        providerCostUsd: 0.04,
        credits: null,
        diarization: "ours",
        speakers: 3,
        ourDiarizerFailed: false,
        stages: usage.stages(),
      },
      { recordingId: "r1" },
    );
    const cpu = counters.filter(
      (item) => item.name === "opengeni_recording_stage_cpu_seconds_total",
    );
    expect(cpu).toEqual([
      {
        name: "opengeni_recording_stage_cpu_seconds_total",
        labels: {
          purpose: "meeting",
          provider: "scribe",
          model: "v2",
          funding: "workspace_key",
          stage: "transcribe",
        },
        amount: 0,
      },
      {
        name: "opengeni_recording_stage_cpu_seconds_total",
        labels: {
          purpose: "meeting",
          provider: "scribe",
          model: "v2",
          funding: "workspace_key",
          stage: "diarize",
        },
        amount: 4,
      },
    ]);
    // Programs that run together hold their memory at the same time.
    expect(
      histograms.find((item) => item.name === "opengeni_recording_stage_peak_memory_bytes")?.value,
    ).toBe(120 * 1024 * 1024);
    expect(
      counters.find((item) => item.name === "opengeni_recording_audio_seconds_total")?.amount,
    ).toBe(600);
    expect(
      counters.find((item) => item.name === "opengeni_recording_provider_cost_usd_total")?.amount,
    ).toBe(0.04);
    expect(counters.find((item) => item.name === "opengeni_recording_stored_bytes_total")).toEqual({
      name: "opengeni_recording_stored_bytes_total",
      labels: { purpose: "meeting", kind: "prepared" },
      amount: 2_000_000,
    });
    expect(logs[0]).toMatchObject({
      message: "recording processed",
      attributes: { recordingId: "r1", diarizeCpuSeconds: 4, transcribeWallSeconds: 12 },
    });
  });

  test("a failed or retried version counts no audio", () => {
    const { observability, counters } = recordingObservability();
    reportRecordingProcessing(
      observability,
      {
        purpose: "dictation",
        provider: "host",
        model: "",
        funding: "none",
        outcome: "retry",
        errorCode: "voice_unavailable",
        audioSeconds: 0,
        wallSeconds: 1,
        queueSeconds: null,
        preparedBytes: 0,
        providerCostUsd: null,
        credits: null,
        diarization: null,
        speakers: null,
        ourDiarizerFailed: false,
        stages: new RecordingUsage().stages(),
      },
      {},
    );
    expect(counters.map((item) => item.name)).toEqual(["opengeni_recording_transcripts_total"]);
    expect(counters[0]!.labels).toMatchObject({
      outcome: "retry",
      error_code: "voice_unavailable",
    });
  });
});
