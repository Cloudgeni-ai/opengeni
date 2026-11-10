// The memory a worker's speaker models may use at once. Each loaded model
// takes hundreds of megabytes, so a worker with a memory limit (a container)
// runs only as many as fit, and the rest wait their turn instead of the
// whole worker being stopped for running out of memory.

import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

const MIB = 1024 * 1024;

/**
 * Left for the worker itself: its runtime, the other work it runs and the
 * audio a meeting's transcript holds while it is made.
 */
export const WORKER_OWN_BYTES = 640 * MIB;

/** The aligner, loaded once per worker: about 0.83 GB at its peak, measured. */
export const ALIGNER_BYTES = 900 * MIB;

/**
 * One run of speaker detection on `audioMilliseconds` of audio: about
 * 380 MB for 8 minutes and 550 MB for 50, measured, so a fixed part and a
 * little more for each minute. An unknown length counts as two hours.
 */
export function speakerDetectionBytes(audioMilliseconds: number | undefined): number {
  const minutes = (audioMilliseconds ?? 2 * 60 * 60 * 1_000) / 60_000;
  return Math.ceil((400 + 4 * minutes) * MIB);
}

/** The memory this worker may use: its container's limit, else the machine's. */
export function workerMemoryBytes(read: (path: string) => string = readText): number {
  const machine = totalmem();
  // cgroup v2, then v1; "max" (v2) or a huge number (v1) means no limit.
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let text: string;
    try {
      text = read(path).trim();
    } catch {
      continue;
    }
    const limit = Number(text);
    if (text !== "max" && Number.isFinite(limit) && limit > 0 && limit < machine) return limit;
    break;
  }
  return machine;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Memory handed out to the jobs that need it, first come first served. A
 * job waits while what is out plus what it asks for is over the budget,
 * except when nothing is out: one job always runs, so a job larger than
 * the whole budget runs alone rather than never.
 */
export class MemoryBudget {
  #out = 0;
  readonly #waiting: Array<{ bytes: number; grant: () => void }> = [];
  readonly #wanted = new Set<() => void>();

  constructor(readonly totalBytes: number) {}

  /** Bytes handed out now. */
  get outBytes(): number {
    return this.#out;
  }

  /** Whether a job is waiting for memory now. */
  get wanted(): boolean {
    return this.#waiting.length > 0;
  }

  /**
   * Call `each` whenever a job starts waiting, so an idle holder can give
   * its memory back at once; the returned function stops it.
   */
  whenWanted(each: () => void): () => void {
    this.#wanted.add(each);
    return () => this.#wanted.delete(each);
  }

  /**
   * Wait until `bytes` fit, then hold them until the returned function is
   * called (calling it again does nothing). An abort while waiting rejects
   * with the signal's reason.
   */
  take(bytes: number, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.#waiting.length === 0 && this.#fits(bytes)) {
      return Promise.resolve(this.#hold(bytes));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        bytes,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(this.#hold(bytes));
        },
      };
      const onAbort = () => {
        const index = this.#waiting.indexOf(entry);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(signal?.reason);
        this.#next();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(entry);
      for (const each of [...this.#wanted]) each();
    });
  }

  /** Hold `bytes` now if they fit beside what is out, else null; never waits. */
  takeIfFree(bytes: number): (() => void) | null {
    return this.#waiting.length === 0 && this.#out + bytes <= this.totalBytes
      ? this.#hold(bytes)
      : null;
  }

  #fits(bytes: number): boolean {
    return this.#out === 0 || this.#out + bytes <= this.totalBytes;
  }

  #hold(bytes: number): () => void {
    this.#out += bytes;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#out -= bytes;
      this.#next();
    };
  }

  #next(): void {
    while (this.#waiting.length > 0 && this.#fits(this.#waiting[0]!.bytes)) {
      this.#waiting.shift()!.grant();
    }
  }
}

/** The speaker models' share of this worker's memory, shared by every job it runs. */
export const speakerMemory = /* @__PURE__ */ new MemoryBudget(
  Math.max(512 * MIB, workerMemoryBytes() - WORKER_OWN_BYTES),
);
