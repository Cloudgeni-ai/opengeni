import type { Computer, Editor, Tool } from "@openai/agents";

import { runWithToolCallCorrelation, sanitizeOpIdToken } from "./op-correlation";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "./channel-a";

const TURN_EXEC_YIELD_MS = 250;
const TURN_WRITE_YIELD_MS = 250;
const SHELL_HELPER_YIELD_MS = 1_000;
const SHELL_GRACEFUL_POLLS = 2;
const SHELL_POLL_MS = 100;
const SHELL_MARKER_DIR = "/tmp/opengeni-turn-shell";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;
type FunctionToolInvoke = FunctionTool["invoke"];

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

type ShellProcessIdentity = {
  pid: number;
  processGroupId: number;
};

type ActiveShellSession = {
  sessionId: number;
  markerPath: string | null;
  token: string | null;
  runContext: Parameters<FunctionToolInvoke>[0];
  execInvoke: FunctionToolInvoke;
  writeInvoke: FunctionToolInvoke | null;
  identity: ShellProcessIdentity | null;
  identityValidated: boolean;
  cancellation: Promise<void> | null;
};

type CommandCancellationSession = {
  cancelExecCommand?(opId: string): Promise<boolean>;
  supportsPty?(): boolean;
};

export type TurnSandboxCommandArgs = {
  cmd: string;
  workdir?: string;
  shell?: string;
  login?: boolean;
  tty?: boolean;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  runAs?: string;
};

export type TurnSandboxCommandSession = CommandCancellationSession & {
  exec?(args: TurnSandboxCommandArgs): Promise<unknown>;
  execCommand?(args: TurnSandboxCommandArgs): Promise<string>;
  writeStdin?(args: {
    sessionId: number;
    chars?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }): Promise<string>;
};

type ActiveRemoteExec = {
  settled: boolean;
  settledPromise: Promise<void>;
  settle(): void;
  cancel(): Promise<void>;
};

/**
 * The worker may publish an attempt-quiesced receipt only after this fence
 * resolves. `cancel()` prevents new turn-owned sandbox calls, actively stops
 * shell processes, and `waitForQuiescence()` drains every capability call that
 * was already in flight. Cleanup/telemetry outside the sandbox capability set
 * remains independently attempt-fenced.
 */
export type TurnToolCancellationFence = {
  cancel(reason?: unknown): void;
  waitForQuiescence(): Promise<void>;
  runSandboxCommand(
    session: TurnSandboxCommandSession,
    args: TurnSandboxCommandArgs,
  ): Promise<unknown>;
};

export type TurnToolCancellationController = TurnToolCancellationFence & {
  wrapTools(tools: Tool<unknown>[], session?: CommandCancellationSession): Tool<unknown>[];
};

export class TurnSandboxCommandCancelledError extends Error {
  readonly name = "TurnSandboxCommandCancelledError";

  constructor(reason: unknown) {
    super(
      reason instanceof Error
        ? reason.message
        : String(reason ?? "Turn sandbox tools were cancelled"),
      {
        ...(reason instanceof Error ? { cause: reason } : {}),
      },
    );
  }
}

function cancellationError(reason: unknown): Error {
  return new TurnSandboxCommandCancelledError(reason);
}

function parsedObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cappedYield(value: unknown, cap: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, cap)
    : cap;
}

function execOutput(raw: string): string {
  const marker = "\nOutput:\n";
  const index = raw.indexOf(marker);
  return index >= 0 ? raw.slice(index + marker.length) : "";
}

function nativeCommandBanner(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") {
    throw new Error("Sandbox command returned an invalid result");
  }
  const value = result as {
    output?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    exitCode?: unknown;
    exit_code?: unknown;
    sessionId?: unknown;
    session_id?: unknown;
  };
  const sessionId =
    typeof value.sessionId === "number"
      ? value.sessionId
      : typeof value.session_id === "number"
        ? value.session_id
        : null;
  const exitCode =
    typeof value.exitCode === "number"
      ? value.exitCode
      : typeof value.exit_code === "number"
        ? value.exit_code
        : null;
  const output = [value.output, value.stderr, value.stdout]
    .filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    )
    .join("\n");
  if (sessionId !== null) {
    return `Process running with session ID ${sessionId}\n\nOutput:\n${output}`;
  }
  if (exitCode !== null) {
    return `Process exited with code ${exitCode}\n\nOutput:\n${output}`;
  }
  throw new Error("Sandbox command did not report a session id or exit code");
}

function completedCommandBanner(exitCode: number, output: string): string {
  return `Process exited with code ${exitCode}\n\nOutput:\n${output}`;
}

function appendBoundedOutput(current: string, chunk: string, maxOutputTokens: number): string {
  const maxChars = Math.max(512, maxOutputTokens * 4);
  const combined = current + chunk;
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellMarkerPath(token: string): string {
  return `${SHELL_MARKER_DIR}/${token}`;
}

function cancellableGroupLeaderCommand(command: string, markerPath: string): string {
  const marker = singleQuote(markerPath);
  const markerDir = singleQuote(SHELL_MARKER_DIR);
  return [
    `__opengeni_marker=${marker}`,
    "umask 077",
    `command mkdir -p ${markerDir} || exit 125`,
    '__opengeni_pid="$$"',
    '__opengeni_pgid="$(command ps -o pgid= -p "$__opengeni_pid" 2>/dev/null | command tr -d \'[:space:]\')"',
    'case "$__opengeni_pid:$__opengeni_pgid" in *[!0-9:]*|*:|:*) exit 125 ;; esac',
    '[ "$__opengeni_pid" -gt 1 ] && [ "$__opengeni_pgid" -gt 1 ] || exit 125',
    // Never signal a provider/container-wide process group. A cancellable PTY
    // command must be its group's leader; fail the command closed otherwise.
    '[ "$__opengeni_pid" = "$__opengeni_pgid" ] || exit 125',
    'command printf \'%s %s\\n\' "$__opengeni_pid" "$__opengeni_pgid" > "$__opengeni_marker" || exit 125',
    "trap 'command rm -f \"$__opengeni_marker\"' EXIT",
    "(",
    command,
    ")",
    "__opengeni_status=$?",
    'exit "$__opengeni_status"',
  ].join("\n");
}

export function cancellableShellCommand(command: string, markerPath: string): string {
  const groupLeaderCommand = cancellableGroupLeaderCommand(command, markerPath);
  return [
    '__opengeni_outer_pid="$$"',
    '__opengeni_outer_pgid="$(command ps -o pgid= -p "$__opengeni_outer_pid" 2>/dev/null | command tr -d \'[:space:]\')"',
    'case "$__opengeni_outer_pid:$__opengeni_outer_pgid" in *[!0-9:]*|*:|:*) exit 125 ;; esac',
    'if [ "$__opengeni_outer_pid" != "$__opengeni_outer_pgid" ]; then',
    '  __opengeni_setsid="$(command -v setsid 2>/dev/null)"',
    '  [ -n "$__opengeni_setsid" ] || exit 125',
    `  exec "$__opengeni_setsid" /bin/sh -c ${singleQuote(groupLeaderCommand)}`,
    "fi",
    groupLeaderCommand,
  ].join("\n");
}

function shellHelperInput(command: string): string {
  return JSON.stringify({
    cmd: command,
    login: false,
    tty: false,
    yield_time_ms: SHELL_HELPER_YIELD_MS,
    max_output_tokens: 128,
  });
}

function safeProcessIdentity(raw: string): ShellProcessIdentity | null {
  if (parseExecBannerExitCode(raw) !== 0) return null;
  const match = execOutput(raw)
    .trim()
    .match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  const pid = Number.parseInt(match[1]!, 10);
  const processGroupId = Number.parseInt(match[2]!, 10);
  return Number.isSafeInteger(pid) &&
    Number.isSafeInteger(processGroupId) &&
    pid > 1 &&
    processGroupId > 1
    ? { pid, processGroupId }
    : null;
}

function identityGuardScript(
  state: ActiveShellSession,
  body: string,
  missingIdentityExitCode: number,
): string {
  const identity = state.identity;
  if (!identity || !state.token) return `exit ${missingIdentityExitCode}`;
  const token = singleQuote(state.token);
  return [
    `__opengeni_pid=${identity.pid}`,
    `__opengeni_pgid=${identity.processGroupId}`,
    `__opengeni_token=${token}`,
    '__opengeni_args="$(command ps -o args= -p "$__opengeni_pid" 2>/dev/null)"',
    'case "$__opengeni_args" in *"$__opengeni_token"*) ;; *) exit 0 ;; esac',
    '__opengeni_live_pgid="$(command ps -o pgid= -p "$__opengeni_pid" 2>/dev/null | command tr -d \'[:space:]\')"',
    '[ "$__opengeni_live_pgid" = "$__opengeni_pgid" ] || exit 0',
    body,
  ].join("\n");
}

function wrapComputer(computer: Computer, track: <T>(operation: () => Promise<T>) => Promise<T>) {
  const wrapped = Object.create(Object.getPrototypeOf(computer)) as Computer &
    Record<string, unknown>;
  Object.assign(wrapped, computer);
  for (const method of [
    "initRun",
    "screenshot",
    "click",
    "doubleClick",
    "scroll",
    "type",
    "wait",
    "move",
    "keypress",
    "drag",
  ] as const) {
    const original = (computer as unknown as Record<string, unknown>)[method];
    if (typeof original !== "function") continue;
    wrapped[method] = (...args: unknown[]) =>
      track(async () => await original.apply(computer, args)) as never;
  }
  return wrapped;
}

class TurnToolCancellationControllerImpl implements TurnToolCancellationController {
  private cancelled = false;
  private reason: unknown;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly shellSessions = new Map<number, ActiveShellSession>();
  private readonly remoteExecs = new Set<ActiveRemoteExec>();
  private rawExecInvoke: FunctionToolInvoke | null = null;
  private rawWriteInvoke: FunctionToolInvoke | null = null;
  private drainPromise: Promise<void> | null = null;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort = (): void => this.cancel(this.signal?.reason);

  constructor(signal?: AbortSignal) {
    this.signal = signal;
    if (signal?.aborted) {
      this.cancel(signal.reason);
    } else {
      signal?.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  cancel(reason?: unknown): void {
    if (!this.cancelled) {
      this.cancelled = true;
      this.reason = reason;
      this.signal?.removeEventListener("abort", this.onAbort);
    }
    void this.ensureDrain().catch(() => undefined);
  }

  async waitForQuiescence(): Promise<void> {
    this.cancel(this.reason);
    await this.ensureDrain();
  }

  runSandboxCommand(
    session: TurnSandboxCommandSession,
    args: TurnSandboxCommandArgs,
  ): Promise<unknown> {
    return this.track(async () => {
      if (!session.exec && !session.execCommand) {
        throw new Error("Sandbox session does not support command execution");
      }
      const lifecycleRunContext = {} as Parameters<FunctionToolInvoke>[0];

      const invokeExec: FunctionToolInvoke = async (_runContext, input) => {
        const parsed = parsedObject(input);
        if (!parsed || typeof parsed.cmd !== "string") {
          throw new Error("Sandbox lifecycle command input was invalid");
        }
        const commandArgs: TurnSandboxCommandArgs = {
          cmd: parsed.cmd,
          ...(typeof parsed.workdir === "string" ? { workdir: parsed.workdir } : {}),
          ...(typeof parsed.shell === "string" ? { shell: parsed.shell } : {}),
          ...(typeof parsed.login === "boolean" ? { login: parsed.login } : {}),
          ...(typeof parsed.tty === "boolean" ? { tty: parsed.tty } : {}),
          ...(typeof parsed.yield_time_ms === "number"
            ? { yieldTimeMs: parsed.yield_time_ms }
            : {}),
          ...(typeof parsed.max_output_tokens === "number"
            ? { maxOutputTokens: parsed.max_output_tokens }
            : {}),
          ...(typeof parsed.run_as === "string" ? { runAs: parsed.run_as } : {}),
        };
        // Provider PTY/session semantics live on execCommand (the same surface
        // used by the SDK shell tool). Some providers expose a lower-level exec
        // that waits for natural completion even when tty/yield are supplied;
        // choosing it here would put lifecycle setup back outside the <=2s
        // Steer/Pause boundary. Connected machines advertise no PTY and use the
        // structured exec path so their durable OpCancel correlation is retained.
        const result =
          session.supportsPty?.() !== false && session.execCommand
            ? await session.execCommand(commandArgs)
            : session.exec
              ? await session.exec(commandArgs)
              : await session.execCommand!(commandArgs);
        return nativeCommandBanner(result);
      };
      const invokeWrite: FunctionToolInvoke | null = session.writeStdin
        ? async (_runContext, input) => {
            const parsed = parsedObject(input);
            if (!parsed || typeof parsed.session_id !== "number") {
              throw new Error("Sandbox lifecycle stdin input was invalid");
            }
            return await session.writeStdin!({
              sessionId: parsed.session_id,
              ...(typeof parsed.chars === "string" ? { chars: parsed.chars } : {}),
              ...(typeof parsed.yield_time_ms === "number"
                ? { yieldTimeMs: parsed.yield_time_ms }
                : {}),
              ...(typeof parsed.max_output_tokens === "number"
                ? { maxOutputTokens: parsed.max_output_tokens }
                : {}),
            });
          }
        : null;
      const correlationId = `turn_lifecycle_${crypto.randomUUID()}`;
      const useRemoteOpCancellation =
        Boolean(session.cancelExecCommand) && session.supportsPty?.() === false;
      const remoteExec =
        session.cancelExecCommand && useRemoteOpCancellation
          ? this.registerRemoteExec(
              { cancelExecCommand: session.cancelExecCommand.bind(session) },
              `${sanitizeOpIdToken(correlationId)}:0`,
            )
          : null;
      const markerPath = shellMarkerPath(crypto.randomUUID());
      const commandInput = JSON.stringify({
        cmd: useRemoteOpCancellation ? args.cmd : cancellableShellCommand(args.cmd, markerPath),
        ...(args.workdir ? { workdir: args.workdir } : {}),
        ...(args.shell ? { shell: args.shell } : {}),
        ...(args.login !== undefined ? { login: args.login } : {}),
        ...(args.runAs ? { run_as: args.runAs } : {}),
        tty: useRemoteOpCancellation ? args.tty : true,
        yield_time_ms: useRemoteOpCancellation
          ? args.yieldTimeMs
          : cappedYield(args.yieldTimeMs, TURN_EXEC_YIELD_MS),
        ...(args.maxOutputTokens !== undefined ? { max_output_tokens: args.maxOutputTokens } : {}),
      });

      let initial: Awaited<ReturnType<FunctionToolInvoke>>;
      try {
        initial = await runWithToolCallCorrelation(
          correlationId,
          async () => await invokeExec(lifecycleRunContext, commandInput, undefined),
        );
      } finally {
        remoteExec?.settle();
      }
      if (typeof initial !== "string" || useRemoteOpCancellation) return initial;

      const sessionId = parseExecBannerSessionId(initial);
      if (sessionId === null) return initial;
      if (!invokeWrite) {
        throw new Error("Sandbox lifecycle command yielded without stdin support");
      }
      const token = markerPath.slice(markerPath.lastIndexOf("/") + 1);
      const state: ActiveShellSession = {
        sessionId,
        markerPath,
        token,
        runContext: lifecycleRunContext,
        execInvoke: invokeExec,
        writeInvoke: invokeWrite,
        identity: null,
        identityValidated: false,
        cancellation: null,
      };
      this.shellSessions.set(sessionId, state);
      const maxOutputTokens = args.maxOutputTokens ?? 20_000;
      const initialOutput = execOutput(initial);
      let output = initialOutput ? appendBoundedOutput("", initialOutput, maxOutputTokens) : "";
      while (true) {
        if (this.cancelled) throw cancellationError(this.reason);
        const next = await invokeWrite(
          lifecycleRunContext,
          JSON.stringify({
            session_id: sessionId,
            chars: "",
            yield_time_ms: TURN_WRITE_YIELD_MS,
            max_output_tokens: maxOutputTokens,
          }),
          undefined,
        );
        if (typeof next !== "string") {
          throw new Error("Sandbox lifecycle stdin returned an invalid result");
        }
        const nextOutput = execOutput(next);
        if (nextOutput) output = appendBoundedOutput(output, nextOutput, maxOutputTokens);
        const exitCode = parseExecBannerExitCode(next);
        if (exitCode !== null) {
          this.shellSessions.delete(sessionId);
          return completedCommandBanner(exitCode, output);
        }
        // A conforming provider blocks for the requested yield. This fallback
        // prevents a non-conforming implementation from turning a long setup
        // command into a hot control-plane polling loop.
        await delay(SHELL_POLL_MS);
      }
    });
  }

  wrapTools(tools: Tool<unknown>[], session?: CommandCancellationSession): Tool<unknown>[] {
    for (const tool of tools) {
      if (tool.type !== "function") continue;
      if (tool.name === "exec_command") this.rawExecInvoke = tool.invoke;
      if (tool.name === "write_stdin") this.rawWriteInvoke = tool.invoke;
    }

    return tools.map((tool) => {
      if (tool.type === "function") return this.wrapFunctionTool(tool, session);
      if (tool.type === "apply_patch") return this.wrapApplyPatchTool(tool);
      if (tool.type === "computer") return this.wrapComputerTool(tool);
      return tool;
    });
  }

  private wrapFunctionTool(
    tool: FunctionTool,
    cancellationSession?: CommandCancellationSession,
  ): FunctionTool {
    if (tool.name === "exec_command") {
      return {
        ...tool,
        invoke: (runContext, input, details) =>
          this.track(async () => {
            const parsed = parsedObject(input);
            if (!parsed || typeof parsed.cmd !== "string") {
              return await this.correlatedInvoke(tool.invoke, runContext, input, details);
            }
            const token = crypto.randomUUID();
            const markerPath = shellMarkerPath(token);
            const correlationId = details?.toolCall?.callId ?? `turn_exec_${token}`;
            const cancelExecCommand = cancellationSession?.cancelExecCommand;
            // Connected-machine exec is already a durable process-tree op and
            // may run on Windows/macOS/Linux. Its OpCancel needs no POSIX shell
            // wrapper and preserves the user's command byte-for-byte. PTY-backed
            // cloud/local sessions use the portable SDK session + POSIX marker.
            const useRemoteOpCancellation =
              Boolean(cancelExecCommand) && cancellationSession?.supportsPty?.() === false;
            const remoteExec =
              cancelExecCommand && useRemoteOpCancellation
                ? this.registerRemoteExec(
                    { cancelExecCommand: cancelExecCommand.bind(cancellationSession) },
                    `${sanitizeOpIdToken(correlationId)}:0`,
                  )
                : null;
            const cancellableInput = useRemoteOpCancellation
              ? input
              : JSON.stringify({
                  ...parsed,
                  cmd: cancellableShellCommand(parsed.cmd, markerPath),
                  // The SDK's only provider-neutral live-process interrupt is a PTY.
                  // The process marker provides TERM/KILL escalation when Ctrl-C is
                  // ignored; the short yield exposes the provider session promptly.
                  tty: true,
                  yield_time_ms: cappedYield(parsed.yield_time_ms, TURN_EXEC_YIELD_MS),
                });
            let output: Awaited<ReturnType<FunctionToolInvoke>>;
            try {
              output = await runWithToolCallCorrelation(
                correlationId,
                async () => await tool.invoke(runContext, cancellableInput, details),
              );
            } finally {
              remoteExec?.settle();
            }
            if (typeof output !== "string") return output;
            const sessionId = useRemoteOpCancellation ? null : parseExecBannerSessionId(output);
            if (sessionId !== null) {
              this.shellSessions.set(sessionId, {
                sessionId,
                markerPath,
                token,
                runContext,
                execInvoke: tool.invoke,
                writeInvoke: this.rawWriteInvoke,
                identity: null,
                identityValidated: false,
                cancellation: null,
              });
            }
            return output;
          }),
      };
    }

    if (tool.name === "write_stdin") {
      return {
        ...tool,
        invoke: (runContext, input, details) =>
          this.track(async () => {
            const parsed = parsedObject(input);
            const sessionId =
              parsed &&
              typeof parsed.session_id === "number" &&
              Number.isSafeInteger(parsed.session_id)
                ? parsed.session_id
                : null;
            const cappedInput = parsed
              ? JSON.stringify({
                  ...parsed,
                  yield_time_ms: cappedYield(parsed.yield_time_ms, TURN_WRITE_YIELD_MS),
                })
              : input;
            const output = await tool.invoke(runContext, cappedInput, details);
            if (sessionId !== null && typeof output === "string") {
              if (parseExecBannerSessionId(output) === sessionId) {
                if (!this.shellSessions.has(sessionId)) {
                  this.shellSessions.set(sessionId, {
                    sessionId,
                    markerPath: null,
                    token: null,
                    runContext,
                    execInvoke: this.rawExecInvoke ?? tool.invoke,
                    writeInvoke: tool.invoke,
                    identity: null,
                    identityValidated: false,
                    cancellation: null,
                  });
                }
              } else if (parseExecBannerExitCode(output) !== null) {
                this.shellSessions.delete(sessionId);
              }
            }
            return output;
          }),
      };
    }

    return {
      ...tool,
      invoke: (runContext, input, details) =>
        this.track(async () => await tool.invoke(runContext, input, details)),
    };
  }

  private wrapApplyPatchTool(tool: Extract<Tool<unknown>, { type: "apply_patch" }>) {
    const editor = tool.editor;
    const wrappedEditor: Editor = {
      createFile: (operation, context) =>
        this.track(async () => await editor.createFile(operation, context)),
      updateFile: (operation, context) =>
        this.track(async () => await editor.updateFile(operation, context)),
      deleteFile: (operation, context) =>
        this.track(async () => await editor.deleteFile(operation, context)),
    };
    return { ...tool, editor: wrappedEditor };
  }

  private wrapComputerTool(tool: Extract<Tool<unknown>, { type: "computer" }>) {
    const computer = tool.computer;
    if (typeof computer === "function") {
      return {
        ...tool,
        computer: async (...args: Parameters<typeof computer>) =>
          wrapComputer(await this.track(async () => await computer(...args)), (operation) =>
            this.track(operation),
          ),
      };
    }
    if ("create" in computer && typeof computer.create === "function") {
      return {
        ...tool,
        computer: {
          ...computer,
          create: async (...args: Parameters<typeof computer.create>) =>
            wrapComputer(
              await this.track(async () => await computer.create(...args)),
              (operation) => this.track(operation),
            ),
        },
      };
    }
    return {
      ...tool,
      computer: wrapComputer(computer as Computer, (operation) => this.track(operation)),
    };
  }

  private async correlatedInvoke(
    invoke: FunctionToolInvoke,
    runContext: Parameters<FunctionToolInvoke>[0],
    input: string,
    details: Parameters<FunctionToolInvoke>[2],
  ) {
    const callId = details?.toolCall?.callId;
    return callId
      ? await runWithToolCallCorrelation(
          callId,
          async () => await invoke(runContext, input, details),
        )
      : await invoke(runContext, input, details);
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.cancelled) return Promise.reject(cancellationError(this.reason));
    const promise = Promise.resolve().then(async () => {
      if (this.cancelled) throw cancellationError(this.reason);
      return await operation();
    });
    this.inFlight.add(promise);
    void promise
      .finally(() => {
        this.inFlight.delete(promise);
      })
      .catch(() => undefined);
    return promise;
  }

  private ensureDrain(): Promise<void> {
    this.drainPromise ??= this.drain();
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    while (true) {
      // Op-stream commands (connected/self-hosted machines) do not yield a PTY
      // session id. Issue their idempotent OpCancel first so the in-flight tool
      // promise can physically settle; cancellation-before-start is tombstoned
      // by the runner and therefore cannot race into a late process spawn.
      const remoteCancellations = [...this.remoteExecs].map(async (exec) => await exec.cancel());
      const inFlight = [...this.inFlight];
      if (inFlight.length > 0 || remoteCancellations.length > 0) {
        await Promise.allSettled([...inFlight, ...remoteCancellations]);
      }

      const sessions = [...this.shellSessions.values()];
      if (sessions.length > 0) {
        await Promise.all(sessions.map(async (session) => await this.cancelShellSession(session)));
      }

      if (this.inFlight.size === 0 && this.shellSessions.size === 0 && this.remoteExecs.size === 0)
        return;
    }
  }

  private registerRemoteExec(
    session: Required<Pick<CommandCancellationSession, "cancelExecCommand">>,
    opId: string,
  ): ActiveRemoteExec {
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let cancellation: Promise<void> | null = null;
    const entry: ActiveRemoteExec = {
      settled: false,
      settledPromise,
      settle: () => {
        if (entry.settled) return;
        entry.settled = true;
        resolveSettled();
        this.remoteExecs.delete(entry);
      },
      cancel: () => {
        cancellation ??= (async () => {
          while (!entry.settled) {
            const attempt = session.cancelExecCommand(opId).catch(() => false);
            // A routing/provider cancellation request can itself hang while the
            // ordinary PTY exec has already yielded. Do not let that advisory
            // route hold the authoritative local/session fence; its late result
            // is idempotent and already rejection-contained.
            await Promise.race([attempt, entry.settledPromise]);
            await Promise.race([entry.settledPromise, delay(SHELL_POLL_MS)]);
          }
        })();
        return cancellation;
      },
    };
    this.remoteExecs.add(entry);
    return entry;
  }

  private cancelShellSession(state: ActiveShellSession): Promise<void> {
    state.cancellation ??= this.cancelShellSessionOnce(state).finally(() => {
      state.cancellation = null;
    });
    return state.cancellation;
  }

  private async cancelShellSessionOnce(state: ActiveShellSession): Promise<void> {
    // A session inherited from an older/unwrapped invocation has no durable
    // process marker. Ctrl-C + provider completion is the only safe generic
    // authority available for that legacy shape.
    if (!state.markerPath) {
      while (true) {
        if (state.writeInvoke && (await this.rawWrite(state, "\u0003", SHELL_POLL_MS))) {
          this.shellSessions.delete(state.sessionId);
          return;
        }
        await delay(SHELL_POLL_MS);
      }
    }

    // Capture PID/PGID BEFORE Ctrl-C. A foreground child may ignore INT/TERM
    // while its supervising shell exits; provider-session completion alone is
    // therefore not proof that the whole process group stopped.
    while (!state.identity) {
      state.identity = await this.readIdentity(state);
      if (state.identity) break;
      if (state.writeInvoke) {
        const completed = await this.rawWrite(state, "", SHELL_POLL_MS);
        if (completed) {
          this.shellSessions.delete(state.sessionId);
          return;
        }
      }
      await delay(SHELL_POLL_MS);
    }

    if (!(await this.identityAlive(state))) {
      this.shellSessions.delete(state.sessionId);
      return;
    }

    if (state.writeInvoke) {
      await this.rawWrite(state, "\u0003", SHELL_POLL_MS);
      if (!(await this.identityAlive(state))) {
        this.shellSessions.delete(state.sessionId);
        return;
      }
    }

    await this.signalIdentity(state, "TERM");
    for (let attempt = 0; attempt < SHELL_GRACEFUL_POLLS; attempt++) {
      if (state.writeInvoke) await this.rawWrite(state, "", SHELL_POLL_MS);
      if (!(await this.identityAlive(state))) {
        this.shellSessions.delete(state.sessionId);
        return;
      }
    }

    await this.signalIdentity(state, "KILL");
    while (await this.identityAlive(state)) {
      if (state.writeInvoke) await this.rawWrite(state, "", SHELL_POLL_MS);
      // A transient helper failure must not turn the first KILL into a single
      // best-effort shot. Re-issue it until the process group is provably gone.
      await this.signalIdentity(state, "KILL");
      await delay(SHELL_POLL_MS);
    }
    this.shellSessions.delete(state.sessionId);
  }

  private async rawWrite(
    state: ActiveShellSession,
    chars: string,
    yieldTimeMs: number,
  ): Promise<boolean> {
    if (!state.writeInvoke) return false;
    try {
      const output = await state.writeInvoke(
        state.runContext,
        JSON.stringify({
          session_id: state.sessionId,
          chars,
          yield_time_ms: yieldTimeMs,
          max_output_tokens: 128,
        }),
        undefined,
      );
      if (typeof output !== "string") return false;
      if (parseExecBannerSessionId(output) === state.sessionId) return false;
      if (parseExecBannerExitCode(output) !== null) return true;
    } catch {
      // A transient provider/control-plane failure is not evidence that the
      // remote process stopped. The identity probe/escalation remains the
      // authority and retries until it can prove quiescence.
    }
    return false;
  }

  private async readIdentity(state: ActiveShellSession): Promise<ShellProcessIdentity | null> {
    if (!state.markerPath) return null;
    try {
      const output = await state.execInvoke(
        state.runContext,
        shellHelperInput(`command cat ${singleQuote(state.markerPath)} 2>/dev/null`),
        undefined,
      );
      return typeof output === "string" ? safeProcessIdentity(output) : null;
    } catch {
      return null;
    }
  }

  private async identityAlive(state: ActiveShellSession): Promise<boolean> {
    const script = state.identityValidated
      ? [
          `__opengeni_pgid=${state.identity?.processGroupId ?? 0}`,
          'command kill -0 -- "-$__opengeni_pgid" 2>/dev/null && exit 75',
          "exit 0",
        ].join("\n")
      : identityGuardScript(
          state,
          'command kill -0 -- "-$__opengeni_pgid" 2>/dev/null && exit 75\nexit 0',
          76,
        );
    try {
      const output = await state.execInvoke(state.runContext, shellHelperInput(script), undefined);
      if (typeof output !== "string") return true;
      const exitCode = parseExecBannerExitCode(output);
      if (exitCode === 75) {
        state.identityValidated = true;
        return true;
      }
      return exitCode !== 0;
    } catch {
      return true;
    }
  }

  private async signalIdentity(state: ActiveShellSession, signal: "TERM" | "KILL"): Promise<void> {
    const script = state.identityValidated
      ? `command kill -${signal} -- "-${state.identity?.processGroupId ?? 0}" 2>/dev/null || exit 76`
      : identityGuardScript(
          state,
          `command kill -${signal} -- "-$__opengeni_pgid" 2>/dev/null || exit 76\nexit 0`,
          76,
        );
    try {
      await state.execInvoke(state.runContext, shellHelperInput(script), undefined);
    } catch {
      // Confirmation is performed by identityAlive(). A failed signal helper
      // never opens the fence; it is retried/escalated until the process is gone.
    }
  }
}

export function createTurnToolCancellationController(
  signal?: AbortSignal,
): TurnToolCancellationController {
  return new TurnToolCancellationControllerImpl(signal);
}

/** Wrap a capability instance without depending on SDK-private subclasses. */
export function wrapCapabilityToolsForTurnCancellation(
  capability: { tools(): Tool<unknown>[]; _session?: CommandCancellationSession },
  controller: TurnToolCancellationController,
): void {
  const originalTools = capability.tools;
  capability.tools = function () {
    return controller.wrapTools(originalTools.call(this), this._session);
  };
}
