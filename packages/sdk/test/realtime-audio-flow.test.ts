import { describe, expect, test } from "bun:test";
import {
  realtimeAudioEnergy,
  watchRealtimeAudioFlow,
  type RealtimeAudioFlowIssue,
} from "../src/realtime-audio-flow";

function statsReport(input: number | null, output: number | null): Map<string, unknown> {
  // Native WebRTC hands back a Map; browsers an RTCStatsReport (also Map-like).
  const report = new Map<string, unknown>();
  report.set("transport", { type: "transport", bytesSent: 10 });
  if (input !== null) {
    report.set("source", { type: "media-source", kind: "audio", totalAudioEnergy: input });
  }
  if (output !== null) {
    report.set("inbound", { type: "inbound-rtp", kind: "audio", totalAudioEnergy: output });
  }
  return report;
}

function harness(options: { inputMuted?: () => boolean; outputMuted?: () => boolean } = {}) {
  let clock = 0;
  let input: number | null = 0;
  let output: number | null = 0;
  let tick: (() => void) | null = null;
  let cleared = false;
  const issues: Array<RealtimeAudioFlowIssue | null> = [];
  const watch = watchRealtimeAudioFlow({
    peerConnection: { getStats: async () => statsReport(input, output) as RTCStatsReport },
    inputMuted: options.inputMuted ?? (() => false),
    outputMuted: options.outputMuted ?? (() => false),
    onIssue: (issue) => issues.push(issue),
    now: () => clock,
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
  });
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };
  return {
    watch,
    issues,
    cleared: () => cleared,
    setInput: (value: number | null) => (input = value),
    setOutput: (value: number | null) => (output = value),
    /** Advance one poll of a second, optionally adding captured or received energy. */
    async second(add: { input?: number; output?: number } = {}) {
      await settle();
      clock += 1_000;
      if (input !== null && add.input) input += add.input;
      if (output !== null && add.output) output += add.output;
      tick?.();
      await settle();
    },
    settle,
  };
}

describe("realtime audio flow", () => {
  test("reads captured and received energy from a native Map report", () => {
    expect(realtimeAudioEnergy(statsReport(0.5, 0.25))).toEqual({ input: 0.5, output: 0.25 });
    expect(realtimeAudioEnergy(statsReport(null, null))).toEqual({ input: null, output: null });
    expect(
      realtimeAudioEnergy({
        a: { type: "media-source", mediaType: "audio", totalAudioEnergy: 0.1 },
        b: { type: "media-source", kind: "video", totalAudioEnergy: 9 },
      }),
    ).toEqual({ input: 0.1, output: null });
  });

  test("a microphone that hands over only silence is reported, and clears once sound arrives", async () => {
    const call = harness();
    for (let second = 0; second < 7; second += 1) await call.second();
    expect(call.issues).toEqual([]);
    await call.second();
    expect(call.issues).toEqual(["no_input_audio"]);
    await call.second({ input: 1e-4 });
    expect(call.issues).toEqual(["no_input_audio", null]);
  });

  test("a quiet room still counts as sound; only digital silence is flagged", async () => {
    const call = harness();
    // One 16-bit step of noise for a second.
    for (let second = 0; second < 20; second += 1) await call.second({ input: 1e-9 });
    expect(call.issues).toEqual([]);
  });

  test("a muted microphone is silent on purpose", async () => {
    let muted = true;
    const call = harness({ inputMuted: () => muted });
    for (let second = 0; second < 20; second += 1) await call.second();
    expect(call.issues).toEqual([]);
    muted = false;
    for (let second = 0; second < 9; second += 1) await call.second();
    expect(call.issues).toEqual(["no_input_audio"]);
  });

  test("a reply that played no audio is reported, and clears once audio plays", async () => {
    const call = harness();
    await call.second({ input: 1e-3 });
    call.watch.assistantReplied();
    for (let second = 0; second < 3; second += 1) await call.second({ input: 1e-3 });
    expect(call.issues).toEqual(["output_silent"]);
    await call.second({ input: 1e-3, output: 1e-3 });
    expect(call.issues).toEqual(["output_silent", null]);
  });

  test("a reply whose audio played before its transcript is not flagged", async () => {
    const call = harness();
    await call.second({ input: 1e-3, output: 2e-3 });
    await call.second({ input: 1e-3, output: 2e-3 });
    call.watch.assistantReplied();
    for (let second = 0; second < 5; second += 1) await call.second({ input: 1e-3 });
    expect(call.issues).toEqual([]);
  });

  test("received audio that only appears once the reply streams counts from zero", async () => {
    const call = harness();
    call.setOutput(null);
    await call.second({ input: 1e-3 });
    call.setOutput(3e-3);
    await call.second({ input: 1e-3 });
    call.watch.assistantReplied();
    for (let second = 0; second < 4; second += 1) await call.second({ input: 1e-3 });
    expect(call.issues).toEqual([]);
  });

  test("replies the person muted are not flagged", async () => {
    const call = harness({ outputMuted: () => true });
    call.watch.assistantReplied();
    for (let second = 0; second < 5; second += 1) await call.second({ input: 1e-3 });
    expect(call.issues).toEqual([]);
  });

  test("platforms without audio energy report nothing", async () => {
    const call = harness();
    call.setInput(null);
    call.setOutput(null);
    call.watch.assistantReplied();
    for (let second = 0; second < 20; second += 1) await call.second();
    expect(call.issues).toEqual([]);
  });

  test("stopping ends polling", async () => {
    const call = harness();
    call.watch.stop();
    expect(call.cleared()).toBe(true);
    for (let second = 0; second < 20; second += 1) await call.second();
    expect(call.issues).toEqual([]);
  });
});
