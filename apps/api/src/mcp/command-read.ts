import type { SessionEvent } from "@opengeni/contracts";
import { COMMAND_OUTPUT_MAX_BYTES } from "@opengeni/db/session-background-commands";

export const COMMAND_READ_MAX_WAIT_SECONDS = 50;
export const COMMAND_WAIT_DEFAULT_SECONDS = 45;

/** Shared provider-neutral command_read/command_wait operation. Notifications
 * are only wake hints. Every result, including timeout, comes from durable DB
 * state. Subscribe before reading to close the finish/subscription race, and
 * periodically recheck durable state because live hints may be lost. */
export async function readCommandWithWait<
  T extends { terminal: boolean; chunks: unknown[]; hasMore?: boolean },
>(input: {
  commandId: string;
  waitSeconds?: number;
  maxOutputBytes?: number | undefined;
  signal?: AbortSignal;
  read: () => Promise<T>;
  subscribe: (onEvents: (events: SessionEvent[]) => void) => Promise<() => void>;
}) {
  const seconds = input.waitSeconds ?? 0;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > COMMAND_READ_MAX_WAIT_SECONDS) {
    throw new Error("waitSeconds must be between 0 and 50");
  }
  if (
    input.maxOutputBytes !== undefined &&
    (!Number.isInteger(input.maxOutputBytes) ||
      input.maxOutputBytes < 4 ||
      input.maxOutputBytes > COMMAND_OUTPUT_MAX_BYTES)
  ) {
    throw new Error("maxOutputBytes must be between 4 and 65536");
  }
  const started = Date.now();
  const deadline = started + seconds * 1000;
  let unsubscribe: (() => void) | undefined;
  let wake: (() => void) | undefined;
  let changed = false;
  let liveFanout = true;
  const notify = () => {
    changed = true;
    wake?.();
  };
  input.signal?.addEventListener("abort", notify);
  try {
    if (seconds > 0) {
      try {
        unsubscribe = await input.subscribe((events) => {
          if (
            events.some(
              (event) =>
                (event.type === "session.command.finished" ||
                  event.type === "sandbox.command.output.delta") &&
                event.payload !== null &&
                typeof event.payload === "object" &&
                (event.payload as Record<string, unknown>).commandId === input.commandId,
            )
          )
            notify();
        });
      } catch {
        liveFanout = false;
      }
    }
    while (true) {
      changed = false;
      const result = await input.read();
      const expired = Date.now() >= deadline;
      if (
        result.terminal ||
        result.chunks.length > 0 ||
        result.hasMore ||
        expired ||
        input.signal?.aborted
      ) {
        return {
          ...result,
          waitedMs: Date.now() - started,
          timedOut:
            seconds > 0 &&
            expired &&
            !result.terminal &&
            result.chunks.length === 0 &&
            !result.hasMore,
          aborted: input.signal?.aborted ?? false,
          liveFanout,
        };
      }
      if (changed) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            wake = undefined;
            resolve();
          },
          Math.max(0, Math.min(1_000, deadline - Date.now())),
        );
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
        if (changed || input.signal?.aborted) wake();
      });
    }
  } finally {
    input.signal?.removeEventListener("abort", notify);
    unsubscribe?.();
  }
}
