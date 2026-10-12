import { createHash } from "node:crypto";
import { z } from "zod";
import { encodeNativeBrokerFrame, type NativeBrokerFrame } from "./native-command-broker-wire";
import type { DurableNativeBrokerTransport } from "./native-command-broker-transport";

const target = z.enum(["linux-amd64", "linux-arm64"]);
const pinSchema = z
  .object({
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z
      .number()
      .int()
      .min(64)
      .max(256 * 1024),
    target,
  })
  .strict();
const uint64 = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const helloSchema = z
  .object({
    protocol: z.literal("native-command-broker-v1"),
    sealedExec: z.literal("execveat"),
    pipeCapability: z.literal("native-subreaper-broker-channel-v1"),
    ptyCapability: z.literal("native-subreaper-broker-channel-pty-v1"),
    artifact: z
      .object({
        byteSize: z
          .number()
          .int()
          .min(64)
          .max(256 * 1024),
        target,
        seals: z.literal(15),
        device: uint64,
        inode: uint64.refine((value) => value !== "0"),
      })
      .strict(),
  })
  .strict();
export type NativeBrokerArtifactPin = z.infer<typeof pinSchema>;

function invalid(): never {
  throw new Error("Native broker bootstrap transcript is incomplete or mismatched");
}

/** Verifies the initial hello + complete artifact, not a later 'hello' request.
 * The input must be the exact authenticated initial provider stream already
 * committed in the durable journal. The pin comes from independent release
 * provenance. Neither this result nor a supplied hash authenticates creation,
 * enrolls a legacy group, grants command authority or qualifies a release. */
export function verifyNativeBrokerBootstrap(
  brokerId: string,
  expected: NativeBrokerArtifactPin,
  frames: readonly NativeBrokerFrame[],
) {
  const parsed = pinSchema.safeParse(expected);
  if (!parsed.success || frames.length < 2 || frames.length > 33) invalid();
  const pin = parsed.data,
    hash = createHash("sha256"),
    transcript = createHash("sha256");
  let hello: z.infer<typeof helloSchema> | undefined;
  let bytes = 0;
  for (const [index, frame] of frames.entries()) {
    const wire = encodeNativeBrokerFrame(frame);
    if (
      frame.direction !== "response" ||
      frame.brokerId !== brokerId ||
      frame.ownerEpoch !== 1 ||
      frame.sequence !== index + 1 ||
      frame.requestId !== brokerId ||
      frame.commandId !== null
    )
      invalid();
    transcript.update(wire);
    if (!hello) {
      if (frame.kind !== "hello" || frame.offset) invalid();
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
      } catch {
        invalid();
      }
      const result = helloSchema.safeParse(body);
      if (
        !result.success ||
        result.data.artifact.byteSize !== pin.byteSize ||
        result.data.artifact.target !== pin.target
      )
        invalid();
      hello = result.data;
    } else {
      if (
        frame.kind !== "artifact" ||
        !frame.payload.length ||
        frame.offset !== bytes ||
        frame.payload.length > pin.byteSize - bytes
      )
        invalid();
      bytes += frame.payload.length;
      hash.update(frame.payload);
    }
  }
  if (!hello || bytes !== pin.byteSize || hash.digest("hex") !== pin.artifactSha256) invalid();
  return Object.freeze({
    protocol: hello.protocol,
    brokerId,
    artifactSha256: pin.artifactSha256,
    byteSize: bytes,
    target: pin.target,
    seals: hello.artifact.seals,
    device: hello.artifact.device,
    inode: hello.artifact.inode,
    transcriptSha256: transcript.digest("hex"),
    lastSequence: frames.length,
    commandAdmission: false as const,
  });
}

/** Reconstructs exactly the prefix after a restart; later command frames do
 * not become bootstrap evidence. Incomplete prefixes stay unverified. */
export async function readNativeBrokerBootstrap(
  journal: DurableNativeBrokerTransport,
  expected: NativeBrokerArtifactPin,
) {
  const parsed = pinSchema.safeParse(expected);
  if (!parsed.success) invalid();
  const pin = parsed.data;
  const state = await journal.read();
  if (state.output.providerEof) invalid();
  const page = await journal.framesAfter(0, 33);
  if (page.providerEof) invalid();
  const prefix: NativeBrokerFrame[] = [];
  let bytes = 0;
  for (const frame of page.frames) {
    prefix.push(frame);
    if (frame.kind === "artifact") bytes += frame.payload.length;
    if (bytes >= pin.byteSize) break;
  }
  return verifyNativeBrokerBootstrap(state.input.brokerId, pin, prefix);
}
