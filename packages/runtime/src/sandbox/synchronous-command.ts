import type { ChannelAExecArgs, ChannelAExecResult, ChannelASession } from "./channel-a";
import {
  hasTypedExecHandleLoss,
  isExecSessionLostBanner,
  parseExecResponseBanner,
} from "./exec-banner";

export type SynchronousCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  wallTimeSeconds: number;
};

export type SynchronousCommandPage = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  sessionId?: number;
  wallTimeSeconds: number;
  outputCursor?: {
    identity: string;
    expected: { stdout: number; stderr: number };
    next: { stdout: number; stderr: number };
  };
};

/** Observation failure is not operation failure or permission to start again. */
export class SynchronousCommandOutcomeUnknownError extends Error {
  readonly code = "synchronous_command_outcome_unknown";
  constructor(
    readonly sessionId: number | null,
    readonly output: { stdout: string; stderr: string },
    cause?: unknown,
  ) {
    super(
      "Internal filesystem command completion is pending or unknown; the original invocation was not replayed.",
      { cause },
    );
    this.name = "SynchronousCommandOutcomeUnknownError";
  }
}

/** Snapshot before routing commits/acknowledges the raw provider receipt. The
 * protocol must consume complete separate streams, not a human-facing tail. */
export function synchronousCommandPage(
  session: Pick<ChannelASession, "getProviderCommandOutput">,
  raw: string | ChannelAExecResult,
  originalSessionId?: number,
): SynchronousCommandPage {
  const page = session.getProviderCommandOutput?.(raw);
  if (
    !page &&
    typeof raw === "string" &&
    originalSessionId !== undefined &&
    !hasTypedExecHandleLoss(session, originalSessionId) &&
    isExecSessionLostBanner(raw, originalSessionId)
  ) {
    throw new SynchronousCommandOutcomeUnknownError(
      originalSessionId,
      { stdout: "", stderr: "" },
      new Error("Original provider handle lost before its exit could be authenticated"),
    );
  }
  const banner = typeof raw === "string" ? parseExecResponseBanner(raw) : null;
  const delimiter = typeof raw === "string" ? /\r?\nOutput:\r?\n/u.exec(raw) : null;
  const framedOutput =
    typeof raw === "string"
      ? delimiter
        ? raw.slice(delimiter.index + delimiter[0].length)
        : raw.startsWith("Output:\n")
          ? raw.slice(8)
          : raw
      : "";
  const command = page?.command;
  const streamsComplete =
    command?.kind !== "modal-router-v1" ||
    (command.streams.stdout.eof && command.streams.stderr.eof);
  return {
    stdout: page
      ? page.chunks
          .filter((chunk) => chunk.stream === "stdout")
          .map((chunk) => chunk.text)
          .join("")
      : typeof raw === "string"
        ? framedOutput
        : (raw.stdout ?? raw.output ?? ""),
    stderr: page
      ? page.chunks
          .filter((chunk) => chunk.stream === "stderr")
          .map((chunk) => chunk.text)
          .join("")
      : typeof raw === "string"
        ? ""
        : (raw.stderr ?? ""),
    exitCode: page
      ? streamsComplete
        ? (page.exitCode ?? null)
        : null
      : typeof raw === "string"
        ? banner?.kind === "exited"
          ? banner.exitCode
          : null
        : (raw.exitCode ?? null),
    ...(typeof raw === "string"
      ? banner?.kind === "running"
        ? { sessionId: banner.sessionId }
        : {}
      : typeof raw.sessionId === "number"
        ? { sessionId: raw.sessionId }
        : {}),
    wallTimeSeconds: typeof raw === "string" ? 0 : (raw.wallTimeSeconds ?? 0),
    ...(command?.kind === "modal-router-v1"
      ? {
          outputCursor: {
            identity: JSON.stringify([command.sandboxId, command.taskId, command.execId]),
            expected: {
              stdout:
                page?.expected?.streams.stdout.byteOffset ?? command.streams.stdout.byteOffset,
              stderr:
                page?.expected?.streams.stderr.byteOffset ?? command.streams.stderr.byteOffset,
            },
            next: {
              stdout: command.streams.stdout.byteOffset,
              stderr: command.streams.stderr.byteOffset,
            },
          },
        }
      : {}),
  };
}

/** Start exactly once. This is deliberately not the interactive/background
 * shell runner: no PTY default, wrapping, timeout, adoption, or output tail. */
export async function executeSynchronousCommand(
  session: ChannelASession,
  args: ChannelAExecArgs,
): Promise<SynchronousCommandResult> {
  if (session.execSynchronous) return await session.execSynchronous(args);
  const raw = session.exec
    ? await session.exec(args)
    : session.execCommand
      ? await session.execCommand(args)
      : null;
  if (raw === null) throw new Error("Sandbox does not support internal command execution");
  const read =
    session.writeStdinForProcessControl?.bind(session) ?? session.writeStdin?.bind(session);
  return await observeSynchronousCommand(
    synchronousCommandPage(session, raw),
    async (sessionId) => {
      if (!read) throw new Error("Original command has no observation capability");
      return synchronousCommandPage(
        session,
        await read({
          sessionId,
          chars: "",
          yieldTimeMs: 1_000,
          ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
        }),
        sessionId,
      );
    },
  );
}

/** The read closure is bound to the original backend and locator. Only a
 * terminal provider receipt, including EOF where required, completes the call. */
export async function observeSynchronousCommand(
  initial: SynchronousCommandPage,
  read: (sessionId: number) => Promise<SynchronousCommandPage>,
): Promise<SynchronousCommandResult> {
  const startedAt = performance.now();
  const sessionId = initial.sessionId ?? null;
  let stdout = initial.stdout;
  let stderr = initial.stderr;
  let page = initial;
  let cursor = initial.outputCursor;
  while (true) {
    if (page.sessionId === undefined && page.exitCode !== null) {
      return {
        stdout,
        stderr,
        exitCode: page.exitCode,
        wallTimeSeconds: Math.max(initial.wallTimeSeconds, (performance.now() - startedAt) / 1_000),
      };
    }
    if (sessionId === null) {
      throw new SynchronousCommandOutcomeUnknownError(null, { stdout, stderr });
    }
    try {
      page = await read(sessionId);
      if (page.sessionId !== undefined && page.sessionId !== sessionId) {
        throw new Error("Command observation returned a different execution handle");
      }
      if (
        cursor &&
        page.outputCursor &&
        (cursor.identity !== page.outputCursor.identity ||
          cursor.next.stdout !== page.outputCursor.expected.stdout ||
          cursor.next.stderr !== page.outputCursor.expected.stderr)
      ) {
        // An independent collector can advance durable custody. Without those
        // intervening bytes this call cannot honestly return a complete result.
        throw new Error(
          "Original command output cursor advanced outside this observation; result bytes are incomplete",
        );
      }
    } catch (cause) {
      throw new SynchronousCommandOutcomeUnknownError(sessionId, { stdout, stderr }, cause);
    }
    stdout += page.stdout;
    stderr += page.stderr;
    cursor = page.outputCursor ?? cursor;
    if (page.sessionId !== undefined || page.exitCode === null) {
      // Providers normally block for the requested yield; avoid a hot loop if
      // a provider returns an empty or immediately available page instead.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
