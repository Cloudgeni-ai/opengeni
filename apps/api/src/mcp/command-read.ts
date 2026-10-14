import type { SessionEvent } from "@opengeni/contracts";
import { COMMAND_OUTPUT_MAX_BYTES } from "@opengeni/db/session-background-commands";

export const COMMAND_READ_MAX_WAIT_SECONDS = 50;
export const COMMAND_WAIT_DEFAULT_SECONDS = 45;

/**
 * Poll floor (settings.experimentPollFloor, off by default): a waiting read of
 * a command without a TTY does not return on the first new output chunk before
 * `floorMs`. It still returns at once on exit, hasMore, abort or the deadline,
 * and early when output arrived and then stayed quiet for `outputQuietMs`, or
 * when the output ends in an input prompt and stayed quiet for
 * `promptQuietMs`. These are the runtime's cut-polling signals.
 */
export type CommandReadPollFloor = {
  floorMs: number;
  outputQuietMs: number;
  promptQuietMs: number;
  looksLikeInputPrompt: (output: string) => boolean;
};

const FLOOR_REREAD_MS = 500;

function chunkText(chunks: unknown[]): string {
  return chunks
    .map((chunk) =>
      chunk !== null &&
      typeof chunk === "object" &&
      typeof (chunk as { chunk?: unknown }).chunk === "string"
        ? (chunk as { chunk: string }).chunk
        : "",
    )
    .join("");
}

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
  /** Only for a waiting read (waitSeconds > 0) of a command without a TTY. */
  pollFloor?: CommandReadPollFloor | undefined;
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
  // The floor never applies to an immediate read (waitSeconds 0).
  const floor = seconds > 0 ? input.pollFloor : undefined;
  const deadline = started + Math.max(seconds * 1000, floor?.floorMs ?? 0);
  // Every read restarts at the caller's cursor, so a held result carries all
  // output since that cursor; track when it last grew.
  let seenOutput = "";
  let lastOutputAt: number | null = null;
  let unsubscribe: (() => void) | undefined;
  let wake: (() => void) | undefined;
  let changed = false;
  let liveFanout = true;
  const notify = () => {
    changed = true;
    wake?.();
  };
  input.signal?.addEventListener("abort", notify);
  // Under the floor an output delta does not end the wait, so it must not
  // trigger an immediate durable re-read either (a chatty command would turn
  // the wait into a read loop). Exit and abort still wake at once; output is
  // picked up by the periodic re-read.
  try {
    if (seconds > 0) {
      try {
        unsubscribe = await input.subscribe((events) => {
          if (
            events.some(
              (event) =>
                (event.type === "session.command.finished" ||
                  (event.type === "sandbox.command.output.delta" && !floor)) &&
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
      const now = Date.now();
      const expired = now >= deadline;
      let returnOnOutput = result.chunks.length > 0;
      if (floor && returnOnOutput) {
        const output = chunkText(result.chunks);
        if (output !== seenOutput) {
          seenOutput = output;
          lastOutputAt = now;
        }
        const quietMs = lastOutputAt === null ? 0 : now - lastOutputAt;
        returnOnOutput =
          now - started >= floor.floorMs ||
          quietMs >= floor.outputQuietMs ||
          (quietMs >= floor.promptQuietMs && floor.looksLikeInputPrompt(output));
      }
      if (result.terminal || returnOnOutput || result.hasMore || expired || input.signal?.aborted) {
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
          // Under the floor, re-read often enough to see output go quiet.
          Math.max(0, Math.min(floor ? FLOOR_REREAD_MS : 1_000, deadline - Date.now())),
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
