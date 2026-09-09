import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { shellQuote } from "@openai/agents-core/sandbox/internal";
import type { ChannelAExecArgs } from "../channel-a";
import { MODAL_COMMAND_RUNNER } from "./modal-command-runner";
import { parseExecResponseBanner } from "../exec-banner";
import { nextDurableOpId } from "../op-correlation";

type Process = {
  stdout: { readText(): Promise<string> };
  stderr: { readText(): Promise<string> };
  wait(): Promise<number>;
};
type Session = {
  state?: { manifest?: { root?: string }; environment?: Record<string, string> };
  sandbox?: { exec(command: string[], options: Record<string, unknown>): Promise<Process> };
  execCommand?: (args: ChannelAExecArgs) => Promise<string>;
  writeStdin?: (args: {
    sessionId: number;
    chars?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<string>;
  acknowledgeCommandOutput?: (result: string) => Promise<void>;
};

const RECEIPT = /^Command journal: ([1-9]\d*):(\d+):(\d+)$/mu;
export function modalCommandReceipt(
  result: unknown,
): { handle: number; range: [number, number]; chunkId: string } | null {
  if (typeof result !== "string") return null;
  const banner = parseExecResponseBanner(result);
  if (banner.kind !== "running" && banner.kind !== "exited") return null;
  const header = result.split(/\r?\nOutput:\r?\n/u, 1)[0]!;
  const match = RECEIPT.exec(header);
  if (!match) return null;
  const handle = Number(match[1]);
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (
    ![handle, start, end].every(Number.isSafeInteger) ||
    end < start ||
    (banner.kind === "running" && banner.sessionId !== handle)
  )
    return null;
  return { handle, range: [start, end], chunkId: `modal:${handle}:${start}:${end}` };
}

/** This adapter never polls an SDK-local numeric handle. Each invocation uses
 * a short foreground provider RPC to the sandbox-resident command journal. */
export function installModalCommandJournal(session: Session): void {
  if (!session.sandbox?.exec || !session.state?.manifest?.root) return;
  const invoke = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const process = await session.sandbox!.exec(
      [
        "/bin/sh",
        "-c",
        `exec python3 -c ${shellQuote(MODAL_COMMAND_RUNNER)} ${shellQuote(Buffer.from(JSON.stringify(request)).toString("base64"))}`,
      ],
      { mode: "text", env: session.state?.environment, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      process.stdout.readText(),
      process.stderr.readText(),
      process.wait(),
    ]);
    if (exitCode !== 0) throw new Error(`Modal command journal failed (${exitCode}): ${stderr}`);
    return JSON.parse(stdout) as Record<string, unknown>;
  };
  const read = async (request: Record<string, unknown>): Promise<string> => {
    const result = await invoke(request);
    if (
      (result.state !== "running" && result.state !== "exited") ||
      typeof result.output !== "string" ||
      !Array.isArray(result.range)
    ) {
      throw new Error("Invalid Modal command journal response");
    }
    const terminal = result.state === "exited" && result.more === false;
    if (terminal && !Number.isSafeInteger(result.exitCode))
      throw new Error("Modal command exit status unavailable");
    return [
      `Command journal: ${request.handle}:${result.range[0]}:${result.range[1]}`,
      terminal
        ? `Process exited with code ${result.exitCode}`
        : `Process running with session ID ${request.handle}`,
      "Output:",
      Buffer.from(result.output, "base64").toString("utf8"),
    ].join("\n");
  };
  session.execCommand = async (args) => {
    const root = session.state!.manifest!.root!;
    const workdir = posix.resolve(root, args.workdir ?? root);
    if (workdir !== root && !workdir.startsWith(`${root.replace(/\/$/u, "")}/`))
      throw new Error("Command workdir is outside the sandbox workspace");
    const operationId = nextDurableOpId() ?? randomUUID();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          operationId,
          args: { ...args, workdir },
          environment: session.state?.environment,
        }),
      )
      .digest("hex");
    const { handle } = await invoke({
      op: "allocate",
      key: createHash("sha256").update(operationId).digest("hex"),
      fingerprint,
    });
    if (!Number.isInteger(handle) || Number(handle) < 1073741824 || Number(handle) > 2147483647)
      throw new Error("Invalid Modal command allocation");
    return read({
      op: "start",
      handle,
      fingerprint,
      args: { ...args, workdir },
      yieldMs: args.yieldTimeMs ?? 10000,
    });
  };
  session.writeStdin = async (args) =>
    read({
      op: "read",
      handle: args.sessionId,
      chars: args.chars ?? "",
      yieldMs: args.yieldTimeMs ?? 250,
    });
  session.acknowledgeCommandOutput = async (result) => {
    const receipt = modalCommandReceipt(result);
    if (receipt) await invoke({ op: "ack", handle: receipt.handle, range: receipt.range });
  };
}
