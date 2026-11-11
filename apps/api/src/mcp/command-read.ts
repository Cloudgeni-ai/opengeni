import type { SessionEvent } from "@opengeni/contracts";
import {
  COMMAND_OUTPUT_DEFAULT_BYTES,
  COMMAND_OUTPUT_MAX_BYTES,
} from "@opengeni/db/session-background-commands";

export const COMMAND_READ_MAX_WAIT_SECONDS = 50;
export const COMMAND_WAIT_DEFAULT_SECONDS = 45;
/** command_read also waits by default while the command runs. */
export const COMMAND_READ_DEFAULT_SECONDS = 30;
/** Most commands one command_wait call can wait on together. */
export const COMMAND_WAIT_MAX_COMMANDS = 8;
/** Steer notice that rechecks `yieldTo` at once. */
const YIELD_EVENT_TYPE = "session.control.steer_requested";
const YIELD_RECHECK_MS = 5_000;
/** Durable state recheck while live hints are quiet or lost. */
const DURABLE_RECHECK_MS = 1_000;

type CommandReadShape = { terminal: boolean; chunks: unknown[]; hasMore?: boolean };

type WaitControls = {
  waitSeconds?: number;
  maxOutputBytes?: number | undefined;
  signal?: AbortSignal;
  subscribe: (onEvents: (events: SessionEvent[]) => void) => Promise<() => void>;
  /**
   * Ends the wait early with the ordinary current read when true, for example
   * once a Steer waits for the caller's turn. Checked at the start, on each
   * Steer notice and at most every few seconds; the command keeps running.
   */
  yieldTo?: (() => Promise<boolean>) | undefined;
};

function validateWaitControls(input: {
  waitSeconds?: number;
  maxOutputBytes?: number | undefined;
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
  return seconds;
}

/**
 * Waits until the listed commands settle (all of them, or any one), the
 * deadline passes, the caller must yield, or the request aborts. New output
 * alone does not end the wait: the read that follows returns the start and end
 * of everything produced meanwhile. Notifications are only wake hints; settled
 * state always comes from `isTerminal`, which reads durable state. Subscribing
 * before the first check closes the finish/subscription race, and the periodic
 * recheck covers lost hints.
 */
async function waitForCommands(
  input: WaitControls & {
    commandIds: string[];
    waitFor: "all" | "any";
    seconds: number;
    isTerminal: (commandId: string) => Promise<boolean>;
  },
): Promise<{ liveFanout: boolean; yielded: boolean }> {
  const deadline = Date.now() + input.seconds * 1000;
  const watched = new Set(input.commandIds);
  const pending = new Set(input.commandIds);
  let unsubscribe: (() => void) | undefined;
  let wake: (() => void) | undefined;
  let changed = false;
  let liveFanout = true;
  let yieldDue = input.yieldTo !== undefined;
  let yieldCheckedAt = 0;
  const notify = () => {
    changed = true;
    wake?.();
  };
  input.signal?.addEventListener("abort", notify);
  try {
    try {
      unsubscribe = await input.subscribe((events) => {
        if (
          events.some(
            (event) =>
              event.type === "session.command.finished" &&
              event.payload !== null &&
              typeof event.payload === "object" &&
              watched.has(String((event.payload as Record<string, unknown>).commandId)),
          )
        )
          notify();
        if (input.yieldTo && events.some((event) => event.type === YIELD_EVENT_TYPE)) {
          yieldDue = true;
          notify();
        }
      });
    } catch {
      liveFanout = false;
    }
    while (true) {
      changed = false;
      for (const commandId of [...pending]) {
        if (await input.isTerminal(commandId)) pending.delete(commandId);
      }
      const settled =
        input.waitFor === "all" ? pending.size === 0 : pending.size < input.commandIds.length;
      let yielded = false;
      if (input.yieldTo && (yieldDue || Date.now() - yieldCheckedAt >= YIELD_RECHECK_MS)) {
        yieldDue = false;
        yieldCheckedAt = Date.now();
        yielded = await input.yieldTo();
      }
      if (settled || yielded || Date.now() >= deadline || input.signal?.aborted) {
        return { liveFanout, yielded };
      }
      if (changed) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            wake = undefined;
            resolve();
          },
          Math.max(0, Math.min(DURABLE_RECHECK_MS, deadline - Date.now())),
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

/** Shared provider-neutral command_read/command_wait operation for one
 * command. With a wait, it returns once the command settles (or on deadline,
 * yield or abort), then reads its output once; without one it reads at once.
 * Every result, including timeout, comes from durable DB state. */
export async function readCommandWithWait<T extends CommandReadShape>(
  input: WaitControls & {
    commandId: string;
    read: () => Promise<T>;
    /** Cheap durable state check used while waiting; defaults to `read`. */
    isTerminal?: (() => Promise<boolean>) | undefined;
  },
) {
  const seconds = validateWaitControls(input);
  const started = Date.now();
  let liveFanout = true;
  let yielded = false;
  if (seconds > 0) {
    const isTerminal = input.isTerminal ?? (async () => (await input.read()).terminal);
    ({ liveFanout, yielded } = await waitForCommands({
      ...input,
      commandIds: [input.commandId],
      waitFor: "all",
      seconds,
      isTerminal: async () => await isTerminal(),
    }));
  }
  const result = await input.read();
  const waitedMs = Date.now() - started;
  return {
    ...result,
    waitedMs,
    timedOut: seconds > 0 && !result.terminal && !yielded && waitedMs >= seconds * 1000,
    aborted: input.signal?.aborted ?? false,
    liveFanout,
    ...(yielded ? { yielded: true as const } : {}),
  };
}

/** The same operation for several commands at once: waits until all (or any)
 * of them settle, then reads each one, splitting the output budget evenly. */
export async function readCommandsWithWait<T extends CommandReadShape>(
  input: WaitControls & {
    commandIds: string[];
    waitFor?: "all" | "any" | undefined;
    read: (commandId: string, maxOutputBytes: number | undefined) => Promise<T>;
    isTerminal: (commandId: string) => Promise<boolean>;
  },
) {
  const seconds = validateWaitControls(input);
  const commandIds = [...new Set(input.commandIds)];
  if (commandIds.length === 0) throw new Error("Pass at least one command ID");
  if (commandIds.length > COMMAND_WAIT_MAX_COMMANDS)
    throw new Error(`command_wait accepts at most ${COMMAND_WAIT_MAX_COMMANDS} commands`);
  const waitFor = input.waitFor ?? "all";
  const started = Date.now();
  let liveFanout = true;
  let yielded = false;
  if (seconds > 0) {
    ({ liveFanout, yielded } = await waitForCommands({
      ...input,
      commandIds,
      waitFor,
      seconds,
    }));
  }
  const budget = input.maxOutputBytes ?? COMMAND_OUTPUT_DEFAULT_BYTES;
  const share = Math.max(4, Math.floor(budget / commandIds.length));
  const commands: T[] = [];
  for (const commandId of commandIds) commands.push(await input.read(commandId, share));
  const settled =
    waitFor === "all"
      ? commands.every((command) => command.terminal)
      : commands.some((command) => command.terminal);
  const waitedMs = Date.now() - started;
  return {
    commands,
    waitFor,
    waitedMs,
    timedOut: seconds > 0 && !settled && !yielded && waitedMs >= seconds * 1000,
    aborted: input.signal?.aborted ?? false,
    liveFanout,
    ...(yielded ? { yielded: true as const } : {}),
  };
}
