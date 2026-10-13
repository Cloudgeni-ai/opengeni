import { createHash } from "node:crypto";
import { z } from "zod";
import { NativeBrokerFrameDecoder, type NativeBrokerFrame } from "./native-command-broker-wire";

const maximumArtifactBytes = 256 * 1024;
const maximumTranscriptBytes = 512 * 1024;
const uint64 = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const target = z.enum(["linux-amd64", "linux-arm64"]);
const expectedSchema = z
  .object({
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteSize: z.number().int().min(64).max(maximumArtifactBytes),
    target,
  })
  .strict();
const helloSchema = z
  .object({
    protocol: z.literal("native-command-broker-preflight-v1"),
    state: z.literal("preflight_only"),
    sealedExec: z.literal("execveat"),
    pipeCapability: z.literal("native-subreaper-v1"),
    ptyCapability: z.literal("native-subreaper-pty-v1"),
    artifact: z
      .object({
        protocol: z.literal("native-artifact-keeper-v1"),
        byteSize: z.number().int().min(64).max(maximumArtifactBytes),
        seals: z.literal(15),
        target,
        static: z.literal(true),
        device: uint64,
        inode: uint64.refine((value) => value !== "0"),
      })
      .strict(),
  })
  .strict();
const endSchema = z
  .object({
    preflightComplete: z.literal(true),
    commandAdmission: z.literal(false),
  })
  .strict();

export type NativeBrokerPreflightArtifactPin = z.infer<typeof expectedSchema>;
export type NativeBrokerPreflightObservation = Readonly<{
  protocol: "native-command-broker-preflight-v1";
  brokerId: string;
  artifactSha256: string;
  byteSize: number;
  target: NativeBrokerPreflightArtifactPin["target"];
  device: string;
  inode: string;
  frameCount: number;
  initialProcessExitCode: 0;
  commandAdmission: false;
}>;

function invalid(): never {
  // Never include a frame, claimed identity, raw provider error or artifact bytes.
  throw new Error("Native broker preflight evidence is invalid or incomplete");
}

/** Bounded diagnostic verification ONLY. The artifact pin and initial-process
 * transport must come from independently authenticated provenance. This class
 * neither establishes that provenance nor returns runtime admission authority.
 * Provider reconnect/dedup must supply one complete exact transcript; partial
 * logs, TaskExec output or an exit frame alone cannot complete this observation.
 */
export class NativeBrokerPreflightCollector {
  private readonly decoder: NativeBrokerFrameDecoder;
  private readonly expected: NativeBrokerPreflightArtifactPin;
  private readonly hash = createHash("sha256");
  private hello: z.infer<typeof helloSchema> | undefined;
  private sequence = 0;
  private artifactBytes = 0;
  private transcriptBytes = 0;
  private ended = false;
  private failed = false;
  private finished = false;

  constructor(
    private readonly brokerId: string,
    expected: NativeBrokerPreflightArtifactPin,
  ) {
    const parsed = expectedSchema.safeParse(expected);
    if (!parsed.success) invalid();
    this.expected = parsed.data;
    this.decoder = new NativeBrokerFrameDecoder(brokerId);
  }

  push(stream: "stdout" | "stderr", bytes: Uint8Array): void {
    if (this.failed || this.finished) invalid();
    try {
      if (!(bytes instanceof Uint8Array) || (stream !== "stdout" && stream !== "stderr")) invalid();
      this.transcriptBytes += bytes.length;
      if (this.transcriptBytes > maximumTranscriptBytes || (stream === "stderr" && bytes.length))
        invalid();
      if (stream === "stderr") return;
      for (const frame of this.decoder.push(bytes)) this.accept(frame);
    } catch {
      this.failed = true;
      invalid();
    }
  }

  private accept(frame: NativeBrokerFrame): void {
    if (
      this.ended ||
      frame.direction !== "response" ||
      frame.ownerEpoch !== 1 ||
      frame.sequence !== this.sequence + 1 ||
      frame.requestId !== this.brokerId ||
      frame.commandId !== null
    )
      invalid();
    this.sequence = frame.sequence;
    if (!this.hello) {
      if (frame.kind !== "hello" || frame.offset !== 0) invalid();
      const value = helloSchema.safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload)),
      );
      if (
        !value.success ||
        value.data.artifact.byteSize !== this.expected.byteSize ||
        value.data.artifact.target !== this.expected.target
      )
        invalid();
      this.hello = value.data;
      return;
    }
    if (frame.kind === "artifact") {
      if (
        !frame.payload.length ||
        frame.offset !== this.artifactBytes ||
        frame.payload.length > this.expected.byteSize - this.artifactBytes
      )
        invalid();
      this.hash.update(frame.payload);
      this.artifactBytes += frame.payload.length;
      return;
    }
    if (
      frame.kind !== "exit" ||
      frame.offset !== 0 ||
      this.artifactBytes !== this.expected.byteSize
    )
      invalid();
    if (
      !endSchema.safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload)),
      ).success
    )
      invalid();
    this.ended = true;
  }

  finish(initialProcessExitCode: number | null): NativeBrokerPreflightObservation {
    if (this.failed || this.finished) invalid();
    try {
      this.decoder.finish();
      if (
        initialProcessExitCode !== 0 ||
        !this.ended ||
        !this.hello ||
        this.artifactBytes !== this.expected.byteSize ||
        this.hash.digest("hex") !== this.expected.artifactSha256
      )
        invalid();
      this.finished = true;
      return Object.freeze({
        protocol: "native-command-broker-preflight-v1",
        brokerId: this.brokerId,
        artifactSha256: this.expected.artifactSha256,
        byteSize: this.artifactBytes,
        target: this.expected.target,
        device: this.hello.artifact.device,
        inode: this.hello.artifact.inode,
        frameCount: this.sequence,
        initialProcessExitCode: 0,
        commandAdmission: false,
      });
    } catch {
      this.failed = true;
      invalid();
    }
  }
}
