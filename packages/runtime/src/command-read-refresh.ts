import type { AttemptToolResult } from "@opengeni/contracts";
import { ProviderCommandObservationUnavailableError } from "./sandbox/provider-command-session";
import { SelfhostedControlError } from "./sandbox/selfhosted/control-rpc";
import { OpStreamUnavailableError } from "./sandbox/selfhosted/op-transport";

/** Default waits, matching the API's command_read and command_wait. */
const COMMAND_READ_DEFAULT_SECONDS = 30;
const COMMAND_WAIT_DEFAULT_SECONDS = 45;
const COMMAND_READ_MAX_WAIT_SECONDS = 50;
/** The least time one live refresh gets, so a read that asked for no wait
 * (or has under this left) still refreshes a machine that answers. */
const MIN_REFRESH_BUDGET_MS = 5_000;

/** A live refresh still going when its budget ran out. */
const REFRESH_TIMED_OUT = Symbol("refresh timed out");

/** `refresh(commandId)`, unless it is still going after `budgetMs` or `signal`
 * aborts first: a machine that does not answer (its host restarting, say) can
 * hold a refresh for minutes, longer than the caller's wait. Then the read
 * goes on without it; the refresh, a read only, settles by itself. */
async function refreshWithin(
  refresh: (commandId: string) => Promise<boolean>,
  commandId: string,
  budgetMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean | typeof REFRESH_TIMED_OUT> {
  const refreshing = refresh(commandId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      refreshing,
      new Promise<typeof REFRESH_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(REFRESH_TIMED_OUT), Math.max(0, budgetMs));
        onAbort = () => resolve(REFRESH_TIMED_OUT);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // Settled unobserved once the budget ran out: never an unhandled rejection.
    refreshing.catch(() => undefined);
  }
}

/** First-party execution edge only. API reads authorize before provider access
 * and remain the sole terminal-observation authority. No background poller.
 * Like the API wait, it returns once the commands settle (all, or any for
 * `waitFor: "any"`), at the deadline, or when the API reports a yield; new
 * output alone does not end it. */
export async function executeCommandReadWithRefresh(input: {
  toolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  refresh: (commandId: string) => Promise<boolean>;
  call: (args: Record<string, unknown>) => Promise<AttemptToolResult>;
  /** The least time the live refreshes get in all; tests shorten it. */
  minRefreshBudgetMs?: number;
}): Promise<AttemptToolResult> {
  const seconds =
    input.args.waitSeconds ??
    (input.toolName === "command_wait"
      ? COMMAND_WAIT_DEFAULT_SECONDS
      : COMMAND_READ_DEFAULT_SECONDS);
  const multi = Array.isArray(input.args.commandIds);
  if (
    (multi
      ? !(input.args.commandIds as unknown[]).every((id) => typeof id === "string")
      : typeof input.args.commandId !== "string") ||
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > COMMAND_READ_MAX_WAIT_SECONDS
  )
    return await input.call(input.args);
  const waitFor = input.args.waitFor === "any" ? "any" : "all";
  const started = Date.now();
  const deadline = started + seconds * 1000;
  // The refreshes all end by the caller's deadline, or a few seconds in for a
  // shorter wait: one bound for the whole read, however many commands it
  // refreshes, so several slow refreshes cannot add up past it.
  const refreshDeadline = Math.max(
    deadline,
    started + (input.minRefreshBudgetMs ?? MIN_REFRESH_BUDGET_MS),
  );
  const finish = (
    result: AttemptToolResult,
    unavailable: ReadonlySet<string> = new Set(),
    deadlineReached = false,
  ) => finishReceipt(result, started, seconds, waitFor, unavailable, deadlineReached);
  let result = await input.call({ ...input.args, waitSeconds: 0 });
  while (true) {
    const snapshot = commandSnapshot(result, waitFor);
    if (!snapshot || snapshot.settled || snapshot.yielded || input.signal?.aborted)
      return finish(result);
    let refreshedOwner = false;
    const unavailable = new Set<string>();
    let outOfTime = false;
    for (const [index, commandId] of snapshot.running.entries()) {
      // Bounded by what is left of the read's refresh time, so an unanswering
      // machine cannot stretch a 50-second wait to minutes.
      try {
        const refreshed = await refreshWithin(
          input.refresh,
          commandId,
          refreshDeadline - Date.now(),
          input.signal,
        );
        if (refreshed === REFRESH_TIMED_OUT) {
          // Unanswered within the wait: like a transient failure, the retained
          // output stands, marked as not fresh, as it does for the commands
          // this pass did not get to.
          refreshedOwner = true;
          for (const skipped of snapshot.running.slice(index)) unavailable.add(skipped);
          outOfTime = true;
          break;
        }
        if (refreshed) refreshedOwner = true;
      } catch (error) {
        if (input.signal?.aborted || !isTransientRefreshFailure(error)) throw error;
        // A failed live refresh must not hide durable output. The reread below
        // reauthorizes rather than serving a cached receipt after authority
        // changed. Within the caller's own wait, the next iteration refreshes
        // the same retained command again exactly like a quiet refresh; that is
        // a read only, never a Start or stdin replay.
        refreshedOwner = true;
        unavailable.add(commandId);
      }
    }
    if (outOfTime) {
      if (input.signal?.aborted) return finish(result, unavailable);
      // The wait is spent: one last reread without waiting, which reauthorizes
      // and picks up anything the command recorded meanwhile.
      const last = await input.call({ ...input.args, waitSeconds: 0 });
      return finish(last, unavailable, true);
    }
    if (!refreshedOwner) {
      return finish(
        await input.call({
          ...input.args,
          waitSeconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
        }),
      );
    }
    // One reread per refresh: the API's one-second wait checks for the finish
    // before it sleeps, reauthorizes, and returns at once when the command
    // settled; under a second before the deadline it reads without waiting.
    result = await input.call({
      ...input.args,
      waitSeconds: deadline - Date.now() >= 1000 ? 1 : 0,
    });
    const refreshed = commandSnapshot(result, waitFor);
    if (!refreshed) return result;
    if (refreshed.settled || refreshed.yielded || input.signal?.aborted) {
      return finish(result, unavailable);
    }
    // Under a second left: that read was the last, not the start of a burst.
    if (Date.now() >= deadline - 1000) return finish(result, unavailable, true);
  }
}

/** Fail closed for unknown faults, fencing, consent, and integrity errors.
 * Neither exception text nor a generic retryable flag is sufficient evidence.
 * A provider observation that missed its bounded read window is transient only
 * when the provider itself marked another read of the same invocation safe. */
function isTransientRefreshFailure(error: unknown): boolean {
  if (error instanceof ProviderCommandObservationUnavailableError) return error.readRetryAllowed;
  if (error instanceof SelfhostedControlError) {
    return (
      !error.fenced &&
      !error.payloadTooLarge &&
      (error.agentOffline || error.reason === "agent_reconnecting" || error.draining)
    );
  }
  if (error instanceof OpStreamUnavailableError) return error.unavailableKind === "transport";
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return (
    typeof code === "string" &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_AGAIN",
    ].includes(code)
  );
}

type CommandReceipt = { terminal: boolean; chunks: unknown[] } & Record<string, unknown>;

function isCommandReceipt(value: unknown): value is CommandReceipt {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).terminal === "boolean" &&
    Array.isArray((value as Record<string, unknown>).chunks)
  );
}

/** One read (`commandId`) or several (`commandIds`, under `commands`). */
function commandSnapshot(
  result: AttemptToolResult,
  waitFor: "all" | "any",
): {
  value: Record<string, unknown>;
  settled: boolean;
  yielded: boolean;
  running: string[];
} | null {
  if (result.isError || result.content[0]?.type !== "text") return null;
  let value: unknown;
  try {
    value = JSON.parse(result.content[0].text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const commands = Array.isArray(record.commands) ? record.commands : [record];
  if (commands.length === 0 || !commands.every(isCommandReceipt)) return null;
  const running = commands.filter((command) => !command.terminal);
  return {
    value: record,
    settled: waitFor === "all" ? running.length === 0 : running.length < commands.length,
    yielded: record.yielded === true,
    running: running.flatMap((command) =>
      typeof command.commandId === "string" ? [command.commandId] : [],
    ),
  };
}

function finishReceipt(
  result: AttemptToolResult,
  started: number,
  seconds: number,
  waitFor: "all" | "any",
  unavailable: ReadonlySet<string>,
  deadlineReached = false,
): AttemptToolResult {
  const snapshot = commandSnapshot(result, waitFor);
  if (!snapshot) return result;
  const waitedMs = Date.now() - started;
  const freshness = { status: "refresh_unavailable", retryable: true } as const;
  const stale = (command: CommandReceipt) =>
    !command.terminal && typeof command.commandId === "string" && unavailable.has(command.commandId)
      ? { ...command, freshness }
      : command;
  const value = Array.isArray(snapshot.value.commands)
    ? { ...snapshot.value, commands: (snapshot.value.commands as CommandReceipt[]).map(stale) }
    : stale(snapshot.value as CommandReceipt);
  const fields = {
    waitedMs,
    timedOut:
      seconds > 0 &&
      (deadlineReached || waitedMs >= seconds * 1000) &&
      !snapshot.settled &&
      !snapshot.yielded,
  };
  const patched = { ...value, ...fields };
  return {
    ...result,
    ...(result.structuredContent
      ? { structuredContent: patched as NonNullable<AttemptToolResult["structuredContent"]> }
      : {}),
    content: result.content.map((part, index) =>
      index === 0 && part.type === "text" ? { ...part, text: JSON.stringify(patched) } : part,
    ),
  };
}
