import type { ComputerSessionAttachment } from "@opengeni/sdk/interaction";

const DEFAULT_TIMEOUT_MS = 20_000;
const RAW_ENCODING = 0;
const HEXTILE_ENCODING = 5;
const ZRLE_ENCODING = 16;
const DESKTOP_SIZE_ENCODING = -223;
const LAST_RECT_ENCODING = -224;
const HEXTILE_RAW = 1;
const HEXTILE_BACKGROUND_SPECIFIED = 2;
const HEXTILE_FOREGROUND_SPECIFIED = 4;
const HEXTILE_ANY_SUBRECTS = 8;
const HEXTILE_SUBRECTS_COLOURED = 16;

export type RfbUpdate = {
  sequence: number;
  fingerprint: string;
};

export type RfbProbeDiagnostics = {
  state: string;
  bufferedBytes: number;
  width: number;
  height: number;
  websocketMessages: number;
  websocketBytes: number;
  framebufferUpdates: number;
  pixelUpdates: number;
  emptyUpdates: number;
  framebufferRequests: number;
  lastRectangleCount: number | null;
  lastMessageAt: string | null;
};

type Waiter = {
  predicate: (frame: RfbUpdate) => boolean;
  resolve: (frame: RfbUpdate) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Minimal RFB 3.8 client used only by live acceptance. It asks for raw
 * framebuffer rectangles so the test proves real pixels and visible changes
 * through the exact authenticated URL/protocols handed to noVNC.
 */
export class RfbAcceptanceProbe {
  private buffer = new Uint8Array(64 * 1024);
  private bufferedLength = 0;
  private state: "protocol" | "security_types" | "security_result" | "server_init" | "normal" =
    "protocol";
  private readonly queue: RfbUpdate[] = [];
  private readonly waiters: Waiter[] = [];
  private sequence = 0;
  private width = 0;
  private height = 0;
  private bytesPerPixel = 4;
  private closed = false;
  private failure: Error | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private websocketMessages = 0;
  private websocketBytes = 0;
  private framebufferUpdates = 0;
  private pixelUpdates = 0;
  private emptyUpdates = 0;
  private framebufferRequests = 0;
  private lastRectangleCount: number | null = null;
  private lastMessageAt: string | null = null;

  private constructor(private readonly socket: WebSocket) {}

  static async open(
    attachment: ComputerSessionAttachment,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<RfbAcceptanceProbe> {
    if (attachment.stream.kind !== "direct_rfb") {
      throw new Error("RFB acceptance requires a direct_rfb attachment");
    }
    const socket = new WebSocket(attachment.stream.url, [...attachment.stream.protocols]);
    socket.binaryType = "arraybuffer";
    const probe = new RfbAcceptanceProbe(socket);
    await probe.connect(timeoutMs);
    return probe;
  }

  first(timeoutMs = DEFAULT_TIMEOUT_MS, label = "RFB first frame"): Promise<RfbUpdate> {
    return this.waitFor(() => true, timeoutMs, label);
  }

  nextChangedAfter(
    previous: RfbUpdate,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = "RFB frame change",
  ): Promise<RfbUpdate> {
    return this.waitFor(
      (frame) => frame.sequence > previous.sequence && frame.fingerprint !== previous.fingerprint,
      timeoutMs,
      label,
    );
  }

  /** Sends the exact ASCII key path used by noVNC for live human typing. */
  typeAscii(value: string): void {
    if (this.state !== "normal" || this.closed || this.failure) {
      throw new Error("RFB input requires an active normal connection");
    }
    for (const character of value) {
      const keysym = character.codePointAt(0);
      if (keysym === undefined || keysym > 0x7f) {
        throw new Error("RFB acceptance input is intentionally ASCII-only");
      }
      this.sendKey(keysym, true);
      this.sendKey(keysym, false);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, "acceptance probe complete");
    this.rejectAll(new Error("RFB acceptance probe closed"));
  }

  diagnostics(): RfbProbeDiagnostics {
    return {
      state: this.state,
      bufferedBytes: this.bufferedLength,
      width: this.width,
      height: this.height,
      websocketMessages: this.websocketMessages,
      websocketBytes: this.websocketBytes,
      framebufferUpdates: this.framebufferUpdates,
      pixelUpdates: this.pixelUpdates,
      emptyUpdates: this.emptyUpdates,
      framebufferRequests: this.framebufferRequests,
      lastRectangleCount: this.lastRectangleCount,
      lastMessageAt: this.lastMessageAt,
    };
  }

  private async connect(timeoutMs: number): Promise<void> {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        this.connectResolve = resolve;
        this.connectReject = reject;
        this.socket.addEventListener("message", (event) => {
          void this.receive(event.data);
        });
        this.socket.addEventListener("error", () => {
          this.fail(new Error("RFB WebSocket failed"));
        });
        this.socket.addEventListener("close", (event) => {
          if (!this.closed) {
            this.fail(
              new Error(
                `RFB WebSocket closed unexpectedly during ${this.state} ` +
                  `(code ${event.code}, reason ${JSON.stringify(event.reason)}, ` +
                  `${this.bufferedLength} buffered bytes)`,
              ),
            );
          }
        });
      }),
      timeoutMs,
      "RFB handshake",
    );
  }

  private async receive(value: unknown): Promise<void> {
    try {
      const incoming = await messageBytes(value);
      if (this.closed) return;
      this.websocketMessages += 1;
      this.websocketBytes += incoming.byteLength;
      this.lastMessageAt = new Date().toISOString();
      this.ensureCapacity(this.bufferedLength + incoming.byteLength);
      this.buffer.set(incoming, this.bufferedLength);
      this.bufferedLength += incoming.byteLength;
      this.drain();
    } catch (cause) {
      this.fail(cause);
    }
  }

  private drain(): void {
    while (!this.closed && !this.failure) {
      if (this.state === "protocol") {
        if (this.bufferedLength < 12) return;
        const versionBytes = this.consume(12);
        const version = new TextDecoder("latin1").decode(versionBytes);
        if (!/^RFB 003\.00[378]\n$/.test(version)) {
          throw new Error(`unsupported RFB protocol banner ${JSON.stringify(version)}`);
        }
        this.socket.send(new TextEncoder().encode("RFB 003.008\n"));
        this.state = "security_types";
        continue;
      }
      if (this.state === "security_types") {
        if (this.bufferedLength < 1) return;
        const count = this.buffer[0]!;
        if (count === 0) {
          if (this.bufferedLength < 5) return;
          const reasonLength = new DataView(
            this.buffer.buffer,
            this.buffer.byteOffset + 1,
            4,
          ).getUint32(0, false);
          if (this.bufferedLength < 5 + reasonLength) return;
          const reason = new TextDecoder().decode(this.buffer.subarray(5, 5 + reasonLength));
          throw new Error(`RFB server rejected security negotiation: ${reason}`);
        }
        if (this.bufferedLength < 1 + count) return;
        const types = this.consume(1 + count).subarray(1);
        if (!types.includes(1)) throw new Error("RFB server does not offer no-auth security");
        this.socket.send(Uint8Array.of(1));
        this.state = "security_result";
        continue;
      }
      if (this.state === "security_result") {
        if (this.bufferedLength < 4) return;
        const status = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(
          0,
          false,
        );
        this.consume(4);
        if (status !== 0) throw new Error(`RFB security negotiation failed with status ${status}`);
        this.socket.send(Uint8Array.of(1));
        this.state = "server_init";
        continue;
      }
      if (this.state === "server_init") {
        if (this.bufferedLength < 24) return;
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, 24);
        const nameLength = view.getUint32(20, false);
        if (this.bufferedLength < 24 + nameLength) return;
        this.width = view.getUint16(0, false);
        this.height = view.getUint16(2, false);
        const bitsPerPixel = view.getUint8(4);
        if (bitsPerPixel !== 8 && bitsPerPixel !== 16 && bitsPerPixel !== 32) {
          throw new Error(`unsupported RFB pixel width ${bitsPerPixel}`);
        }
        this.bytesPerPixel = bitsPerPixel / 8;
        this.consume(24 + nameLength);
        // The acceptance probe only needs exact change detection and input
        // round-trips, not 32-bit screenshot fidelity. Negotiate compact 8-bit
        // true colour before requesting RAW rectangles so the probe exercises a
        // bandwidth-conscious RFB client instead of forcing a ~3.5 MiB full
        // desktop over the websocket on every initial attach/reconnect.
        this.sendCompactPixelFormat();
        this.sendEncodings();
        this.requestFramebuffer(false);
        this.state = "normal";
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
        continue;
      }
      if (!this.drainServerMessage()) return;
    }
  }

  private drainServerMessage(): boolean {
    if (this.bufferedLength < 1) return false;
    const type = this.buffer[0]!;
    if (type === 0) return this.drainFramebufferUpdate();
    if (type === 2) {
      this.consume(1);
      return true;
    }
    if (type === 3) {
      if (this.bufferedLength < 8) return false;
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset + 4, 4).getUint32(
        0,
        false,
      );
      if (this.bufferedLength < 8 + length) return false;
      this.consume(8 + length);
      return true;
    }
    throw new Error(`unsupported RFB server message type ${type}`);
  }

  private drainFramebufferUpdate(): boolean {
    if (this.bufferedLength < 4) return false;
    const rectangleCount = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset + 2,
      2,
    ).getUint16(0, false);
    let offset = 4;
    let hash = 0x811c9dc5;
    let hasPixels = false;
    for (let index = 0; index < rectangleCount; index += 1) {
      if (this.bufferedLength < offset + 12) return false;
      const header = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 12);
      const width = header.getUint16(4, false);
      const height = header.getUint16(6, false);
      const encoding = header.getInt32(8, false);
      for (let cursor = offset; cursor < offset + 12; cursor += 1) {
        hash = fnvByte(hash, this.buffer[cursor]!);
      }
      offset += 12;
      if (encoding === RAW_ENCODING) {
        const size = width * height * this.bytesPerPixel;
        if (!Number.isSafeInteger(size) || size < 0 || this.bufferedLength < offset + size) {
          return false;
        }
        for (let cursor = offset; cursor < offset + size; cursor += 1) {
          hash = fnvByte(hash, this.buffer[cursor]!);
        }
        offset += size;
        hasPixels = true;
        continue;
      }
      if (encoding === HEXTILE_ENCODING) {
        const end = hextileEndOffset({
          buffer: this.buffer,
          bufferedLength: this.bufferedLength,
          offset,
          width,
          height,
          bytesPerPixel: this.bytesPerPixel,
        });
        if (end === null) return false;
        for (let cursor = offset; cursor < end; cursor += 1) {
          hash = fnvByte(hash, this.buffer[cursor]!);
        }
        offset = end;
        hasPixels = true;
        continue;
      }
      if (encoding === ZRLE_ENCODING) {
        if (this.bufferedLength < offset + 4) return false;
        const compressedLength = new DataView(
          this.buffer.buffer,
          this.buffer.byteOffset + offset,
          4,
        ).getUint32(0, false);
        if (this.bufferedLength < offset + 4 + compressedLength) return false;
        for (let cursor = offset; cursor < offset + 4 + compressedLength; cursor += 1) {
          hash = fnvByte(hash, this.buffer[cursor]!);
        }
        offset += 4 + compressedLength;
        hasPixels = true;
        continue;
      }
      if (encoding === DESKTOP_SIZE_ENCODING) {
        this.width = width;
        this.height = height;
        continue;
      }
      if (encoding === LAST_RECT_ENCODING) break;
      throw new Error(`RFB server ignored the bounded encoding request: ${encoding}`);
    }
    this.framebufferUpdates += 1;
    this.lastRectangleCount = rectangleCount;
    this.discard(offset);
    this.requestFramebuffer(true);
    if (hasPixels) {
      this.pixelUpdates += 1;
      this.sequence += 1;
      this.push({
        sequence: this.sequence,
        fingerprint: hash.toString(16).padStart(8, "0"),
      });
    } else {
      this.emptyUpdates += 1;
    }
    return true;
  }

  private sendEncodings(): void {
    const message = new Uint8Array(24);
    const view = new DataView(message.buffer);
    view.setUint8(0, 2);
    view.setUint16(2, 5, false);
    view.setInt32(4, ZRLE_ENCODING, false);
    view.setInt32(8, HEXTILE_ENCODING, false);
    view.setInt32(12, RAW_ENCODING, false);
    view.setInt32(16, DESKTOP_SIZE_ENCODING, false);
    view.setInt32(20, LAST_RECT_ENCODING, false);
    this.socket.send(message);
  }

  private sendCompactPixelFormat(): void {
    const message = new Uint8Array(20);
    const view = new DataView(message.buffer);
    view.setUint8(0, 0); // SetPixelFormat
    view.setUint8(4, 8); // bits-per-pixel
    view.setUint8(5, 8); // depth
    view.setUint8(6, 0); // little-endian
    view.setUint8(7, 1); // true-colour
    view.setUint16(8, 7, false); // red max (3 bits)
    view.setUint16(10, 7, false); // green max (3 bits)
    view.setUint16(12, 3, false); // blue max (2 bits)
    view.setUint8(14, 5); // red shift
    view.setUint8(15, 2); // green shift
    view.setUint8(16, 0); // blue shift
    this.socket.send(message);
    this.bytesPerPixel = 1;
  }

  private requestFramebuffer(incremental: boolean): void {
    const message = new Uint8Array(10);
    const view = new DataView(message.buffer);
    view.setUint8(0, 3);
    view.setUint8(1, incremental ? 1 : 0);
    view.setUint16(6, this.width, false);
    view.setUint16(8, this.height, false);
    this.socket.send(message);
    this.framebufferRequests += 1;
  }

  private sendKey(keysym: number, down: boolean): void {
    const message = new Uint8Array(8);
    const view = new DataView(message.buffer);
    view.setUint8(0, 4);
    view.setUint8(1, down ? 1 : 0);
    view.setUint32(4, keysym, false);
    this.socket.send(message);
  }

  private consume(length: number): Uint8Array {
    const value = this.buffer.slice(0, length);
    this.discard(length);
    return value;
  }

  private discard(length: number): void {
    if (length < 0 || length > this.bufferedLength) {
      throw new Error("RFB parser attempted to consume outside its buffer");
    }
    const remaining = this.bufferedLength - length;
    if (remaining > 0) this.buffer.copyWithin(0, length, this.bufferedLength);
    this.bufferedLength = remaining;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.bufferedLength));
    this.buffer = grown;
  }

  private waitFor(
    predicate: (frame: RfbUpdate) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<RfbUpdate> {
    const queued = this.queue.findIndex(predicate);
    if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0]!);
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("RFB acceptance probe is closed"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new Error(
              `${label} did not converge within ${timeoutMs}ms: ${JSON.stringify(this.diagnostics())}`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private push(frame: RfbUpdate): void {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index < 0) {
      this.queue.push(frame);
      if (this.queue.length > 4) this.queue.splice(0, this.queue.length - 4);
      return;
    }
    const waiter = this.waiters.splice(index, 1)[0]!;
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  private fail(cause: unknown): void {
    if (this.failure || this.closed) return;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.failure = error;
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    this.rejectAll(error);
    this.socket.close(1011, "RFB acceptance failed");
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function hextileEndOffset(input: {
  buffer: Uint8Array;
  bufferedLength: number;
  offset: number;
  width: number;
  height: number;
  bytesPerPixel: number;
}): number | null {
  let offset = input.offset;
  for (let tileY = 0; tileY < input.height; tileY += 16) {
    const tileHeight = Math.min(16, input.height - tileY);
    for (let tileX = 0; tileX < input.width; tileX += 16) {
      const tileWidth = Math.min(16, input.width - tileX);
      if (offset >= input.bufferedLength) return null;
      const subencoding = input.buffer[offset++]!;
      if ((subencoding & ~0x1f) !== 0) {
        throw new Error(`RFB Hextile subencoding is invalid: ${subencoding}`);
      }
      if ((subencoding & HEXTILE_RAW) !== 0) {
        const bytes = tileWidth * tileHeight * input.bytesPerPixel;
        if (offset + bytes > input.bufferedLength) return null;
        offset += bytes;
        continue;
      }
      if ((subencoding & HEXTILE_BACKGROUND_SPECIFIED) !== 0) {
        if (offset + input.bytesPerPixel > input.bufferedLength) return null;
        offset += input.bytesPerPixel;
      }
      if ((subencoding & HEXTILE_FOREGROUND_SPECIFIED) !== 0) {
        if (offset + input.bytesPerPixel > input.bufferedLength) return null;
        offset += input.bytesPerPixel;
      }
      if ((subencoding & HEXTILE_ANY_SUBRECTS) === 0) continue;
      if (offset >= input.bufferedLength) return null;
      const count = input.buffer[offset++]!;
      const subrectBytes =
        2 + ((subencoding & HEXTILE_SUBRECTS_COLOURED) !== 0 ? input.bytesPerPixel : 0);
      const bytes = count * subrectBytes;
      if (offset + bytes > input.bufferedLength) return null;
      offset += bytes;
    }
  }
  return offset;
}

function fnvByte(hash: number, byte: number): number {
  return Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0;
}

async function messageBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("RFB stream returned a non-binary message");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
