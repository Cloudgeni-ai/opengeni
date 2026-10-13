import { createHash } from "node:crypto";
import {
  NativeBrokerArtifactPinSchema,
  verifyNativeBrokerBootstrap,
  type NativeBrokerArtifactPin,
} from "./native-command-broker-bootstrap";
import type { NativeBrokerChannel } from "./native-command-broker-driver";
import { planNativeBrokerOutputCapture } from "./native-command-broker-output";
import { initialNativeBrokerTransportState } from "./native-command-broker-transport";
import type { NativeBrokerFrame } from "./native-command-broker-wire";

export type NativeBrokerBootstrapEntry = Readonly<{
  kind: "frame" | "page";
  key: string;
  sequence: number | null;
  value: string;
}>;
const MAX_PAGES = 128;
const MAX_CAPTURE_BYTES = 1024 * 1024;
function invalid(): never {
  throw new Error("Native broker initial capture is incomplete or exceeds its bound");
}
function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Read-only capture before journal registration. The caller supplies an
 * independently authenticated INITIAL provider channel and release artifact
 * pin. This verifier does not authenticate a channel, inspect initial stderr,
 * qualify an image, admit commands or write/ACK any input. The channel must
 * honor AbortSignal; the deadline bounds observation, not process lifetime.
 * Persist the returned state AND entries atomically before using a journal. */
export async function captureNativeBrokerBootstrap(
  channel: Pick<NativeBrokerChannel, "sandboxId" | "taskId" | "output">,
  brokerId: string,
  expected: NativeBrokerArtifactPin,
  signal?: AbortSignal,
) {
  const pin = NativeBrokerArtifactPinSchema.parse(expected);
  const state = initialNativeBrokerTransportState({
    brokerId,
    sandboxId: channel.sandboxId,
    taskId: channel.taskId,
  });
  const deadline = AbortSignal.timeout(30_000);
  const observation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  observation.throwIfAborted();
  const pages = new Map<string, string>();
  const frames = new Map<number, string>();
  const prefix: NativeBrokerFrame[] = [];
  const entries: NativeBrokerBootstrapEntry[] = [];
  let pageCount = 0,
    capturedBytes = 0,
    artifactBytes = 0;
  for await (const supplied of channel.output("0-0", observation)) {
    observation.throwIfAborted();
    if (++pageCount > MAX_PAGES) invalid();
    // Preserve an immutable receipt, including provider page identity. No
    // await may expose its bytes to later mutation by the transport producer.
    const page = structuredClone(supplied);
    const value = JSON.stringify(page);
    capturedBytes += Buffer.byteLength(value);
    if (capturedBytes > MAX_CAPTURE_BYTES || page.eof) invalid();
    const plan = await planNativeBrokerOutputCapture(state.output, state.output.cursor, page, {
      entrySha256: async (id) => pages.get(id) ?? null,
      frameSha256: async (sequence) => frames.get(sequence) ?? null,
    });
    observation.throwIfAborted();
    for (const entry of plan.frames) {
      if (prefix.length >= 33) invalid();
      if (prefix.length === 0 ? entry.frame.kind !== "hello" : entry.frame.kind !== "artifact")
        invalid();
      prefix.push(entry.frame);
      if (entry.frame.kind === "artifact") artifactBytes += entry.frame.payload.length;
      if (artifactBytes > pin.byteSize) invalid();
      frames.set(entry.sequence, entry.sha256);
      entries.push(
        Object.freeze({
          kind: "frame",
          key: String(entry.sequence),
          sequence: entry.sequence,
          value: Buffer.from(entry.wireBase64, "base64").toString("ascii"),
        }),
      );
    }
    if (plan.page) {
      if (sha(value) !== plan.page.sha256) invalid();
      pages.set(plan.page.entryId, plan.page.sha256);
      entries.push(Object.freeze({ kind: "page", key: plan.page.entryId, sequence: null, value }));
    }
    state.output = plan.snapshot;
    if (artifactBytes === pin.byteSize) {
      // An unfinished extra frame is not an authenticated bootstrap boundary.
      if (state.output.partialBase64) invalid();
      const bootstrap = verifyNativeBrokerBootstrap(brokerId, pin, prefix);
      return Object.freeze({
        bootstrap,
        initialState: Object.freeze({
          ...state,
          input: Object.freeze(state.input),
          output: Object.freeze(state.output),
        }),
        entries: Object.freeze(entries),
      });
    }
  }
  invalid();
}
