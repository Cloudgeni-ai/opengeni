// Notice when a live voice call is silent on one side, from the peer
// connection's own audio statistics. A call can be connected and healthy
// while the microphone hands WebRTC nothing but silence, or while replies
// arrive and are never played; without this the person hears nothing and
// sees nothing wrong.

/** What is wrong with the audio of a live call, if anything. */
export type RealtimeAudioFlowIssue =
  /** The microphone delivers no sound at all (digital silence or no frames). */
  | "no_input_audio"
  /** A reply was produced but none of its audio was played. */
  | "output_silent";

export type RealtimeAudioFlowWatchOptions = {
  peerConnection: Pick<RTCPeerConnection, "getStats">;
  inputMuted(): boolean;
  outputMuted(): boolean;
  /** Called when the issue changes; null once audio flows again. */
  onIssue(issue: RealtimeAudioFlowIssue | null): void;
  now?: (() => number) | undefined;
  setInterval?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  clearInterval?: ((handle: unknown) => void) | undefined;
  pollIntervalMs?: number | undefined;
  /** How long an unmuted microphone may stay completely silent. */
  inputSilenceMs?: number | undefined;
  /** How long after a finished reply its audio must have played. */
  replyGraceMs?: number | undefined;
};

export type RealtimeAudioFlowWatch = {
  /** The assistant finished a spoken reply (its transcript is final). */
  assistantReplied(): void;
  stop(): void;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_INPUT_SILENCE_MS = 8_000;
const DEFAULT_REPLY_GRACE_MS = 3_000;
// Energy is the sum of squared levels (0..1) times seconds. One step of
// 16-bit noise for a second is about 1e-9, so anything a live microphone
// picks up exceeds this; only digital silence or no frames stays below it.
const INPUT_ENERGY_EPSILON = 1e-10;
// Far below anything audible: a spoken reply adds about 1e-3 per second.
const OUTPUT_ENERGY_EPSILON = 1e-6;

type AudioSample = { input: number | null; output: number | null };

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statsValues(report: unknown): unknown[] {
  if (!report || typeof report !== "object") return [];
  const values: unknown[] = [];
  const iterable = report as { forEach?: (callback: (value: unknown) => void) => void };
  if (typeof iterable.forEach === "function") {
    iterable.forEach((value) => values.push(value));
    return values;
  }
  return Object.values(report);
}

/** Total captured and received audio energy, where the platform reports it. */
export function realtimeAudioEnergy(report: unknown): AudioSample {
  let input: number | null = null;
  let output: number | null = null;
  for (const value of statsValues(report)) {
    if (!value || typeof value !== "object") continue;
    const stat = value as Record<string, unknown>;
    const kind = stat.kind ?? stat.mediaType;
    if (kind !== "audio") continue;
    const energy = finite(stat.totalAudioEnergy);
    if (energy === null) continue;
    if (stat.type === "media-source") input = (input ?? 0) + energy;
    else if (stat.type === "inbound-rtp") output = (output ?? 0) + energy;
  }
  return { input, output };
}

/**
 * Poll the call's audio statistics and report when the microphone stays
 * completely silent while unmuted, or when a finished reply played no audio.
 * Platforms whose statistics lack audio energy report nothing.
 */
export function watchRealtimeAudioFlow(
  options: RealtimeAudioFlowWatchOptions,
): RealtimeAudioFlowWatch {
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setInterval ?? ((callback, delay) => globalThis.setInterval(callback, delay));
  const clearTimer =
    options.clearInterval ??
    ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  const inputSilenceMs = options.inputSilenceMs ?? DEFAULT_INPUT_SILENCE_MS;
  const replyGraceMs = options.replyGraceMs ?? DEFAULT_REPLY_GRACE_MS;

  let stopped = false;
  let polling = false;
  let reported: RealtimeAudioFlowIssue | null = null;
  let inputEnergy: number | null = null;
  let inputSilentSince: number | null = null;
  let inputSilent = false;
  let outputEnergy: number | null = null;
  // Received energy when the last reply was checked (zero before the first:
  // the received stream starts at zero). A reply's audio plays before its
  // transcript is final, so a check compares against the previous one.
  let outputEnergyAtLastReply: number | null = null;
  let replyDueAt: number | null = null;
  let outputSilent = false;

  const report = (): void => {
    const next: RealtimeAudioFlowIssue | null = outputSilent
      ? "output_silent"
      : inputSilent
        ? "no_input_audio"
        : null;
    if (next === reported) return;
    reported = next;
    options.onIssue(next);
  };

  const observeInput = (energy: number | null, at: number): void => {
    if (energy === null) return;
    const previous = inputEnergy;
    inputEnergy = energy;
    if (options.inputMuted()) {
      // A muted track sends silence on purpose.
      inputSilentSince = null;
      inputSilent = false;
      return;
    }
    if (previous !== null && energy - previous > INPUT_ENERGY_EPSILON) {
      inputSilentSince = null;
      inputSilent = false;
      return;
    }
    inputSilentSince ??= at;
    if (at - inputSilentSince >= inputSilenceMs) inputSilent = true;
  };

  const observeOutput = (energy: number | null, at: number): void => {
    if (energy === null) return;
    const previous = outputEnergy;
    outputEnergy = energy;
    outputEnergyAtLastReply ??= 0;
    if (outputSilent && previous !== null && energy - previous > OUTPUT_ENERGY_EPSILON) {
      outputSilent = false;
    }
    if (replyDueAt === null || at < replyDueAt) return;
    replyDueAt = null;
    const played = energy - outputEnergyAtLastReply > OUTPUT_ENERGY_EPSILON;
    outputEnergyAtLastReply = energy;
    // Muted on purpose: the person chose not to hear it.
    if (options.outputMuted()) return;
    outputSilent = !played;
  };

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const sample = realtimeAudioEnergy(await options.peerConnection.getStats());
      if (stopped) return;
      const at = now();
      observeInput(sample.input, at);
      observeOutput(sample.output, at);
      report();
    } catch {
      // Statistics are best effort; a closing connection may refuse them.
    } finally {
      polling = false;
    }
  };

  const timer = setTimer(() => void poll(), options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  void poll();

  return {
    assistantReplied() {
      if (stopped) return;
      replyDueAt ??= now() + replyGraceMs;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
    },
  };
}
