import type { AttemptToolResult } from "@opengeni/contracts";
import { ProviderCommandObservationUnavailableError } from "./sandbox/provider-command-session";
import { SelfhostedControlError } from "./sandbox/selfhosted/control-rpc";
import { OpStreamUnavailableError } from "./sandbox/selfhosted/op-transport";

/** First-party execution edge only. API reads authorize before provider access
 * and remain the sole terminal-observation authority. No background poller. */
export async function executeCommandReadWithRefresh(input: {
  toolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  refresh: (commandId: string) => Promise<boolean>;
  call: (args: Record<string, unknown>) => Promise<AttemptToolResult>;
}): Promise<AttemptToolResult> {
  const seconds = input.args.waitSeconds ?? (input.toolName === "command_wait" ? 45 : 0);
  if (
    typeof input.args.commandId !== "string" ||
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > 50
  )
    return await input.call(input.args);
  const started = Date.now();
  const deadline = started + seconds * 1000;
  let result = await input.call({ ...input.args, waitSeconds: 0 });
  while (true) {
    const snapshot = commandSnapshot(result);
    if (!snapshot || snapshot.terminal || input.signal?.aborted)
      return finishReceipt(result, started, seconds);
    let refreshedOwner: boolean;
    let refreshUnavailable = false;
    try {
      refreshedOwner = await input.refresh(input.args.commandId);
    } catch (error) {
      if (input.signal?.aborted || !isTransientRefreshFailure(error)) throw error;
      // A failed live refresh must not hide durable output. The reread below
      // reauthorizes rather than serving a cached receipt after authority
      // changed. Within the caller's own wait, the next iteration refreshes
      // the same retained command again exactly like a quiet refresh; that is
      // a read only, never a Start or stdin replay.
      refreshedOwner = true;
      refreshUnavailable = true;
    }
    if (!refreshedOwner) {
      return finishReceipt(
        await input.call({
          ...input.args,
          waitSeconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
        }),
        started,
        seconds,
      );
    }
    result = await input.call({ ...input.args, waitSeconds: 0 });
    const refreshed = commandSnapshot(result);
    if (!refreshed) return result;
    const expired = Date.now() >= deadline;
    if (
      refreshed.terminal ||
      refreshed.chunks.length ||
      refreshed.hasMore ||
      expired ||
      input.signal?.aborted
    ) {
      return finishReceipt(
        refreshUnavailable && !refreshed.terminal
          ? patchReceipt(result, {
              freshness: { status: "refresh_unavailable", retryable: true },
            })
          : result,
        started,
        seconds,
      );
    }
    // Reuse the API's existing one-second durable recheck wait. Each iteration
    // reauthorizes, and the next owner refresh happens before any long wait.
    result = await input.call({ ...input.args, waitSeconds: 1 });
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

function patchReceipt(
  result: AttemptToolResult,
  fields: {
    waitedMs?: number;
    timedOut?: boolean;
    freshness?: { status: "refresh_unavailable"; retryable: true };
  },
): AttemptToolResult {
  const snapshot = commandSnapshot(result);
  if (!snapshot) return result;
  return {
    ...result,
    ...(result.structuredContent
      ? { structuredContent: { ...result.structuredContent, ...fields } }
      : {}),
    content: result.content.map((part, index) =>
      index === 0 && part.type === "text"
        ? { ...part, text: JSON.stringify({ ...snapshot, ...fields }) }
        : part,
    ),
  };
}

function finishReceipt(
  result: AttemptToolResult,
  started: number,
  seconds: number,
): AttemptToolResult {
  const snapshot = commandSnapshot(result);
  if (!snapshot) return result;
  const waitedMs = Date.now() - started;
  return patchReceipt(result, {
    waitedMs,
    timedOut:
      seconds > 0 &&
      waitedMs >= seconds * 1000 &&
      !snapshot.terminal &&
      !snapshot.chunks.length &&
      !snapshot.hasMore,
  });
}

function commandSnapshot(
  result: AttemptToolResult,
): ({ terminal: boolean; chunks: unknown[]; hasMore?: boolean } & Record<string, unknown>) | null {
  if (result.isError || result.content[0]?.type !== "text") return null;
  try {
    const value = JSON.parse(result.content[0].text);
    return value && typeof value.terminal === "boolean" && Array.isArray(value.chunks)
      ? value
      : null;
  } catch {
    return null;
  }
}
