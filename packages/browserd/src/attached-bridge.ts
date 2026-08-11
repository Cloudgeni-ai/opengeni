import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

const BRIDGE_PROTOCOL_VERSION = 1 as const;
const MAX_REQUEST_MESSAGE_BYTES = 1024 * 1024;
const MAX_RESPONSE_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 4_096;
const DEFAULT_TIMEOUT_MS = 120_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,2048}$/u;

type BridgeAuthority = {
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  port: number;
  token: string;
  pid: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BridgeWireError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type AttachedBrowserBridgeOptions = {
  deviceId: string;
  connectionGeneration: string;
  authorityFile?: string;
  timeoutMs?: number;
};

export class AttachedBrowserBridgeError extends Error {
  readonly name = "AttachedBrowserBridgeError";

  constructor(
    readonly code:
      | "authority_invalid"
      | "transport_failed"
      | "protocol_invalid"
      | "resource_unavailable"
      | "fenced"
      | "timeout"
      | "bridge_failed"
      | "driver_rejected",
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Full-duplex, owner-local client for one exact attached Chrome profile.
 * The bridge token grants no workspace/cloud authority; BrowserSession
 * admission and actor authority have already happened above this driver. */
export class AttachedBrowserBridgeClient {
  readonly deviceId: string;
  readonly connectionGeneration: string;
  private readonly socket: Socket;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private receiveBuffer = Buffer.alloc(0);
  private failure: AttachedBrowserBridgeError | null = null;

  private constructor(socket: Socket, options: AttachedBrowserBridgeOptions, timeoutMs: number) {
    this.socket = socket;
    this.deviceId = requireUuid(options.deviceId, "attached browser id");
    this.connectionGeneration = boundedString(
      options.connectionGeneration,
      1,
      512,
      "attached browser connection generation",
    );
    this.timeoutMs = timeoutMs;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.acceptBytes(chunk));
    socket.once("error", (error) => {
      this.fail(
        new AttachedBrowserBridgeError(
          "transport_failed",
          "attached browser bridge transport failed",
          true,
          { cause: error },
        ),
      );
    });
    socket.once("close", () => {
      this.fail(
        new AttachedBrowserBridgeError("transport_failed", "attached browser bridge closed", true),
      );
    });
  }

  static async connect(
    options: AttachedBrowserBridgeOptions,
  ): Promise<AttachedBrowserBridgeClient> {
    const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const authority = await readAuthority(
      options.authorityFile ?? defaultBrowserBridgeAuthorityFile(),
    );
    const socket = await connectLoopback(authority.port, Math.min(timeoutMs, 15_000));
    const client = new AttachedBrowserBridgeClient(socket, options, timeoutMs);
    try {
      client.writeFrame({
        type: "authenticate",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "controller",
        token: authority.token,
      });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new AttachedBrowserBridgeError(
        "resource_unavailable",
        "attached browser pending-request bound was reached",
        true,
      );
    }
    const requestId = randomUUID();
    return await new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rejectRequest(
          new AttachedBrowserBridgeError("timeout", "attached browser command timed out", true),
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timer,
      });
      try {
        this.writeFrame({
          type: "request",
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          requestId,
          deviceId: this.deviceId,
          expectedConnectionGeneration: this.connectionGeneration,
          payload,
        });
      } catch (error) {
        this.settle(requestId);
        rejectRequest(error);
      }
    });
  }

  close(): void {
    this.fail(
      new AttachedBrowserBridgeError(
        "transport_failed",
        "attached browser bridge closed by browserd",
        true,
      ),
    );
    this.socket.destroy();
  }

  private acceptBytes(chunk: Buffer): void {
    if (this.failure || chunk.length === 0) return;
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32LE(0);
      if (length < 1 || length > MAX_RESPONSE_MESSAGE_BYTES) {
        this.fail(
          new AttachedBrowserBridgeError(
            "protocol_invalid",
            "attached browser bridge returned an invalid frame length",
            false,
          ),
        );
        this.socket.destroy();
        return;
      }
      if (this.receiveBuffer.length < length + 4) return;
      const body = this.receiveBuffer.subarray(4, length + 4);
      this.receiveBuffer = this.receiveBuffer.subarray(length + 4);
      try {
        this.acceptMessage(JSON.parse(body.toString("utf8")) as unknown);
      } catch (error) {
        this.fail(
          error instanceof AttachedBrowserBridgeError
            ? error
            : new AttachedBrowserBridgeError(
                "protocol_invalid",
                "attached browser bridge returned invalid JSON",
                false,
                { cause: error },
              ),
        );
        this.socket.destroy();
        return;
      }
    }
    if (this.receiveBuffer.length > MAX_RESPONSE_MESSAGE_BYTES + 4) {
      this.fail(
        new AttachedBrowserBridgeError(
          "protocol_invalid",
          "attached browser bridge returned an oversized frame",
          false,
        ),
      );
      this.socket.destroy();
    }
  }

  private acceptMessage(value: unknown): void {
    if (!isRecord(value) || value.type !== "response" || value.protocolVersion !== 1) {
      throw new AttachedBrowserBridgeError(
        "protocol_invalid",
        "attached browser bridge returned an invalid envelope",
        false,
      );
    }
    const requestId = requireUuid(value.requestId, "bridge response id");
    if (
      value.deviceId !== this.deviceId ||
      value.connectionGeneration !== this.connectionGeneration
    ) {
      throw new AttachedBrowserBridgeError(
        "protocol_invalid",
        "attached browser bridge returned another profile fence",
        false,
      );
    }
    const pending = this.settle(requestId);
    if (!pending) return;
    if (value.ok === true && "payload" in value && !("error" in value)) {
      pending.resolve(value.payload);
      return;
    }
    if (value.ok === false && !("payload" in value) && isWireError(value.error)) {
      pending.reject(errorFromWire(value.error));
      return;
    }
    pending.reject(
      new AttachedBrowserBridgeError(
        "protocol_invalid",
        "attached browser bridge response invariant failed",
        false,
      ),
    );
  }

  private writeFrame(value: unknown): void {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(value));
    if (body.length < 1 || body.length > MAX_REQUEST_MESSAGE_BYTES) {
      throw new AttachedBrowserBridgeError(
        "protocol_invalid",
        "attached browser bridge request exceeds its bounded envelope",
        false,
      );
    }
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    this.socket.write(frame);
  }

  private settle(requestId: string): PendingRequest | null {
    const pending = this.pending.get(requestId) ?? null;
    if (!pending) return null;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    return pending;
  }

  private fail(error: AttachedBrowserBridgeError): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function defaultBrowserBridgeAuthorityFile(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.OPENGENI_BROWSER_BRIDGE_AUTHORITY_FILE) {
    return resolve(environment.OPENGENI_BROWSER_BRIDGE_AUTHORITY_FILE);
  }
  const configDirectory = environment.OPENGENI_CONFIG_DIR
    ? resolve(environment.OPENGENI_CONFIG_DIR)
    : environment.XDG_CONFIG_HOME
      ? join(resolve(environment.XDG_CONFIG_HOME), "opengeni", "agent")
      : join(homedir(), ".config", "opengeni", "agent");
  return join(configDirectory, "browser-bridge-authority.json");
}

async function readAuthority(pathInput: string): Promise<BridgeAuthority> {
  const path = resolve(pathInput);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 64 ||
      metadata.size > 4_096 ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new Error("authority file is not an owner-only regular file");
    }
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).some(
        (key) => !["protocolVersion", "port", "token", "pid"].includes(key),
      ) ||
      parsed.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      !Number.isSafeInteger(parsed.port) ||
      (parsed.port as number) < 1 ||
      (parsed.port as number) > 65_535 ||
      typeof parsed.token !== "string" ||
      !TOKEN_PATTERN.test(parsed.token) ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) < 1
    ) {
      throw new Error("authority document is invalid");
    }
    return parsed as BridgeAuthority;
  } catch (error) {
    throw new AttachedBrowserBridgeError(
      "authority_invalid",
      "attached browser bridge authority is unavailable",
      true,
      { cause: error },
    );
  } finally {
    await handle?.close();
  }
}

async function connectLoopback(port: number, timeoutMs: number): Promise<Socket> {
  return await new Promise<Socket>((resolveSocket, rejectSocket) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      rejectSocket(
        new AttachedBrowserBridgeError(
          "transport_failed",
          "attached browser bridge connection timed out",
          true,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("error", failed);
    };
    const connected = () => {
      cleanup();
      resolveSocket(socket);
    };
    const failed = (error: Error) => {
      cleanup();
      socket.destroy();
      rejectSocket(
        new AttachedBrowserBridgeError(
          "transport_failed",
          "attached browser bridge connection failed",
          true,
          { cause: error },
        ),
      );
    };
    socket.once("connect", connected);
    socket.once("error", failed);
  });
}

function errorFromWire(error: BridgeWireError): AttachedBrowserBridgeError {
  const code = ["resource_unavailable", "fenced", "timeout", "bridge_failed"].includes(error.code)
    ? (error.code as "resource_unavailable" | "fenced" | "timeout" | "bridge_failed")
    : "driver_rejected";
  return new AttachedBrowserBridgeError(code, error.message, error.retryable);
}

function isWireError(value: unknown): value is BridgeWireError {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    value.code.length >= 1 &&
    value.code.length <= 128 &&
    typeof value.message === "string" &&
    value.message.length >= 1 &&
    value.message.length <= 8_192 &&
    typeof value.retryable === "boolean"
  );
}

function requireUuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new AttachedBrowserBridgeError("protocol_invalid", `${label} is invalid`, false);
  }
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new AttachedBrowserBridgeError("protocol_invalid", `${label} is invalid`, false);
  }
  return value;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
    throw new RangeError("attached browser bridge timeout is invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
