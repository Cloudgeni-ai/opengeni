import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { shellQuote } from "@openai/agents-core/sandbox/internal";
import { SandboxProviderCommand, type ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ChannelAExecArgs } from "../channel-a";
import type { ProviderCommandOutput } from "../provider-command-session";
import {
  ModalCommandControl as LegacyControl,
  commandControlPlane,
  decodePage,
} from "./modal-legacy-command-control";
import { ModalCommandRouterWire } from "./modal-command-router-wire";

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
    return {
      kind: "modal-router-v1",
      sandboxId,
      taskId: task.taskId,
      execId,
      ...(args.tty ? { pty: true } : {}),
      streams: {
        stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      },
    };
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
