import { randomUUID, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { shellQuote } from "@openai/agents-core/sandbox/internal";
import {
  SandboxProviderCommand,
  CommandSupervisionReceipt,
  type ModalRouterProviderCommand,
} from "@opengeni/contracts";
import type { ChannelAExecArgs } from "../channel-a";
import type { ProviderCommandOutput } from "../provider-command-session";
import {
  admittedCommandSupervisionReady,
  markPendingCommandSupervised,
  reserveSupervisedLaunch,
} from "../provider-command-session";
import {
  ModalCommandControl as LegacyControl,
  commandControlPlane,
  decodePage,
} from "./modal-legacy-command-control";
import {
  ModalCommandRouterWire,
  ModalCommandStartPreDispatchUnavailableError,
  ModalCommandStartRejectedError,
} from "./modal-command-router-wire";

export { modalCommandAbortMiddleware } from "./modal-legacy-command-control";
export type ModalProviderCommand = SandboxProviderCommand;
export type ModalProviderOutputPage = ProviderCommandOutput;

type Client = Parameters<typeof commandControlPlane>[0];
type RouterEntry = {
  router: ModalCommandRouterWire;
  users: number;
  refreshAt: number;
  idle?: ReturnType<typeof setTimeout>;
};

/** New commands use replayable task-router byte offsets. Legacy identifiers
 * never cross that protocol boundary and are never used for new starts. */
export class ModalCommandControl {
  private readonly routers = new Map<string, Promise<RouterEntry>>();
  private readonly client: ReturnType<typeof commandControlPlane>;
  private readonly legacy: LegacyControl;
  private closed = false;

  private constructor(
    client: Client,
    private readonly sandboxIdentity: string | (() => string),
    private readonly root: string,
    private readonly environment: Record<string, string> | (() => Record<string, string>),
  ) {
    this.client = commandControlPlane(client);
    this.legacy = LegacyControl.forSandbox(client, sandboxIdentity, root, environment);
  }

  static forSandbox(
    client: Client,
    sandboxId: string | (() => string),
    root: string,
    environment: Record<string, string> | (() => Record<string, string>) = {},
  ): ModalCommandControl {
    if (client.version() !== "0.9.0")
      throw new Error("Modal command control requires the verified 0.9.0 SDK contract");
    return new ModalCommandControl(client, sandboxId, root, environment);
  }

  private get sandboxId(): string {
    return typeof this.sandboxIdentity === "function"
      ? this.sandboxIdentity()
      : this.sandboxIdentity;
  }

  private async withRouter<T>(
    taskId: string,
    signal: AbortSignal | undefined,
    run: (router: ModalCommandRouterWire) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Modal command control is closed");
    let pending = this.routers.get(taskId);
    const reused = Boolean(pending);
    if (!pending) {
      pending = (async () => {
        const access = await this.client.taskGetCommandRouterAccess(
          { taskId },
          signal ? { signal } : undefined,
        );
        let refreshAt = Date.now() + 60_000;
        try {
          // Expiry only shortens cache lifetime; it never authenticates access.
          const payload = JSON.parse(
            Buffer.from(access.jwt.split(".")[1] ?? "", "base64url").toString(),
          );
          if (typeof payload.exp === "number" && Number.isFinite(payload.exp))
            refreshAt = Math.min(refreshAt, payload.exp * 1000 - 15_000);
        } catch {
          /* Authentication remains the provider's responsibility. */
        }
        return { router: new ModalCommandRouterWire(access), users: 0, refreshAt };
      })();
      this.routers.set(taskId, pending);
      void pending.catch(() => {
        if (this.routers.get(taskId) === pending) this.routers.delete(taskId);
      });
    }
    const entry = await pending;
    // Refresh credentials between operations, never close another active read.
    if (reused && !entry.users && Date.now() > entry.refreshAt) {
      clearTimeout(entry.idle);
      entry.router.close();
      this.routers.delete(taskId);
      return await this.withRouter(taskId, signal, run);
    }
    clearTimeout(entry.idle);
    entry.users++;
    try {
      signal?.throwIfAborted();
      return await run(entry.router);
    } finally {
      entry.users--;
      if (!entry.users) {
        entry.idle = setTimeout(() => {
          if (this.routers.get(taskId) === pending && !entry.users) {
            this.routers.delete(taskId);
            entry.router.close();
          }
        }, 30_000);
        entry.idle.unref?.();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = await Promise.allSettled(this.routers.values());
    this.routers.clear();
    for (const entry of entries)
      if (entry.status === "fulfilled") {
        clearTimeout(entry.value.idle);
        entry.value.router.close();
      }
  }

  async start(args: ChannelAExecArgs, signal?: AbortSignal): Promise<ModalRouterProviderCommand> {
    signal?.throwIfAborted();
    const supervised = admittedCommandSupervisionReady() && !args.tty && !args.runAs;
    if (supervised) markPendingCommandSupervised();
    const sandboxId = this.sandboxId;
    const workdir = posix.resolve(this.root, args.workdir ?? this.root);
    if (workdir !== this.root && !workdir.startsWith(`${this.root.replace(/\/$/u, "")}/`))
      throw new Error("Command workdir is outside the sandbox workspace");
    const task = await this.client.sandboxGetTaskId({ sandboxId }, signal ? { signal } : undefined);
    if (!task.taskId || task.taskResult) throw new Error("Modal command task is unavailable");
    const taskId = task.taskId;
    if (this.sandboxId !== sandboxId)
      throw new Error("Modal sandbox changed during command preparation");
    const execId = randomUUID();
    // PTY and runAs retain their existing explicit unsupported supervision
    // semantics. Never attach a fabricated descriptor to either path.
    const invocationId = randomUUID();
    const supervision = supervised
      ? {
          protocol: "native-subreaper-v1" as const,
          invocationId,
          nonce: randomBytes(32).toString("hex"),
          controlPath: `/tmp/opengeni-supervision/${invocationId}.sock`,
        }
      : undefined;
    let commandArgs = [
      args.shell ?? "/bin/sh",
      args.shell && (args.login ?? true) ? "-lc" : "-c",
      args.cmd,
    ];
    if (args.runAs) {
      const user = shellQuote(args.runAs),
        invocation = commandArgs.map(shellQuote).join(" ");
      commandArgs = [
        "/bin/sh",
        "-c",
        `if [ "$(id -u)" = ${user} ] || [ "$(id -un 2>/dev/null)" = ${user} ]; then exec ${invocation}; elif [ "$(id -u)" = 0 ]; then exec su -s /bin/sh ${user} -c ${shellQuote(`exec ${invocation}`)}; else exec sudo -n -u ${user} -- ${invocation}; fi`,
      ];
    }
    const env = typeof this.environment === "function" ? this.environment() : this.environment;
    if (supervision)
      commandArgs = [
        "/usr/local/bin/opengeni-command-supervisor",
        "launch",
        "--invocation",
        supervision.invocationId,
        "--nonce",
        supervision.nonce,
        "--socket",
        supervision.controlPath,
        "--",
        ...commandArgs,
      ];
    const command: ModalRouterProviderCommand = {
      kind: "modal-router-v1",
      sandboxId,
      taskId,
      execId,
      ...(args.tty ? { pty: true } : {}),
      ...(supervision ? { supervision } : {}),
      streams: {
        stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      },
    };
    if (supervision) await reserveSupervisedLaunch(command);
    try {
      await this.withRouter(taskId, signal, (router) =>
        router.start(
          {
            taskId,
            execId,
            commandArgs,
            workdir,
            env,
            ...(args.tty
              ? {
                  ptyInfo: {
                    enabled: true,
                    winszRows: 24,
                    winszCols: 80,
                    envTerm: "xterm",
                    ptyType: 1,
                    noTerminateOnIdleStdin: true,
                  },
                }
              : {}),
          },
          signal,
        ),
      );
    } catch (error) {
      // A client-chosen router id remains the only possible invocation. The
      // supervisor is idle, so an ambiguous launch never ran user code. Retain
      // the descriptor and reconcile that id; do not replay the start.
      if (
        !supervision ||
        error instanceof ModalCommandStartRejectedError ||
        error instanceof ModalCommandStartPreDispatchUnavailableError
      )
        throw error;
    }
    return command;
  }

  /** Read-only, authenticated control execution on this exact instance. Never
   * inferred from a fleet image selector or user command stdout. No cache: warm
   * instances and route/task replacement must each pass before admission. */
  async verifySupervisionCapability(): Promise<{ sandboxId: string; taskId: string }> {
    const sandboxId = this.sandboxId;
    const signal = AbortSignal.timeout(5_000);
    const task = await this.client.sandboxGetTaskId({ sandboxId }, { signal });
    if (!task.taskId || task.taskResult) throw new Error("Modal command task is unavailable");
    await this.withRouter(task.taskId, signal, async (router) => {
      const identity = { taskId: task.taskId!, execId: randomUUID() };
      await router.start(
        {
          ...identity,
          commandArgs: ["/usr/local/bin/opengeni-command-supervisor", "capabilities"],
          workdir: "/tmp",
          env: {},
        },
        signal,
      );
      let offset = 0;
      let output = "";
      let eof = false;
      let exit: number | null = null;
      while (!eof || exit === null) {
        signal.throwIfAborted();
        const page = await router.read(identity, "stdout", offset, 250, signal);
        offset += page.bytes.length;
        if (offset > 128) throw new Error("Modal supervision capability response exceeds bound");
        output += page.bytes.toString("utf8");
        eof = page.eof;
        exit = await router.poll(identity, signal);
      }
      if (exit !== 0 || output !== "native-subreaper-v1")
        throw new Error(
          "Exact Modal instance lacks compatible native supervision; command not admitted",
        );
    });
    if (sandboxId !== this.sandboxId)
      throw new Error("Modal instance changed during supervision capability verification");
    return { sandboxId, taskId: task.taskId };
  }

  /** Separate authenticated provider execution of the installed control helper.
   * User command streams are never inspected for control evidence. */
  async supervisionControl(
    command: ModalRouterProviderCommand,
    action: "release" | "cancel" | "status" | "ack",
    receiptId?: string,
  ): Promise<{ state: "idle" | "running" | "quiescent"; receipt?: CommandSupervisionReceipt }> {
    SandboxProviderCommand.parse(command);
    const descriptor = command.supervision;
    if (!descriptor || command.sandboxId !== this.sandboxId)
      throw new Error("Supervised command identity is unavailable");
    const identity = { taskId: command.taskId, execId: randomUUID() };
    const signal = AbortSignal.timeout(5_000);
    return await this.withRouter(command.taskId, signal, async (router) => {
      await router.start(
        {
          ...identity,
          commandArgs: [
            "/usr/local/bin/opengeni-command-supervisor",
            "control",
            "--invocation",
            descriptor.invocationId,
            "--nonce",
            descriptor.nonce,
            "--socket",
            descriptor.controlPath,
            "--action",
            action,
            ...(receiptId ? ["--receipt", receiptId] : []),
          ],
          workdir: "/tmp",
          env: {},
        },
        signal,
      );
      const buffers: Buffer[] = [];
      let offset = 0;
      let eof = false;
      let exit: number | null = null;
      while (!eof || exit === null) {
        signal.throwIfAborted();
        const page = await router.read(identity, "stdout", offset, 250, signal);
        offset += page.bytes.length;
        if (offset > 4096) throw new Error("Supervisor control response exceeds its bound");
        buffers.push(page.bytes);
        eof = page.eof;
        exit = await router.poll(identity, signal);
      }
      if (exit !== 0) throw new Error("Supervisor control is unavailable");
      const result = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      if (!result || !["idle", "running", "quiescent"].includes(result.state))
        throw new Error("Invalid supervisor control response");
      if (result.receipt !== undefined) {
        result.receipt = CommandSupervisionReceipt.parse(result.receipt);
        if (result.receipt.invocationId !== descriptor.invocationId)
          throw new Error("Supervisor receipt invocation mismatch");
      }
      if ((result.state === "quiescent") !== Boolean(result.receipt))
        throw new Error("Supervisor quiescence response lacks its receipt");
      return result;
    });
  }

  async read(
    command: ModalProviderCommand,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<ModalProviderOutputPage> {
    SandboxProviderCommand.parse(command);
    if (command.sandboxId !== this.sandboxId)
      throw new Error("Modal command does not belong to this sandbox");
    if (command.kind === "modal-control-v1") return await this.legacy.read(command, waitMs, signal);
    const next = structuredClone(command);
    const cancellation = new AbortController();
    const abort = () => cancellation.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await this.withRouter(command.taskId, cancellation.signal, async (router) => {
        const operations = [
          ...(["stdout", "stderr"] as const).map(async (stream) =>
            command.streams[stream].eof
              ? { bytes: Buffer.alloc(0), eof: true }
              : await router.read(
                  command,
                  stream,
                  command.streams[stream].byteOffset,
                  waitMs,
                  cancellation.signal,
                ),
          ),
          router.poll(command, cancellation.signal),
        ] as const;
        const results = await Promise.allSettled(
          operations.map((operation) =>
            operation.catch((error) => {
              cancellation.abort(error);
              throw error;
            }),
          ),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        const stdout = (results[0] as PromiseFulfilledResult<{ bytes: Buffer; eof: boolean }>)
          .value;
        const stderr = (results[1] as PromiseFulfilledResult<{ bytes: Buffer; eof: boolean }>)
          .value;
        const exit = (results[2] as PromiseFulfilledResult<number | null>).value;
        const chunks: ModalProviderOutputPage["chunks"] = [];
        for (const [stream, page] of [
          ["stdout", stdout],
          ["stderr", stderr],
        ] as const) {
          const old = command.streams[stream];
          const decoded = decodePage(old.utf8Remainder, [page.bytes], page.eof);
          const byteOffset = old.byteOffset + page.bytes.length;
          if (!Number.isSafeInteger(byteOffset)) throw new Error("Modal output offset exhausted");
          next.streams[stream] = {
            byteOffset,
            utf8Remainder: decoded.remainder,
            eof: page.eof,
            exitCode: page.eof ? exit : null,
          };
          if (decoded.text)
            chunks.push({
              stream,
              chunkId: `modal-router:${command.execId}:${stream}:${old.byteOffset}:${byteOffset}:${page.eof ? 1 : 0}`,
              text: decoded.text,
            });
        }
        return {
          command: next,
          expected: structuredClone(command),
          chunks,
          exitCode: next.streams.stdout.eof && next.streams.stderr.eof ? exit : null,
          streamFidelity: command.pty ? "merged" : "separate",
        };
      });
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async readProbe(
    command: ModalProviderCommand,
    waitMs: number,
    cancellation: AbortController,
  ): Promise<ModalProviderOutputPage> {
    return await this.read(command, waitMs, cancellation.signal);
  }

  async write(command: ModalProviderCommand, chars: string, index: number): Promise<void> {
    SandboxProviderCommand.parse(command);
    if (command.sandboxId !== this.sandboxId)
      throw new Error("Modal command does not belong to this sandbox");
    if (command.kind === "modal-control-v1") return await this.legacy.write(command, chars, index);
    await this.withRouter(command.taskId, undefined, (router) =>
      router.write(command, index, Buffer.from(chars)),
    );
  }
}
