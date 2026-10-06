import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export const CANARY_RESPONSE_BYTES = 8 * 1024 * 1024;
const CANARY_BODY_BYTES = 64 * 1024 * 1024;
const CANARY_OUTPUT_BYTES = 80 * 1024 * 1024;
const CANARY_RECORD_BYTES = 64 * 1024;

export type CanaryIdentity = {
  source: string;
  workflowSource: string;
  runId: string;
  attempt: string;
};

export type RetainedCanaryFile = { file: string; bytes: number; sha256: string };
export type CanaryReadResource = { kind: "tags" } | { kind: "version"; version: string };
export interface CanaryCustody {
  record(kind: string, fields: Record<string, unknown>): RetainedCanaryFile;
  capture(
    name: string,
    response: Response,
    signal?: AbortSignal,
    resource?: CanaryReadResource,
  ): Promise<Buffer>;
}

export function withCanaryReadSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Canary read timed out", "TimeoutError"));
    if (signal.aborted) {
      void promise.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function canaryErrorCategory(error: unknown): string {
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "request_timeout";
  }
  return "request_or_custody_failed";
}

export function canaryResponseHeaders(headers?: { get(name: string): string | null }) {
  const selected: Record<string, string> = {};
  for (const name of [
    "content-type",
    "content-length",
    "cache-control",
    "age",
    "date",
    "etag",
    "last-modified",
    "cf-cache-status",
    "vary",
    "x-fetch-attempts",
  ]) {
    const value = headers?.get(name);
    if (value !== null && value !== undefined) {
      if (value.length > 1024) throw new Error("Canary response header exceeds custody bound");
      selected[name] = value;
    }
  }
  return selected;
}

/** Only public package observations and admitted workflow identity enter this directory. */
export class CanaryReceiptStore implements CanaryCustody {
  private ordinal = 0;
  private bodyBytes = 0;
  private outputBytes = 0;

  constructor(
    private readonly directory: string,
    private readonly identity: CanaryIdentity,
  ) {
    if (
      !/^[a-f0-9]{40}$/.test(identity.source) ||
      identity.source !== identity.workflowSource ||
      !/^[1-9]\d*$/.test(identity.runId) ||
      !/^[1-9]\d*$/.test(identity.attempt)
    ) {
      throw new Error("Canary receipt source identity is invalid");
    }
    mkdirSync(directory, { mode: 0o700 });
    this.identity = Object.freeze({ ...identity });
    this.syncDirectory();
  }

  record(kind: string, fields: Record<string, unknown>): RetainedCanaryFile {
    if (!/^[A-Z_]+$/.test(kind)) throw new Error("Canary receipt kind is invalid");
    if (["protocol", "kind", "identity", "recordedAt"].some((key) => Object.hasOwn(fields, key))) {
      throw new Error("Canary receipt cannot replace its admitted identity");
    }
    const bytes = Buffer.from(
      JSON.stringify(
        {
          protocol: 1,
          kind,
          identity: this.identity,
          recordedAt: new Date().toISOString(),
          ...fields,
        },
        null,
        2,
      ) + "\n",
    );
    if (bytes.length > CANARY_RECORD_BYTES) throw new Error("Canary receipt exceeds record bound");
    const file = this.nextFile("json");
    return this.retain(file, bytes);
  }

  async capture(
    name: string,
    response: Response,
    signal?: AbortSignal,
    resource?: CanaryReadResource,
  ): Promise<Buffer> {
    const headers = this.record("READ_RESPONSE", {
      package: name,
      ...(resource ? { resource } : {}),
      status: response.status,
      headers: canaryResponseHeaders(response.headers),
      headersMeaning: "FETCH_VISIBLE_ALLOWLIST",
    });
    const file = this.nextFile("body");
    const fd = openSync(join(this.directory, file), "wx", 0o600);
    const chunks: Buffer[] = [];
    let received = 0;
    let retained = 0;
    let complete = false;
    let truncated = false;
    let failure: unknown;
    const reader = response.body?.getReader();
    try {
      if (reader) {
        while (true) {
          const part = await withCanaryReadSignal(reader.read(), signal);
          if (part.done) {
            complete = true;
            break;
          }
          received += part.value.byteLength;
          const available = Math.max(
            0,
            Math.min(
              CANARY_RESPONSE_BYTES - retained,
              CANARY_BODY_BYTES - this.bodyBytes,
              CANARY_OUTPUT_BYTES - this.outputBytes,
            ),
          );
          const bytes = Buffer.from(part.value).subarray(0, available);
          if (bytes.length) {
            this.writeAll(fd, bytes);
            retained += bytes.length;
            this.bodyBytes += bytes.length;
            this.outputBytes += bytes.length;
            chunks.push(bytes);
          }
          if (retained !== received) {
            truncated = true;
            void reader.cancel().catch(() => {});
            throw new Error("Canary registry body exceeds custody bound");
          }
        }
      } else {
        complete = true;
      }
    } catch (error) {
      failure = error;
      if (reader) void reader.cancel().catch(() => {});
    } finally {
      fsyncSync(fd);
      closeSync(fd);
      this.syncDirectory();
      reader?.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    const body = this.readback(file, bytes);
    this.record("READ_BODY", {
      package: name,
      headers,
      body,
      received,
      retained,
      complete,
      truncated,
      category: failure ? canaryErrorCategory(failure) : null,
    });
    if (failure) throw failure;
    if (!complete || truncated) throw new Error("Canary registry body custody is incomplete");
    return bytes;
  }

  private nextFile(extension: string): string {
    if (this.ordinal >= 2048) throw new Error("Canary receipt file count exceeds bound");
    return `${String(this.ordinal++).padStart(4, "0")}.${extension}`;
  }

  private retain(file: string, bytes: Buffer): RetainedCanaryFile {
    if (this.outputBytes + bytes.length > CANARY_OUTPUT_BYTES) {
      throw new Error("Canary receipt output exceeds bound");
    }
    const fd = openSync(join(this.directory, file), "wx", 0o600);
    try {
      this.writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.outputBytes += bytes.length;
    this.syncDirectory();
    return this.readback(file, bytes);
  }

  private writeAll(fd: number, bytes: Buffer) {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Canary receipt write did not advance");
      offset += written;
    }
  }

  private readback(file: string, bytes: Buffer): RetainedCanaryFile {
    const actual = readFileSync(join(this.directory, file));
    if (!actual.equals(bytes)) throw new Error("Canary receipt readback differs");
    return {
      file,
      bytes: actual.length,
      sha256: createHash("sha256").update(actual).digest("hex"),
    };
  }

  private syncDirectory() {
    const fd = openSync(this.directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export async function boundedCanaryBody(response: Response, signal?: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await withCanaryReadSignal(reader.read(), signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > CANARY_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error("Canary registry body exceeds bound");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
