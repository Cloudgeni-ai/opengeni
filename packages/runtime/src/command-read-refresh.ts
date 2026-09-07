import type { AttemptToolResult } from "@opengeni/contracts";

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
    if (!(await input.refresh(input.args.commandId))) {
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
      return finishReceipt(result, started, seconds);
    }
    // Reuse the API's existing one-second durable recheck wait. Each iteration
    // reauthorizes, and the next owner refresh happens before any long wait.
    result = await input.call({ ...input.args, waitSeconds: 1 });
  }
}

function finishReceipt(
  result: AttemptToolResult,
  started: number,
  seconds: number,
): AttemptToolResult {
  const snapshot = commandSnapshot(result);
  if (!snapshot) return result;
  const waitedMs = Date.now() - started;
  return {
    ...result,
    content: result.content.map((part, index) =>
      index === 0 && part.type === "text"
        ? {
            ...part,
            text: JSON.stringify({
              ...snapshot,
              waitedMs,
              timedOut:
                seconds > 0 &&
                waitedMs >= seconds * 1000 &&
                !snapshot.terminal &&
                !snapshot.chunks.length &&
                !snapshot.hasMore,
            }),
          }
        : part,
    ),
  };
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
