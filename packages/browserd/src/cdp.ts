import { WebSocket as SizedWebSocket } from "ws";
import { isRecord } from "@opengeni/contracts/values";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_PENDING_COMMANDS = 4_096;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024 * 1024;
/** Bytes of a refused message read to tell which command or event it was:
 * Chromium writes a response's id, and an event's method, first. */
const REFUSED_MESSAGE_HEAD_BYTES = 256;
/**
 * The largest frame the socket itself takes. Above this a WebSocket client
 * errors the whole socket before any message handler runs, so it is far above
 * MAX_MESSAGE_BYTES: a larger message is still refused one by one (see
 * acceptMessage) instead of ending the connection. Bun's global WebSocket
 * cannot raise its fixed 128 MiB limit, which a full-page screenshot or one
 * console message of a single large page can pass; its built-in ws client
 * takes this bound (at most 2^31 - 1).
 */
const MAX_FRAME_BYTES = 2 ** 31 - 1;

/** The part of a WebSocket a CdpConnection uses. */
export type CdpSocket = {
  binaryType: string;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    // oxlint-disable-next-line typescript/no-explicit-any -- DOM and ws event types differ.
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    // oxlint-disable-next-line typescript/no-explicit-any -- DOM and ws event types differ.
    listener: (event: any) => void,
  ): void;
};

function sizedWebSocket(url: string): CdpSocket {
  return new SizedWebSocket(url, {
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  }) as unknown as CdpSocket;
}

export type CdpEvent = {
  method: string;
  params: Record<string, unknown>;
  sessionId: string | null;
};

export type CdpConnectOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  allowRemote?: boolean;
  createWebSocket?: (url: string) => CdpSocket;
};

export type CdpSendOptions = {
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class CdpProtocolError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CdpProtocolError";
  }
}

export class CdpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpTransportError";
  }
}

/**
 * One response the connection would not accept: larger than its byte bound,
 * or not a JSON object. Only the command it answers fails; the connection
 * and every other command and target carry on.
 */
export class CdpResponseRefusedError extends Error {
  constructor(
    readonly method: string,
    readonly reason: "too_large" | "invalid",
    readonly bytes: number,
    bound = MAX_MESSAGE_BYTES,
  ) {
    super(
      reason === "too_large"
        ? `CDP ${method} response of ${bytes} bytes is larger than its ${bound}-byte bound`
        : `CDP ${method} returned a response that is not valid JSON`,
    );
    this.name = "CdpResponseRefusedError";
  }
}

/** A message the connection dropped without failing: an event (or a late
 * response) that was too large or not valid JSON. */
export type CdpDroppedMessage = {
  /** The event's method, or null for a response or an unrecognizable message. */
  method: string | null;
  reason: "too_large" | "invalid";
  bytes: number;
  /** The flattened target session the message was for, when it says. */
  sessionId?: string;
};

export class CdpCommandTimeoutError extends CdpTransportError {
  constructor(
    readonly method: string,
    readonly sessionId?: string,
  ) {
    super(`CDP ${method} timed out`);
    this.name = "CdpCommandTimeoutError";
  }
}

/** One attached target ended; the browser connection can still serve other targets. */
export class CdpSessionDetachedError extends Error {
  constructor(readonly method: string) {
    super(`CDP ${method} target session detached`);
    this.name = "CdpSessionDetachedError";
  }
}

type PendingCommand = {
  method: string;
  sessionId: string | undefined;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
};

type EventListener = (event: CdpEvent) => void;

export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private messageTail: Promise<void> = Promise.resolve();
  private failure: CdpTransportError | null = null;
  private readonly disconnectListeners = new Set<() => void>();
  private readonly droppedListeners = new Set<(message: CdpDroppedMessage) => void>();
  /** Messages dropped since the connection opened; see CdpDroppedMessage. */
  droppedMessageCount = 0;

  private constructor(private readonly socket: CdpSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event: { data: string | ArrayBuffer | Blob }) => {
      this.messageTail = this.messageTail
        .then(async () => {
          await this.acceptMessage(event.data);
        })
        .catch(() => {
          this.fail(new CdpTransportError("CDP returned an invalid message"));
        });
    });
    socket.addEventListener("close", () => {
      this.fail(new CdpTransportError("CDP connection closed"));
    });
    socket.addEventListener("error", () => {
      this.fail(new CdpTransportError("CDP connection failed"));
    });
  }

  static async connect(endpoint: string, options: CdpConnectOptions = {}): Promise<CdpConnection> {
    validateEndpoint(endpoint, options.allowRemote === true);
    const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    if (options.signal?.aborted) throw new CdpTransportError("CDP connection was aborted");
    const socket = (options.createWebSocket ?? sizedWebSocket)(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new CdpTransportError("CDP connection timed out"));
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", closed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new CdpTransportError("CDP connection failed"));
      };
      const closed = () => {
        cleanup();
        reject(new CdpTransportError("CDP connection closed during startup"));
      };
      const abort = () => {
        socket.close();
        cleanup();
        reject(new CdpTransportError("CDP connection was aborted"));
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", closed, { once: true });
      options.signal?.addEventListener("abort", abort, { once: true });
    });
    return new CdpConnection(socket);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: CdpSendOptions = {},
  ): Promise<T> {
    if (!method || method.length > 256) throw new Error("CDP method must be a bounded string");
    if (this.failure) throw this.failure;
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new CdpTransportError("CDP connection is not open");
    }
    if (this.pending.size >= MAX_PENDING_COMMANDS) {
      throw new CdpTransportError("CDP pending-command bound was reached");
    }
    if (options.signal?.aborted) throw new CdpTransportError("CDP command was aborted");
    const id = ++this.nextId;
    const payload = JSON.stringify({
      id,
      method,
      params,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    });
    if (Buffer.byteLength(payload) > MAX_COMMAND_BYTES) {
      throw new Error("CDP command exceeds its bounded transport envelope");
    }
    const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settlePending(id);
        reject(new CdpCommandTimeoutError(method, options.sessionId));
      }, timeoutMs);
      timer.unref?.();
      const abort = options.signal
        ? () => {
            this.settlePending(id);
            reject(new CdpTransportError(`CDP ${method} was aborted`));
          }
        : undefined;
      options.signal?.addEventListener("abort", abort!, { once: true });
      this.pending.set(id, {
        method,
        sessionId: options.sessionId,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        signal: options.signal,
        abort,
      });
      try {
        this.socket.send(payload);
      } catch {
        this.settlePending(id);
        reject(new CdpTransportError(`CDP ${method} could not be sent`));
      }
    });
  }

  on(method: string, listener: EventListener, sessionId?: string): () => void {
    const key = eventKey(method, sessionId ?? null);
    const listeners = this.listeners.get(key) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  waitForEvent(
    method: string,
    options: {
      sessionId?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      predicate?: (params: Record<string, unknown>) => boolean;
    } = {},
  ): Promise<CdpEvent> {
    const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
    if (this.failure) throw this.failure;
    if (options.signal?.aborted) throw new CdpTransportError(`CDP ${method} wait was aborted`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new CdpTransportError(`CDP ${method} event timed out`));
      }, timeoutMs);
      timer.unref?.();
      const unsubscribe = this.on(
        method,
        (event) => {
          if (options.predicate && !options.predicate(event.params)) return;
          cleanup();
          resolve(event);
        },
        options.sessionId,
      );
      const abort = () => {
        cleanup();
        reject(new CdpTransportError(`CDP ${method} wait was aborted`));
      };
      const unsubscribeDetached = options.sessionId
        ? this.on("Target.detachedFromTarget", (event) => {
            if (event.params.sessionId !== options.sessionId) return;
            cleanup();
            reject(new CdpSessionDetachedError(method));
          })
        : () => undefined;
      let unsubscribeDisconnected = () => {};
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        unsubscribeDetached();
        unsubscribeDisconnected();
        options.signal?.removeEventListener("abort", abort);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      unsubscribeDisconnected = this.onDisconnect(() => {
        cleanup();
        reject(this.failure ?? new CdpTransportError("CDP connection closed"));
      });
    });
  }

  onDisconnect(listener: () => void): () => void {
    if (this.failure) {
      listener();
      return () => undefined;
    }
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  /** Called for every message the connection drops instead of failing. */
  onDroppedMessage(listener: (message: CdpDroppedMessage) => void): () => void {
    this.droppedListeners.add(listener);
    return () => {
      this.droppedListeners.delete(listener);
    };
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
    this.fail(new CdpTransportError("CDP connection closed by browserd"));
  }

  private async acceptMessage(data: string | ArrayBuffer | Blob): Promise<void> {
    // One message the connection cannot take (a whole accessibility tree of
    // a very large page, a console message logging megabytes) must not end
    // the connection, which carries every tab: it fails only the command it
    // answers, or is dropped and counted when it is an event.
    const bytes =
      typeof data === "string"
        ? Buffer.byteLength(data)
        : data instanceof ArrayBuffer
          ? data.byteLength
          : data.size;
    if (bytes > MAX_MESSAGE_BYTES) {
      this.refuse(data, "too_large", bytes);
      return;
    }
    const text =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : await data.text();
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      message = null;
    }
    if (!isRecord(message)) {
      this.refuse(text, "invalid", bytes);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.settlePending(message.id);
      if (isRecord(message.error) && typeof message.error.code === "number") {
        pending.reject(
          new CdpProtocolError(
            pending.method,
            message.error.code,
            boundedMessage(message.error.message),
          ),
        );
      } else {
        pending.resolve(isRecord(message.result) ? message.result : {});
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const event: CdpEvent = {
      method: message.method,
      params: isRecord(message.params) ? message.params : {},
      sessionId: typeof message.sessionId === "string" ? message.sessionId : null,
    };
    if (
      event.method === "Target.detachedFromTarget" &&
      typeof event.params.sessionId === "string"
    ) {
      for (const [id, pending] of this.pending) {
        if (pending.sessionId !== event.params.sessionId) continue;
        this.settlePending(id);
        pending.reject(new CdpSessionDetachedError(pending.method));
      }
    }
    const keys = new Set([
      eventKey(event.method, event.sessionId),
      eventKey(event.method, null),
      eventKey("*", event.sessionId),
      eventKey("*", null),
    ]);
    for (const key of keys) {
      for (const listener of this.listeners.get(key) ?? []) {
        try {
          listener(event);
        } catch {
          // Observers cannot corrupt protocol dispatch.
        }
      }
    }
  }

  /** Fail the one command a refused message answers, or drop the event. */
  private refuse(
    data: string | ArrayBuffer | Blob,
    reason: "too_large" | "invalid",
    bytes: number,
  ): void {
    const fields = refusedMessageFields(data);
    const pending = fields.id === null ? undefined : this.pending.get(fields.id);
    if (fields.id !== null && pending) {
      this.settlePending(fields.id);
      pending.reject(new CdpResponseRefusedError(pending.method, reason, bytes));
      return;
    }
    this.droppedMessageCount += 1;
    const message: CdpDroppedMessage = {
      method: fields.id === null ? fields.method : null,
      reason,
      bytes,
      ...(fields.sessionId === null ? {} : { sessionId: fields.sessionId }),
    };
    for (const listener of this.droppedListeners) {
      try {
        listener(message);
      } catch {
        // Observers cannot corrupt protocol dispatch.
      }
    }
  }

  private settlePending(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    this.pending.delete(id);
  }

  private fail(error: CdpTransportError): void {
    if (this.failure) return;
    this.failure = error;
    for (const [id, pending] of this.pending) {
      this.settlePending(id);
      pending.reject(error);
    }
    this.listeners.clear();
    this.droppedListeners.clear();
    for (const listener of this.disconnectListeners) {
      try {
        listener();
      } catch {
        /* failure notification must not strand pending commands */
      }
    }
    this.disconnectListeners.clear();
  }
}

function validateEndpoint(endpoint: string, allowRemote: boolean): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("CDP endpoint must be an absolute URL");
  }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("CDP endpoint must be a credential-free WebSocket URL");
  }
  if (
    !allowRemote &&
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase())
  ) {
    throw new Error("CDP endpoint must terminate on the local placement bridge");
  }
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new Error("CDP timeout must be a positive bounded integer");
  }
  return timeout;
}

function eventKey(method: string, sessionId: string | null): string {
  return `${sessionId ?? ""}\0${method}`;
}

function boundedMessage(value: unknown): string {
  if (typeof value !== "string") return "CDP command failed";
  return (
    value
      .replace(/[\r\n\t]+/gu, " ")
      .trim()
      .slice(0, 2_048) || "CDP command failed"
  );
}

type RefusedMessageFields = {
  id: number | null;
  method: string | null;
  sessionId: string | null;
};

const RESPONSE_HEAD = /^\s*\{\s*"id"\s*:\s*(\d{1,15})\s*[,}]/u;
const EVENT_HEAD = /^\s*\{\s*"method"\s*:\s*"([A-Za-z0-9_.]{1,128})"/u;
const SESSION_TAIL = /,\s*"sessionId"\s*:\s*"([A-Za-z0-9_-]{1,128})"\s*\}\s*$/u;

/**
 * The top-level id, method and session id of a message the connection would
 * not take, without parsing all of it. Chromium writes a response's id (or an
 * event's method) first and a flattened session id last, so the ends answer
 * it at once; any other key order (or a message cut short or corrupted after
 * its fields) falls back to a scan of the top-level keys that skips every
 * nested value without building it.
 */
export function refusedMessageFields(data: string | ArrayBuffer | Blob): RefusedMessageFields {
  // Chromium sends text frames, so a binary or blob message is not one of
  // its replies and is only counted.
  if (typeof data !== "string") return { id: null, method: null, sessionId: null };
  const head = data.slice(0, REFUSED_MESSAGE_HEAD_BYTES);
  const tail = data.slice(-REFUSED_MESSAGE_HEAD_BYTES);
  const id = RESPONSE_HEAD.exec(head)?.[1];
  const method = id ? undefined : EVENT_HEAD.exec(head)?.[1];
  if (id || method) {
    return {
      id: id ? Number(id) : null,
      method: method ?? null,
      sessionId: SESSION_TAIL.exec(tail)?.[1] ?? null,
    };
  }
  return scanTopLevelFields(data);
}

/** Top-level id, method and sessionId of a JSON object text, read by one pass
 * that skips nested values; whatever was found before an error is kept. */
function scanTopLevelFields(text: string): RefusedMessageFields {
  const found: RefusedMessageFields = { id: null, method: null, sessionId: null };
  let index = 0;
  const space = () => {
    while (index < text.length && " \t\r\n".includes(text[index]!)) index += 1;
  };
  // A string from its opening quote; the value when it is short, else null.
  const string = (): string | null => {
    const start = (index += 1);
    while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
    if (index >= text.length) throw new Error("unterminated string");
    index += 1;
    const raw = text.slice(start, index - 1);
    return raw.length <= 128 && !raw.includes("\\") ? raw : null;
  };
  const skipValue = () => {
    let depth = 0;
    do {
      space();
      const char = text[index];
      if (char === undefined) throw new Error("unterminated value");
      if (char === '"') {
        string();
      } else if (char === "{" || char === "[") {
        depth += 1;
        index += 1;
      } else if (char === "}" || char === "]") {
        depth -= 1;
        index += 1;
      } else if (char === "," || char === ":") index += 1;
      else while (index < text.length && !",:]} \t\r\n".includes(text[index]!)) index += 1;
    } while (depth > 0);
  };
  try {
    space();
    if (text[index] !== "{") return found;
    index += 1;
    for (;;) {
      space();
      if (text[index] !== '"') return found;
      const key = string();
      space();
      if (text[index] !== ":") return found;
      index += 1;
      space();
      const start = index;
      if (key === "id" && /[0-9]/u.test(text[index] ?? "")) {
        skipValue();
        const id = Number(text.slice(start, index));
        if (Number.isSafeInteger(id)) found.id = id;
      } else if ((key === "method" || key === "sessionId") && text[index] === '"') {
        const value = string();
        if (value !== null) found[key] = value;
      } else skipValue();
      space();
      if (text[index] !== ",") return found;
      index += 1;
    }
  } catch {
    return found;
  }
}
