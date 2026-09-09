import { posix } from "node:path";
import type { ModalClient } from "modal";
import { SandboxProviderCommand } from "@opengeni/contracts";
import type { ChannelAExecArgs } from "../channel-a";
import { shellQuote } from "@openai/agents-core/sandbox/internal";

type ControlPlane = Pick<
  ModalClient["cpClient"],
  "sandboxGetTaskId" | "containerExec" | "containerExecGetOutput" | "containerExecPutInput"
>;
export type ModalCommandStream = "stdout" | "stderr";
export type ModalProviderCommand = SandboxProviderCommand;
export type ModalProviderOutputPage = {
  command: ModalProviderCommand;
  chunks: Array<{ stream: ModalCommandStream; chunkId: string; text: string }>;
  exitCode: number | null;
};

// A provider batch may end halfway through a UTF-8 character. Keep only that
// unfinished suffix in protected cursor state; invalid complete bytes still
// use the usual replacement-character decoding policy.
function decodePage(prior: string, input: Uint8Array[], terminal: boolean) {
  const bytes = Buffer.concat([Buffer.from(prior, "base64"), ...input]);
  let boundary = bytes.length;
  if (!terminal) {
    for (let start = Math.max(0, bytes.length - 3); start < bytes.length; start++) {
      const first = bytes[start]!;
      const width =
        first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
      if (!width || bytes.length - start >= width) continue;
      const suffix = bytes.subarray(start + 1);
      if (!suffix.every((byte) => byte >= 0x80 && byte <= 0xbf)) continue;
      const second = suffix[0];
      if (
        second !== undefined &&
        ((first === 0xe0 && second < 0xa0) ||
          (first === 0xed && second > 0x9f) ||
          (first === 0xf0 && second < 0x90) ||
          (first === 0xf4 && second > 0x8f))
      )
        continue;
      boundary = start;
      break;
    }
  }
  return {
    text: bytes.subarray(0, boundary).toString("utf8"),
    remainder: bytes.subarray(boundary).toString("base64"),
  };
}

/** Version-pinned Modal control-plane boundary. Execution identity, output
 * batches and exit status come from authenticated provider RPCs, never sandbox
 * files or an SDK object's in-memory process map. Callers must store the
 * returned locator/cursors outside the command's write authority. */
export class ModalCommandControl {
  private constructor(
    private readonly client: ControlPlane,
    private readonly sandboxId: string,
    private readonly root: string,
    private readonly environment: Record<string, string> | (() => Record<string, string>) = {},
  ) {}

  static forSandbox(
    client: Pick<ModalClient, "cpClient" | "version">,
    sandboxId: string,
    root: string,
    environment: Record<string, string> | (() => Record<string, string>) = {},
  ): ModalCommandControl {
    if (client.version() !== "0.9.0")
      throw new Error("Modal command control requires the verified 0.9.0 SDK contract");
    return new ModalCommandControl(client.cpClient, sandboxId, root, environment);
  }

  async start(args: ChannelAExecArgs): Promise<ModalProviderCommand> {
    const workdir = posix.resolve(this.root, args.workdir ?? this.root);
    if (workdir !== this.root && !workdir.startsWith(`${this.root.replace(/\/$/u, "")}/`))
      throw new Error("Command workdir is outside the sandbox workspace");
    const task = await this.client.sandboxGetTaskId({ sandboxId: this.sandboxId });
    if (!task.taskId || task.taskResult) throw new Error("Modal command task is unavailable");
    // Match the pinned SDK's default non-login /bin/sh and runAs behavior,
    // including an already-matching non-root user and sudo-based transitions.
    let script = args.cmd;
    if (args.runAs) {
      const user = shellQuote(args.runAs);
      const body = shellQuote(script);
      script = `if [ "$(id -u)" = ${user} ] || [ "$(id -un 2>/dev/null)" = ${user} ]; then /bin/sh -lc ${body}; elif [ "$(id -u)" = 0 ]; then su -s /bin/sh ${user} -c ${body}; else sudo -n -u ${user} -- sh -lc ${body}; fi`;
    }
    const login = args.shell ? (args.login ?? true) : false;
    let command = [args.shell ?? "/bin/sh", login ? "-lc" : "-c", script];
    const environment =
      typeof this.environment === "function" ? this.environment() : this.environment;
    if (Object.keys(environment).length) {
      command = [
        "/usr/bin/env",
        "--",
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        ...command,
      ];
    }
    // Do not retry this mutating start on an ambiguous transport error: this
    // provider API assigns the execution id in its response, not in our request.
    const result = await this.client.containerExec(
      {
        taskId: task.taskId,
        command,
        terminateContainerOnExit: false,
        runtimeDebug: false,
        stdoutOutput: 2,
        stderrOutput: 2,
        timeoutSecs: 0,
        workdir,
        secretIds: [],
        ...(args.tty
          ? {
              ptyInfo: {
                enabled: true,
                winszRows: 24,
                winszCols: 80,
                envTerm: "xterm",
                envColorterm: "",
                envTermProgram: "",
                ptyType: 1,
                noTerminateOnIdleStdin: true,
              },
            }
          : {}),
      },
      { retries: 0 },
    );
    if (!result.execId) throw new Error("Modal command start returned no execution identity");
    return {
      kind: "modal-control-v1",
      sandboxId: this.sandboxId,
      taskId: task.taskId,
      execId: result.execId,
      streams: {
        stdout: { batchIndex: 0, utf8Remainder: "", exitCode: null },
        stderr: { batchIndex: 0, utf8Remainder: "", exitCode: null },
      },
    };
  }

  async read(command: ModalProviderCommand, yieldTimeMs: number): Promise<ModalProviderOutputPage> {
    this.assertIdentity(command);
    const next = structuredClone(command);
    const pages = await Promise.all(
      (["stdout", "stderr"] as const).map(async (stream) => {
        const cursor = command.streams[stream];
        if (cursor.exitCode !== null) return null;
        const descriptor = stream === "stdout" ? 1 : 2;
        for await (const batch of this.client.containerExecGetOutput({
          execId: command.execId,
          timeout: Math.max(0, yieldTimeMs) / 1000,
          lastBatchIndex: cursor.batchIndex,
          fileDescriptor: descriptor,
          getRawBytes: true,
        })) {
          if (batch.batchIndex <= cursor.batchIndex) continue;
          if (!Number.isSafeInteger(batch.batchIndex))
            throw new Error("Invalid Modal output cursor");
          const terminal = batch.exitCode !== undefined;
          if (terminal && !Number.isSafeInteger(batch.exitCode))
            throw new Error("Invalid Modal exit status");
          const decoded = decodePage(
            cursor.utf8Remainder,
            batch.items
              .filter((item) => item.fileDescriptor === descriptor)
              .map((item) => item.messageBytes),
            terminal,
          );
          next.streams[stream] = {
            batchIndex: batch.batchIndex,
            utf8Remainder: decoded.remainder,
            exitCode: terminal ? batch.exitCode! : null,
          };
          return {
            stream,
            chunkId: `modal:${command.execId}:${stream}:${cursor.batchIndex}:${batch.batchIndex}`,
            text: decoded.text,
          };
        }
        return null;
      }),
    );
    const stdoutExit = next.streams.stdout.exitCode;
    const stderrExit = next.streams.stderr.exitCode;
    if (stdoutExit !== null && stderrExit !== null && stdoutExit !== stderrExit)
      throw new Error("Modal output streams disagree about command exit status");
    return {
      command: next,
      chunks: pages.filter((page): page is NonNullable<typeof page> => page !== null),
      exitCode: stdoutExit !== null && stderrExit !== null ? stdoutExit : null,
    };
  }

  async write(command: ModalProviderCommand, chars: string, messageIndex: number): Promise<void> {
    this.assertIdentity(command);
    if (!chars) return;
    if (!Number.isSafeInteger(messageIndex) || messageIndex < 1)
      throw new Error("Modal stdin requires a protected monotonic message index");
    await this.client.containerExecPutInput(
      {
        execId: command.execId,
        input: { message: Buffer.from(chars), messageIndex, eof: false },
      },
      { retries: 0 },
    );
  }

  private assertIdentity(command: ModalProviderCommand): void {
    SandboxProviderCommand.parse(command);
    if (
      command.kind !== "modal-control-v1" ||
      command.sandboxId !== this.sandboxId ||
      !command.taskId ||
      !command.execId
    )
      throw new Error("Modal command locator does not match the original sandbox");
  }
}
