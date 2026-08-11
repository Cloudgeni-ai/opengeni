import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ComputerAction,
  ComputerSessionCapabilities,
  InteractionRect,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";

export const COMPUTER_NATIVE_PROTOCOL_VERSION = 1 as const;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 64;
const MAX_ABANDONED_REQUESTS = 256;
const MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;

export type NativeComputerTarget = {
  id: string;
  targetGeneration: string;
  kind: "app" | "window" | "screen";
  applicationId: string | null;
  processId: number | null;
  title: string;
  bounds: InteractionRect | null;
  focused: boolean;
};

export type NativeComputerObservation = {
  observationId: string;
  target: NativeComputerTarget;
  frameId: string | null;
  roots: InteractionSemanticNodeValue[];
  nodeCount: number;
  focusedRef: string | null;
  changedRegions: InteractionRect[];
};

export type NativeComputerActionCommand = {
  targetId: string;
  expectedTargetGeneration: string;
  expectedObservationId: string | null;
  expectedFrameId: string | null;
  action: ComputerAction;
};

export type NativeComputerFrame = {
  frameId: string;
  targetId: string;
  targetGeneration: string;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
  sha256: string;
  data: Uint8Array;
};

export type NativeComputerHandshake = {
  protocolVersion: typeof COMPUTER_NATIVE_PROTOCOL_VERSION;
  helperVersion: string;
  platform: "linux" | "macos" | "windows";
  capabilities: ComputerSessionCapabilities;
};

export type NativeComputerErrorCode =
  | "target_not_found"
  | "target_stale"
  | "observation_stale"
  | "frame_stale"
  | "locator_not_found"
  | "locator_ambiguous"
  | "unsupported"
  | "permission_denied"
  | "unavailable"
  | "machine_locked"
  | "invalid_action"
  | "timeout"
  | "driver_failed"
  | "outcome_unknown";

export class NativeComputerError extends Error {
  constructor(
    readonly code: NativeComputerErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly dispatched: boolean,
  ) {
    super(message);
    this.name = "NativeComputerError";
  }
}

export type ComputerNativeClientOptions = {
  binaryPath: string;
  arguments?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  captureTimeoutMs?: number;
};

export interface ComputerNativeTransport {
  readonly handshake: NativeComputerHandshake;
  capabilities(): Promise<ComputerSessionCapabilities>;
  targets(): Promise<NativeComputerTarget[]>;
  observe(targetId: string): Promise<NativeComputerObservation>;
  capture(targetId: string): Promise<NativeComputerFrame>;
  validate(command: NativeComputerActionCommand): Promise<void>;
  dispatch(command: NativeComputerActionCommand): Promise<NativeComputerObservation>;
  close(): Promise<void>;
}

type PendingRequest<T = unknown> = {
  parse(value: unknown): T;
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type AwaitingAttachment = {
  requestId: string;
  expectedBytes: number;
  result: unknown;
  pending: PendingRequest | null;
};

/** Correlated, bounded client for the placement-local Rust native helper. */
export class ComputerNativeClient implements ComputerNativeTransport {
  readonly handshake: NativeComputerHandshake;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly captureTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly abandoned = new Set<string>();
  private readBuffer = Buffer.alloc(0);
  private awaitingAttachment: AwaitingAttachment | null = null;
  private writeTail = Promise.resolve();
  private stderr = "";
  private terminalError: Error | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  private constructor(
    process: ChildProcessWithoutNullStreams,
    requestTimeoutMs: number,
    captureTimeoutMs: number,
    handshake: NativeComputerHandshake,
  ) {
    this.process = process;
    this.requestTimeoutMs = requestTimeoutMs;
    this.captureTimeoutMs = captureTimeoutMs;
    this.handshake = handshake;
  }

  static async open(options: ComputerNativeClientOptions): Promise<ComputerNativeClient> {
    const requestTimeoutMs = boundedTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    const captureTimeoutMs = boundedTimeout(
      options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
      "captureTimeoutMs",
    );
    const child = spawn(options.binaryPath, [...(options.arguments ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
      windowsHide: true,
    });
    const client = new ComputerNativeClient(
      child,
      requestTimeoutMs,
      captureTimeoutMs,
      placeholderHandshake(),
    );
    client.bindProcess();
    try {
      const handshake = await client.request("handshake", {}, parseHandshake, requestTimeoutMs);
      Object.assign(client.handshake, handshake);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async capabilities(): Promise<ComputerSessionCapabilities> {
    return await this.request("capabilities", {}, parseCapabilities, this.requestTimeoutMs);
  }

  async targets(): Promise<NativeComputerTarget[]> {
    return await this.request("targets", {}, parseTargets, this.requestTimeoutMs);
  }

  async observe(targetId: string): Promise<NativeComputerObservation> {
    return await this.request(
      "observe",
      { targetId: boundedString(targetId, "targetId", 512) },
      parseObservation,
      this.requestTimeoutMs,
    );
  }

  async capture(targetId: string): Promise<NativeComputerFrame> {
    return await this.request(
      "capture",
      { targetId: boundedString(targetId, "targetId", 512) },
      parseFrame,
      this.captureTimeoutMs,
    );
  }

  async validate(command: NativeComputerActionCommand): Promise<void> {
    await this.request(
      "validate",
      { command },
      (value) => {
        if (value !== null) throw new Error("native validate returned a non-null result");
      },
      this.requestTimeoutMs,
    );
  }

  async dispatch(command: NativeComputerActionCommand): Promise<NativeComputerObservation> {
    return await this.request("dispatch", { command }, parseObservation, this.requestTimeoutMs);
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    this.closePromise = this.performClose();
    return await this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.rejectPending(new Error("native computer client closed"));
    this.process.stdin.end();
    if (await waitForProcessClose(this.process, 3_000)) return;
    this.process.kill("SIGKILL");
    if (!(await waitForProcessClose(this.process, 3_000))) {
      throw new Error("native computer helper did not exit after SIGKILL");
    }
  }

  private bindProcess(): void {
    this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.process.stdout.on("end", () => {
      if (!this.closing) this.fail(new Error("native computer helper closed stdout"));
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    this.process.once("error", (error) => this.fail(error));
    this.process.once("exit", (code, signal) => {
      if (this.closing) return;
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
      this.fail(
        new Error(
          `native computer helper exited (${signal ?? String(code ?? "unknown")})${suffix}`,
        ),
      );
    });
  }

  private async request<T>(
    method: string,
    parameters: Record<string, unknown>,
    parse: (value: unknown) => T,
    timeoutMs: number,
  ): Promise<T> {
    if (this.terminalError) throw this.terminalError;
    if (this.closing) throw new Error("native computer client is closed");
    if (this.pending.size >= MAX_IN_FLIGHT_REQUESTS) {
      throw new Error("native computer request concurrency limit reached");
    }
    const requestId = `r_${randomUUID()}`;
    const bytes = Buffer.from(
      JSON.stringify({
        protocolVersion: COMPUTER_NATIVE_PROTOCOL_VERSION,
        requestId,
        method,
        ...parameters,
      }),
      "utf8",
    );
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_REQUEST_BYTES) {
      throw new Error("native computer request exceeds its byte envelope");
    }
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        if (this.awaitingAttachment?.requestId === requestId) {
          this.awaitingAttachment.pending = null;
          reject(new Error(`native computer ${method} timed out`));
          this.fail(new Error("native computer attachment timed out"));
          return;
        }
        this.abandoned.add(requestId);
        const timeout = new Error(`native computer ${method} timed out`);
        reject(timeout);
        if (this.abandoned.size > MAX_ABANDONED_REQUESTS) {
          this.fail(new Error("native computer helper exceeded the abandoned request bound"));
        }
      }, timeoutMs);
      this.pending.set(requestId, { parse, resolve, reject, timer });
      this.writeTail = this.writeTail
        .then(async () => await writeFrame(this.process, bytes))
        .catch((error: unknown) => {
          const pending = this.pending.get(requestId);
          if (!pending) return;
          this.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(asError(error));
        });
    });
  }

  private onData(chunk: Buffer): void {
    if (this.terminalError || this.closing) return;
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    try {
      while (this.readBuffer.byteLength >= 4) {
        const length = this.readBuffer.readUInt32BE(0);
        const maximum = this.awaitingAttachment ? MAX_ATTACHMENT_BYTES : MAX_RESPONSE_BYTES;
        if (length < 1 || length > maximum) {
          throw new Error(`native computer response length ${length} is invalid`);
        }
        if (this.readBuffer.byteLength < 4 + length) return;
        const frame = this.readBuffer.subarray(4, 4 + length);
        this.readBuffer = this.readBuffer.subarray(4 + length);
        this.handleFrame(frame);
      }
      if (this.readBuffer.byteLength > MAX_ATTACHMENT_BYTES + 4) {
        throw new Error("native computer response buffer exceeds its envelope");
      }
    } catch (error) {
      this.fail(asError(error));
    }
  }

  private handleFrame(frame: Buffer): void {
    if (this.awaitingAttachment) {
      const awaiting = this.awaitingAttachment;
      this.awaitingAttachment = null;
      if (frame.byteLength !== awaiting.expectedBytes) {
        throw new Error("native computer attachment length does not match metadata");
      }
      this.abandoned.delete(awaiting.requestId);
      if (!awaiting.pending) return;
      this.pending.delete(awaiting.requestId);
      clearTimeout(awaiting.pending.timer);
      this.resolveParsed(awaiting.pending, {
        result: awaiting.result,
        attachment: frame,
      });
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(frame.toString("utf8"));
    } catch {
      throw new Error("native computer helper returned invalid JSON");
    }
    const response = record(value, "native response");
    if (response.protocolVersion !== COMPUTER_NATIVE_PROTOCOL_VERSION) {
      throw new Error("native computer response protocol version is invalid");
    }
    const requestId = boundedString(response.requestId, "requestId", 128);
    const pending = this.pending.get(requestId) ?? null;
    const abandoned = this.abandoned.has(requestId);
    if (!pending && !abandoned) {
      throw new Error("native computer response has an unknown request id");
    }
    if (response.status === "error") {
      const nativeError = parseNativeError(response.error);
      this.abandoned.delete(requestId);
      if (pending) {
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(nativeError);
      }
      return;
    }
    if (response.status !== "ok") {
      throw new Error("native computer response status is invalid");
    }
    const result = response.result;
    const attachmentBytes = attachmentLength(result);
    if (attachmentBytes > 0) {
      this.awaitingAttachment = { requestId, expectedBytes: attachmentBytes, result, pending };
      return;
    }
    this.abandoned.delete(requestId);
    if (pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      this.resolveParsed(pending, result);
    }
  }

  private resolveParsed(pending: PendingRequest, value: unknown): void {
    try {
      pending.resolve(pending.parse(value));
    } catch (error) {
      pending.reject(asError(error));
      throw error;
    }
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.rejectPending(error);
    this.process.stdin.destroy();
    this.process.stdout.destroy();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill("SIGKILL");
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.abandoned.clear();
    this.awaitingAttachment = null;
  }
}

function placeholderHandshake(): NativeComputerHandshake {
  return {
    protocolVersion: COMPUTER_NATIVE_PROTOCOL_VERSION,
    helperVersion: "pending",
    platform: "linux",
    capabilities: emptyCapabilities(),
  };
}

function parseHandshake(value: unknown): NativeComputerHandshake {
  const input = record(value, "native handshake");
  if (input.protocolVersion !== COMPUTER_NATIVE_PROTOCOL_VERSION) {
    throw new Error("native computer handshake protocol version is invalid");
  }
  const platform = input.platform;
  if (platform !== "linux" && platform !== "macos" && platform !== "windows") {
    throw new Error("native computer handshake platform is invalid");
  }
  return {
    protocolVersion: COMPUTER_NATIVE_PROTOCOL_VERSION,
    helperVersion: boundedString(input.helperVersion, "helperVersion", 256),
    platform,
    capabilities: parseCapabilities(input.capabilities),
  };
}

function parseCapabilities(value: unknown): ComputerSessionCapabilities {
  const input = record(value, "native capabilities");
  const keys = [
    "semanticObservation",
    "appDiscovery",
    "appLaunch",
    "windowCapture",
    "screenCapture",
    "semanticActions",
    "pointerInput",
    "keyboardInput",
    "backgroundActions",
    "parallelApps",
  ] as const;
  const output = emptyCapabilities();
  for (const key of keys) {
    if (typeof input[key] !== "boolean") throw new Error(`native capability ${key} is invalid`);
    output[key] = input[key];
  }
  return output;
}

function emptyCapabilities(): ComputerSessionCapabilities {
  return {
    semanticObservation: false,
    appDiscovery: false,
    appLaunch: false,
    windowCapture: false,
    screenCapture: false,
    semanticActions: false,
    pointerInput: false,
    keyboardInput: false,
    backgroundActions: false,
    parallelApps: false,
  };
}

function parseTargets(value: unknown): NativeComputerTarget[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error("native computer targets are invalid");
  }
  return value.map(parseTarget);
}

function parseTarget(value: unknown): NativeComputerTarget {
  const input = record(value, "native target");
  const kind = input.kind;
  if (kind !== "app" && kind !== "window" && kind !== "screen") {
    throw new Error("native target kind is invalid");
  }
  const processId = input.processId;
  if (processId !== null && (!Number.isSafeInteger(processId) || Number(processId) < 1)) {
    throw new Error("native target process id is invalid");
  }
  return {
    id: boundedString(input.id, "target id", 512),
    targetGeneration: boundedString(input.targetGeneration, "target generation", 256),
    kind,
    applicationId:
      input.applicationId === null
        ? null
        : boundedString(input.applicationId, "application id", 1_024),
    processId: processId === null ? null : Number(processId),
    title: boundedString(input.title, "target title", 4_096, true),
    bounds: input.bounds === null ? null : parseRect(input.bounds),
    focused: boolean(input.focused, "target focused"),
  };
}

function parseObservation(value: unknown): NativeComputerObservation {
  const input = record(value, "native observation");
  if (!Array.isArray(input.roots) || input.roots.length > 10_000) {
    throw new Error("native observation roots are invalid");
  }
  if (!Array.isArray(input.changedRegions) || input.changedRegions.length > 2_000) {
    throw new Error("native observation changed regions are invalid");
  }
  const nodeCount = input.nodeCount;
  if (!Number.isSafeInteger(nodeCount) || Number(nodeCount) < 0 || Number(nodeCount) > 10_000) {
    throw new Error("native observation node count is invalid");
  }
  return {
    observationId: boundedString(input.observationId, "observation id", 512),
    target: parseTarget(input.target),
    frameId: input.frameId === null ? null : boundedString(input.frameId, "frame id", 256),
    roots: input.roots as InteractionSemanticNodeValue[],
    nodeCount: Number(nodeCount),
    focusedRef:
      input.focusedRef === null ? null : boundedString(input.focusedRef, "focused ref", 512),
    changedRegions: input.changedRegions.map(parseRect),
  };
}

function parseFrame(value: unknown): NativeComputerFrame {
  const envelope = record(value, "native frame envelope");
  const metadata = record(envelope.result, "native frame metadata");
  const attachment = envelope.attachment;
  if (!Buffer.isBuffer(attachment)) throw new Error("native frame attachment is missing");
  const mimeType = metadata.mimeType;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new Error("native frame media type is invalid");
  }
  const sha256 = boundedString(metadata.sha256, "frame digest", 64);
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("native frame digest is invalid");
  if (createHash("sha256").update(attachment).digest("hex") !== sha256) {
    throw new Error("native frame attachment digest mismatch");
  }
  return {
    frameId: boundedString(metadata.frameId, "frame id", 256),
    targetId: boundedString(metadata.targetId, "target id", 512),
    targetGeneration: boundedString(metadata.targetGeneration, "target generation", 256),
    width: boundedDimension(metadata.width, "frame width"),
    height: boundedDimension(metadata.height, "frame height"),
    mimeType,
    sha256,
    data: attachment,
  };
}

function attachmentLength(value: unknown): number {
  if (!isRecord(value) || value.attachmentBytes === undefined) return 0;
  const length = value.attachmentBytes;
  if (
    !Number.isSafeInteger(length) ||
    Number(length) < 1 ||
    Number(length) > MAX_ATTACHMENT_BYTES
  ) {
    throw new Error("native computer attachment length is invalid");
  }
  return Number(length);
}

function parseNativeError(value: unknown): NativeComputerError {
  const input = record(value, "native error");
  const allowed = new Set<NativeComputerErrorCode>([
    "target_not_found",
    "target_stale",
    "observation_stale",
    "frame_stale",
    "locator_not_found",
    "locator_ambiguous",
    "unsupported",
    "permission_denied",
    "unavailable",
    "machine_locked",
    "invalid_action",
    "timeout",
    "driver_failed",
    "outcome_unknown",
  ]);
  const code = input.code;
  if (typeof code !== "string" || !allowed.has(code as NativeComputerErrorCode)) {
    throw new Error("native computer error code is invalid");
  }
  return new NativeComputerError(
    code as NativeComputerErrorCode,
    boundedString(input.message, "native error message", 8_192),
    boolean(input.retryable, "native error retryable"),
    boolean(input.dispatched, "native error dispatched"),
  );
}

function parseRect(value: unknown): InteractionRect {
  const input = record(value, "native rectangle");
  const rectangle = {
    x: finite(input.x, "rectangle x"),
    y: finite(input.y, "rectangle y"),
    width: finite(input.width, "rectangle width"),
    height: finite(input.height, "rectangle height"),
  };
  if (rectangle.width < 0 || rectangle.height < 0) {
    throw new Error("native rectangle dimensions are invalid");
  }
  return rectangle;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length < 1) ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedDimension(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 32_768) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function boundedTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 10 * 60_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function writeFrame(child: ChildProcessWithoutNullStreams, bytes: Buffer): Promise<void> {
  const frame = Buffer.allocUnsafe(4 + bytes.byteLength);
  frame.writeUInt32BE(bytes.byteLength, 0);
  bytes.copy(frame, 4);
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

async function waitForProcessClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onClose);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = (): void => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    child.once("exit", onClose);
    child.once("close", onClose);
  });
}
