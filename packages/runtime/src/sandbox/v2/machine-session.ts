import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { formatExecResponse, truncateOutput } from "@openai/agents-core/sandbox/internal";
import {
  SANDBOX_V2_MAX_CAPTURE_RESPONSE_BYTES,
  SandboxJournalCursor,
  type SandboxMachineInstance,
} from "@opengeni/contracts";
import type { ChannelAExecArgs } from "../channel-a";
import { decodeCommandPage } from "../command-output";
import { markTypedExecHandleLoss } from "../exec-banner";
import {
  MachineJournalClient,
  JournalBindingError,
  JournalUnavailableError,
  validateJournalInputAction,
  type JournalAuthority,
  type MachineExecTransport,
} from "./journal-client";
import {
  JournalCommand,
  JournalReceipt,
  JournalObservation,
  JournalStartRequest,
  JOURNAL_INPUT_BYTES,
  type JournalInputAction,
} from "./journal-protocol";

export type MachineCommandCursor = { offset: number; remainder: string };
export type MachineExecResult = {
  output: string;
  wallTimeSeconds: number;
  stdout: string;
  stderr: string;
  sessionId?: number;
  exitCode?: number;
  originalTokenCount?: number;
  omittedOutputBytes?: number;
};
export type MachineSessionCommand = {
  handle: number;
  revision: number;
  command: JournalCommand;
  stdout: MachineCommandCursor;
  stderr: MachineCommandCursor;
};
/** Trusted control-plane composition. Every allocation is bound to one accepted
 * action; replay returns its original operation/input sequence. The capture CAS
 * commits raw bytes, decoded output, cursors and receipt in ONE transaction.
 * Every capture/proof rechecks exact attempt or adopted-command authority in
 * that same transaction; terminal evidence is immutable and monotonic. A failed
 * capture never acknowledges bytes or releases command demand. */
export interface MachineSessionPersistence extends JournalAuthority {
  /** Same causal/digest fence as allocation, with no new operation or demand.
   * Used by platform input preparation only; absence grants no dispatch. */
  findOperationId?(input: { requestDigest: string }): Promise<string | null>;
  /** Scoped to the accepted causal exec action. Bind its nonsecret request hash;
   * identical replay returns the original operation, conflicting replay fails. */
  allocateOperationId(input: { requestDigest: string }): Promise<string>;
  /** Retire only a never-bound allocation after local pre-dispatch failure.
   * A retained dispatch can never be abandoned, even if its RPC timed out. */
  abandonOperationId(operationId: string): Promise<boolean>;
  handleFor(command: JournalCommand): Promise<number>;
  load(handle: number): Promise<MachineSessionCommand | null>;
  loadOperation(operationId: string): Promise<MachineSessionCommand | null>;
  loadCapturedOutput(
    command: JournalCommand,
    options?: { maxStreamBytes: number },
  ): Promise<{
    stdout: string;
    stderr: string;
    observation: JournalObservation | null;
    omittedOutputBytes?: number;
  }>;
  /** Scoped to the accepted causal input action. Part identity is independent of
   * its bytes: two identical chunks still require different native sequences.
   * Bind the whole request and every part before returning its replay identity. */
  reserveInput(
    command: JournalCommand,
    input: {
      requestDigest: string;
      partIndex: number;
      partCount: number;
      action: JournalInputAction;
    },
  ): Promise<number>;
  capture(input: {
    expected: MachineSessionCommand;
    next: MachineSessionCommand;
    observation: JournalObservation;
    stdout: string;
    stderr: string;
  }): Promise<boolean>;
  recordControlProof(command: JournalCommand, observation: JournalObservation): Promise<void>;
}
export class MachineCommandOutcomeError extends Error {
  readonly code = "SANDBOX_V2_COMMAND_OUTCOME";
  constructor(
    readonly command: JournalCommand,
    readonly outcome: string,
  ) {
    super(`Exact sandbox command outcome is ${outcome}; retain its operation identity`);
  }
}
export class MachineCommandHandleUnavailableError extends Error {
  readonly code = "SANDBOX_V2_HANDLE_UNAVAILABLE";
  constructor() {
    super("No authorized journal operation for this command handle");
  }
}

type MachineSandboxSessionOptions = {
  provider: string;
  machineId: string;
  instance: SandboxMachineInstance;
  transport: MachineExecTransport;
  persistence: MachineSessionPersistence;
  environment: () => Promise<Record<string, string>>;
  /** Platform-only preparation before a fresh command allocation, requiring
   * protected causal lookup. Existing command replay never refreshes inputs. */
  prepareEnvironmentBeforeAllocation?: boolean;
  capabilities: { stdin: boolean; pty: boolean };
  workspaceRoot?: string;
  /** Trusted host data window, never supplied by a model command. */
  outputWindowBytes?: number;
  journal?: ConstructorParameters<typeof MachineJournalClient>[3];
};

/** One SDK/Channel-A command implementation for all machine providers. This
 * handle owns no machine lifecycle. A replacement session loads the original
 * numeric alias and byte cursors from protected persistence. */
export class MachineSandboxSession {
  readonly backendId: string;
  readonly state: { kind: "machine-v2"; machineId: string; instance: SandboxMachineInstance };
  private readonly journal: MachineJournalClient;
  private readonly root: string;
  private readonly options: MachineSandboxSessionOptions;
  constructor(options: MachineSandboxSessionOptions) {
    options = {
      ...options,
      instance: structuredClone(options.instance),
      capabilities: { ...options.capabilities },
      ...(options.journal ? { journal: { ...options.journal } } : {}),
    };
    this.options = options;
    if (
      options.outputWindowBytes !== undefined &&
      (!Number.isSafeInteger(options.outputWindowBytes) ||
        options.outputWindowBytes < 1 ||
        options.outputWindowBytes > SANDBOX_V2_MAX_CAPTURE_RESPONSE_BYTES)
    )
      throw new JournalBindingError("Invalid bounded command response window");
    this.backendId = options.provider;
    this.state = structuredClone({
      kind: "machine-v2",
      machineId: options.machineId,
      instance: options.instance,
    });
    Object.freeze(this.state.instance);
    Object.freeze(this.state);
    this.root = posix.resolve(options.workspaceRoot ?? "/workspace");
    if (this.root === "/") throw new JournalBindingError("A workspace root is required");
    this.journal = new MachineJournalClient(
      this.state,
      options.transport,
      {
        reserve: async (command) => {
          const saved = await options.persistence.reserve(command);
          // Ensure its durable numeric alias exists BEFORE crossing Start.
          this.checkHandle(await options.persistence.handleFor(saved));
          return saved;
        },
        assert: (command, action) => options.persistence.assert(command, action),
      },
      options.journal,
    );
    markTypedExecHandleLoss(this);
  }
  supportsPty(): boolean {
    return this.options.capabilities.pty;
  }
  serialize() {
    return structuredClone(this.state);
  }
  private checkHandle(handle: number): void {
    if (!Number.isSafeInteger(handle) || handle < 1 || handle > 2147483647)
      throw new MachineCommandHandleUnavailableError();
  }
  private async record(handle: number): Promise<MachineSessionCommand> {
    this.checkHandle(handle);
    const saved = await this.options.persistence.load(handle);
    if (
      !saved ||
      saved.handle !== handle ||
      JournalCommand.parse(saved.command).machineId !== this.state.machineId
    )
      throw new MachineCommandHandleUnavailableError();
    if (
      !Number.isSafeInteger(saved.revision) ||
      saved.revision < 0 ||
      saved.revision >= Number.MAX_SAFE_INTEGER
    )
      throw new JournalBindingError("Invalid retained command revision");
    for (const cursor of [saved.stdout, saved.stderr]) {
      if (!SandboxJournalCursor.safeParse(cursor).success)
        throw new JournalBindingError("Invalid retained output cursor");
    }
    return structuredClone(saved);
  }
  private budget(value: number | undefined): number {
    const milliseconds = value ?? 1000;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 30_000)
      throw new JournalBindingError("Invalid command observation budget");
    return milliseconds;
  }
  private async observe(
    handle: number,
    args: {
      yieldTimeMs?: number | undefined;
      maxOutputTokens?: number | undefined;
      signal?: AbortSignal;
    } = {},
    initial?: JournalObservation,
  ): Promise<MachineExecResult> {
    const started = Date.now();
    const budget = this.budget(args.yieldTimeMs);
    const saved = await this.record(handle);
    const outputWindow = { maxStreamBytes: this.options.outputWindowBytes ?? 256 * 1024 };
    const retained = await this.options.persistence.loadCapturedOutput(saved.command, outputWindow);
    let stdout = retained.stdout;
    let stderr = retained.stderr;
    let omittedOutputBytes = retained.omittedOutputBytes ?? 0;
    let sampled = initial;
    let conflicts = 0;
    const previousPage = retained.observation
      ? JournalObservation.parse(retained.observation)
      : null;
    if (
      previousPage &&
      (previousPage.operationId !== saved.command.operationId ||
        (previousPage.specificationDigest !== null &&
          previousPage.specificationDigest !== saved.command.specificationDigest))
    )
      throw new JournalBindingError("Retained output belongs to another operation");
    if (previousPage?.state === "cancelled")
      throw new MachineCommandOutcomeError(saved.command, previousPage.state);
    if (
      previousPage &&
      previousPage.state === "exited" &&
      previousPage.stdout.eof &&
      previousPage.stderr.eof
    ) {
      const output = truncateOutput(
        [omittedOutputBytes ? "[Earlier output omitted]" : "", stdout, stderr]
          .filter(Boolean)
          .join("\n"),
        args.maxOutputTokens,
      );
      return {
        stdout,
        stderr,
        output: output.text,
        wallTimeSeconds: (Date.now() - started) / 1000,
        ...(output.originalTokenCount !== undefined && omittedOutputBytes === 0
          ? { originalTokenCount: output.originalTokenCount }
          : {}),
        ...(omittedOutputBytes ? { omittedOutputBytes } : {}),
        ...(previousPage.state === "exited" && previousPage.stdout.eof && previousPage.stderr.eof
          ? { exitCode: JournalReceipt.parse(previousPage.receipt).leaderExitCode }
          : { sessionId: handle }),
      };
    }
    for (;;) {
      args.signal?.throwIfAborted();
      const previous = await this.record(handle);
      // Start observes byte zero. A causal replay may already have captured it.
      let page =
        sampled && previous.stdout.offset === 0 && previous.stderr.offset === 0
          ? sampled
          : await this.journal.read(
              previous.command,
              {
                stdout: previous.stdout.offset,
                stderr: previous.stderr.offset,
                bytes: 64 * 1024,
              },
              args.signal,
            );
      sampled = undefined;
      const out = decodeCommandPage(
        previous.stdout.remainder,
        [Buffer.from(page.stdout.data, "base64")],
        page.stdout.eof,
      );
      const err = decodeCommandPage(
        previous.stderr.remainder,
        [Buffer.from(page.stderr.data, "base64")],
        page.stderr.eof,
      );
      const next = {
        ...previous,
        revision: previous.revision + 1,
        stdout: { offset: page.stdout.nextOffset, remainder: out.remainder },
        stderr: { offset: page.stderr.nextOffset, remainder: err.remainder },
      };
      const accepted = await this.options.persistence.capture({
        expected: previous,
        next,
        observation: page,
        stdout: out.text,
        stderr: err.text,
      });
      if (!accepted) {
        if (++conflicts > 16) throw new JournalUnavailableError(previous.command);
        const captured = await this.options.persistence.loadCapturedOutput(
          previous.command,
          outputWindow,
        );
        stdout = captured.stdout;
        stderr = captured.stderr;
        omittedOutputBytes = captured.omittedOutputBytes ?? 0;
        continue;
      }
      conflicts = 0;
      // Another observer of this SAME accepted action may have captured bytes
      // before our cursor read or between iterations. A successful cursor CAS
      // alone does not tell us its prefix; assemble from committed captures.
      const captured = await this.options.persistence.loadCapturedOutput(
        previous.command,
        outputWindow,
      );
      stdout = captured.stdout;
      stderr = captured.stderr;
      omittedOutputBytes = captured.omittedOutputBytes ?? 0;
      if (captured.observation) page = JournalObservation.parse(captured.observation);
      const output = truncateOutput(
        [omittedOutputBytes ? "[Earlier output omitted]" : "", stdout, stderr]
          .filter(Boolean)
          .join("\n"),
        args.maxOutputTokens,
      );
      const base = {
        stdout,
        stderr,
        output: output.text,
        wallTimeSeconds: (Date.now() - started) / 1000,
        ...(output.originalTokenCount !== undefined && omittedOutputBytes === 0
          ? { originalTokenCount: output.originalTokenCount }
          : {}),
        ...(omittedOutputBytes ? { omittedOutputBytes } : {}),
      };
      if (["lost", "unknown", "not_found", "cancelled"].includes(page.state))
        throw new MachineCommandOutcomeError(previous.command, page.state);
      if (accepted && page.state === "exited" && page.stdout.eof && page.stderr.eof) {
        const receipt = JournalReceipt.parse(page.receipt);
        if (receipt.invocationId !== previous.command.operationId)
          throw new JournalBindingError("Terminal receipt belongs to another command");
        return { ...base, exitCode: receipt.leaderExitCode };
      }
      if (
        Date.now() - started >= budget ||
        next.stdout.offset - saved.stdout.offset + next.stderr.offset - saved.stderr.offset >=
          256 * 1024
      )
        return { ...base, sessionId: handle };
      await delay(20, undefined, args.signal ? { signal: args.signal } : undefined);
    }
  }
  async exec(input: ChannelAExecArgs): Promise<MachineExecResult> {
    const args = structuredClone(input);
    this.budget(args.yieldTimeMs);
    if (args.tty && !this.options.capabilities.pty)
      throw new JournalBindingError("The qualified machine has no PTY support");
    const cwd = posix.resolve(this.root, args.workdir ?? this.root);
    if (cwd !== this.root && !cwd.startsWith(`${this.root}/`))
      throw new JournalBindingError("Command directory is outside the workspace");
    const shell = args.shell ?? "/bin/sh";
    let program = shell;
    let argv = [args.shell && (args.login ?? true) ? "-lc" : "-c", args.cmd];
    if (args.runAs) {
      program = "/usr/bin/sudo";
      argv = ["-n", "-u", args.runAs, "--", shell, ...argv];
    }
    const execution = {
      program,
      args: argv,
      cwd,
      stdin: this.options.capabilities.stdin,
      pty: args.tty ? { columns: 80, rows: 24 } : null,
    };
    JournalStartRequest.parse({
      operationId: "00000000-0000-0000-0000-000000000000",
      bootId: this.state.instance.bootId,
      diskLineage: this.state.instance.diskLineage,
      ...execution,
      environment: {},
    });
    const allocation = {
      requestDigest: createHash("sha256").update(JSON.stringify(execution)).digest("hex"),
    };
    let preparedEnvironment: Record<string, string> | undefined;
    if (this.options.prepareEnvironmentBeforeAllocation) {
      const find = this.options.persistence.findOperationId;
      if (typeof find !== "function")
        throw new JournalBindingError("Platform input preparation requires original causal lookup");
      if ((await find(allocation)) === null) {
        preparedEnvironment = structuredClone(await this.options.environment());
        JournalStartRequest.parse({
          operationId: "00000000-0000-0000-0000-000000000000",
          bootId: this.state.instance.bootId,
          diskLineage: this.state.instance.diskLineage,
          ...execution,
          environment: preparedEnvironment,
        });
      }
    }
    const operationId = await this.options.persistence.allocateOperationId(allocation);
    // A replacement observer must not construct a new Start using refreshed
    // credentials. Retained dispatch authority permits only read/cancel recovery.
    const retained = await this.options.persistence.loadOperation(operationId);
    if (retained) {
      const record = await this.record(retained.handle);
      if (
        record.command.operationId !== operationId ||
        !isDeepStrictEqual(record.command, retained.command)
      )
        throw new JournalBindingError("Retained operation binding changed");
      return this.observe(record.handle, args);
    }
    let result: Awaited<ReturnType<MachineJournalClient["start"]>>;
    try {
      result = await this.journal.start({
        operationId,
        bootId: this.state.instance.bootId,
        diskLineage: this.state.instance.diskLineage,
        ...execution,
        environment: preparedEnvironment ?? structuredClone(await this.options.environment()),
      });
    } catch (error) {
      // If binding admission happened, this returns false and retains physical
      // demand. If authority was revoked, its control worker cleans up the
      // still-unbound allocation later; preserve the original failure here.
      try {
        await this.options.persistence.abandonOperationId(operationId);
      } catch {}
      throw error;
    }
    const handle = await this.options.persistence.handleFor(result.command);
    return this.observe(
      handle,
      {
        ...(args.yieldTimeMs !== undefined ? { yieldTimeMs: args.yieldTimeMs } : {}),
        ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
      },
      result.observation,
    );
  }
  async execCommand(args: ChannelAExecArgs): Promise<string> {
    return formatExecResponse(await this.exec(args));
  }
  /** Read-only raw polling for platform setup. It allocates no new command or
   * stdin action and preserves the existing command's exact authority/cursors. */
  async pollCommand(args: {
    sessionId: number;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<MachineExecResult> {
    return this.observe(args.sessionId, { ...args });
  }
  async writeStdin(args: {
    sessionId: number;
    chars?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    args = { ...args };
    this.budget(args.yieldTimeMs);
    await this.writeCommandInput({ ...args, chars: args.chars ?? "" });
    return formatExecResponse(await this.observe(args.sessionId, args));
  }
  /** Trusted platform input delivery without consuming the command's output
   * window. Each caller still needs a distinct retained causal input identity. */
  async writeCommandInput(args: {
    sessionId: number;
    chars: string;
    signal?: AbortSignal;
  }): Promise<void> {
    args = { ...args };
    const record = await this.record(args.sessionId);
    const bytes = Buffer.from(args.chars);
    const requestDigest = createHash("sha256")
      .update("journal-input-data-v1\0")
      .update(bytes)
      .digest("hex");
    const partCount = Math.ceil(bytes.length / JOURNAL_INPUT_BYTES);
    if (partCount > 0)
      validateJournalInputAction(record.command, {
        kind: "data",
        base64: bytes.subarray(0, JOURNAL_INPUT_BYTES).toString("base64"),
      });
    for (let offset = 0; offset < bytes.length; offset += JOURNAL_INPUT_BYTES) {
      await this.sendInput(
        record.command,
        {
          kind: "data",
          base64: bytes.subarray(offset, offset + JOURNAL_INPUT_BYTES).toString("base64"),
        },
        { requestDigest, partIndex: offset / JOURNAL_INPUT_BYTES, partCount },
        args.signal,
      );
    }
  }
  private async sendInput(
    command: JournalCommand,
    action: JournalInputAction,
    identity?: { requestDigest: string; partIndex: number; partCount: number },
    signal?: AbortSignal,
  ) {
    // The control plane binds each sequence to the accepted causal input action,
    // storing its digest rather than any input bytes.
    const payload = validateJournalInputAction(command, action);
    const sequence = await this.options.persistence.reserveInput(command, {
      action: payload,
      ...(identity ?? {
        requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        partIndex: 0,
        partCount: 1,
      }),
    });
    const deadline = Date.now() + 5000;
    for (;;) {
      const result = await this.journal.input(command, sequence, payload, signal);
      if (result.status === "accepted") return;
      // Another accepted action owns a preceding contiguous sequence range.
      // Only this exact gap refusal may wait; never skip or renumber its bytes.
      const waitingForEarlierInput =
        result.status === "rejected" &&
        result.reason === "sequence" &&
        result.acceptedThrough !== null &&
        result.acceptedThrough < sequence - 1;
      if (result.status !== "pending" && !waitingForEarlierInput)
        throw new MachineCommandOutcomeError(command, `input_${result.status}`);
      if (Date.now() >= deadline) break;
      await delay(20, undefined, signal ? { signal } : undefined);
    }
    throw new JournalUnavailableError(command);
  }
  async closeStdin(handle: number, signal?: AbortSignal) {
    const record = await this.record(handle);
    await this.sendInput(record.command, { kind: "close" }, undefined, signal);
  }
  async resizePty(handle: number, columns: number, rows: number, signal?: AbortSignal) {
    const record = await this.record(handle);
    await this.sendInput(record.command, { kind: "resize", columns, rows }, undefined, signal);
  }
  async cancelExecCommand(operationId: string): Promise<boolean> {
    const saved = await this.options.persistence.loadOperation(operationId);
    if (!saved || saved.command.operationId !== operationId)
      throw new MachineCommandHandleUnavailableError();
    const record = await this.record(saved.handle);
    if (!isDeepStrictEqual(record.command, saved.command))
      throw new JournalBindingError("Command binding changed");
    const page = await this.journal.cancel(record.command);
    // Cancel ACK alone supplies no physical quiescence. This exact receipt or
    // same-incarnation never-started tombstone is the only positive result.
    if (page.state !== "exited" && page.state !== "cancelled") return false;
    await this.options.persistence.recordControlProof(record.command, page);
    return true;
  }
}
