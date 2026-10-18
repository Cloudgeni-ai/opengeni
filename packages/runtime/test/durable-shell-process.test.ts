import { afterAll, describe, expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DURABLE_PROCESS_ID_MIN,
  hasDurableShellProcesses,
  type DurableShellProcessSession,
} from "../src/sandbox/durable-shell-process";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { withNativeSynchronousCommandCollection } from "../src/sandbox/native-synchronous-collection";
import { executeSynchronousCommand } from "../src/sandbox/synchronous-command";
import { localProvider } from "../src/sandbox/providers/local";

type Session = DurableShellProcessSession & {
  state: { workspaceRootPath: string };
  execCommand(args: Record<string, unknown>): Promise<string>;
  writeStdin(args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
};

type Client = {
  create(manifest: Manifest): Promise<Session>;
  resumeExact(state: unknown): Promise<Session>;
};

const client = localProvider.build({} as never) as unknown as Client;
const opened: Session[] = [];

// The SDK's default local PATH lists only FHS directories; keep the host's so
// the supervisor finds mkfifo and friends on any test machine.
function hostManifest(): Manifest {
  return new Manifest({ environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
}

async function workspace(): Promise<Session> {
  const session = await client.create(hostManifest());
  opened.push(session);
  return session;
}

/** A brand-new session object for the same workspace, as a later turn, another
 * worker or the reaper would construct. It shares no memory with the first. */
async function reopen(session: Session): Promise<Session> {
  return await client.resumeExact(structuredClone(session.state));
}

function output(banner: string): string {
  return banner.slice(banner.indexOf("Output:\n") + "Output:\n".length);
}

function runDir(session: Session, id: number): string {
  const uid = process.getuid?.() ?? 0;
  const ns = createHash("sha256")
    .update(session.state.workspaceRootPath)
    .digest("hex")
    .slice(0, 16);
  return join(process.env.TMPDIR || tmpdir() || "/tmp", `opengeni-exec-${uid}`, ns, String(id));
}

async function readUntilExit(session: Session, id: number, chars = ""): Promise<string> {
  let text = "";
  let first = true;
  for (let i = 0; i < 40; i += 1) {
    const banner = await session.writeStdin({
      sessionId: id,
      chars: first ? chars : "",
      yieldTimeMs: 500,
    });
    first = false;
    text += output(banner);
    if (parseExecBannerExitCode(banner) !== null) return `${banner}\n@@${text}`;
  }
  throw new Error(`process ${id} did not exit`);
}

afterAll(async () => {
  for (const session of opened) await session.close().catch(() => undefined);
});

describe("session-owned Docker/local processes", () => {
  test("a short command still returns inline with its exit code", async () => {
    const session = await workspace();
    expect(hasDurableShellProcesses(session)).toBe(true);
    const banner = await session.execCommand({ cmd: "echo hi; exit 3", yieldTimeMs: 5_000 });
    expect(parseExecBannerExitCode(banner)).toBe(3);
    expect(output(banner)).toBe("hi\n");
  });

  test("worker synchronous runners keep the SDK's own child and separate streams", async () => {
    const session = await workspace();
    const channel = session as unknown as ChannelASession;
    const result = await executeSynchronousCommand(channel, {
      cmd: "printf out; printf err >&2; exit 4",
    });
    expect(result).toMatchObject({ stdout: "out", stderr: "err", exitCode: 4 });
    // A formatted Start inside the same scope is the SDK's, not the supervisor's.
    const banner = await withNativeSynchronousCommandCollection(channel, async () =>
      session.execCommand({ cmd: "sleep 1; echo late", yieldTimeMs: 100 }),
    );
    const id = parseExecBannerSessionId(banner)!;
    expect(id).toBeLessThan(DURABLE_PROCESS_ID_MIN);
    expect(session.isDurableProcessHandle(id)).toBe(false);
  });

  test("a yielded command is reachable from a fresh session object and settles once", async () => {
    const session = await workspace();
    const started = await session.execCommand({
      cmd: "echo begin; sleep 0.6; echo done; exit 4",
      yieldTimeMs: 150,
    });
    const id = parseExecBannerSessionId(started);
    expect(id).not.toBeNull();
    expect(id!).toBeGreaterThanOrEqual(DURABLE_PROCESS_ID_MIN);
    expect(output(started)).toBe("begin\n");

    const later = await reopen(session);
    expect(later.isDurableProcessHandle(id!)).toBe(true);
    const finished = await readUntilExit(later, id!);
    expect(parseExecBannerExitCode(finished)).toBe(4);
    expect(finished.split("\n@@")[1]).toBe("done\n");
    // Every later reader (the reaper included) sees the same exit, not a loss.
    const again = await (await reopen(session)).writeStdin({ sessionId: id!, chars: "" });
    expect(parseExecBannerExitCode(again)).toBe(4);
  });

  test("an interactive shell outlives its session object and takes input from another", async () => {
    const session = await workspace();
    const started = await session.execCommand({ cmd: "sh", yieldTimeMs: 200 });
    const id = parseExecBannerSessionId(started)!;
    expect(id).toBeGreaterThanOrEqual(DURABLE_PROCESS_ID_MIN);

    const second = await reopen(session);
    const answer = await second.writeStdin({
      sessionId: id,
      chars: "echo $((40 + 2))\n",
      yieldTimeMs: 700,
    });
    expect(parseExecBannerSessionId(answer)).toBe(id);
    expect(output(answer)).toBe("42\n");

    const third = await reopen(session);
    const exited = await readUntilExit(third, id, "exit 7\n");
    expect(parseExecBannerExitCode(exited)).toBe(7);
  });

  test("Ctrl-C without a terminal interrupts the command's process group", async () => {
    const session = await workspace();
    const started = await session.execCommand({ cmd: "sleep 30", yieldTimeMs: 100 });
    const id = parseExecBannerSessionId(started)!;
    const exited = await readUntilExit(await reopen(session), id, "\u0003");
    expect(parseExecBannerExitCode(exited)).toBe(130);
  });

  test("a command starts with SIGINT and SIGQUIT at their defaults, with or without a tty", async () => {
    if (!existsSync("/proc/self/status")) return;
    const session = await workspace();
    for (const tty of [false, true]) {
      const banner = await session.execCommand({
        cmd: "grep SigIgn /proc/$$/status",
        yieldTimeMs: 5_000,
        tty,
      });
      const mask = BigInt(`0x${/SigIgn:\s*([0-9a-f]+)/.exec(output(banner))![1]}`);
      expect(mask & 0b110n).toBe(0n);
    }
  });

  test("stop ends the whole process group and the exit is then reported", async () => {
    const session = await workspace();
    const started = await session.execCommand({
      cmd: "sleep 30 & sleep 30; wait",
      yieldTimeMs: 100,
    });
    const id = parseExecBannerSessionId(started)!;
    const stopper = await reopen(session);
    expect(await stopper.stopDurableProcess(id)).toBe(true);
    const exited = await readUntilExit(stopper, id);
    expect(parseExecBannerExitCode(exited)).toBe(143);
    expect(await stopper.stopDurableProcess(DURABLE_PROCESS_ID_MIN + 1)).toBe(false);
  });

  test("a supervisor killed from outside is reported with the SDK loss banner", async () => {
    const session = await workspace();
    const started = await session.execCommand({ cmd: "sleep 30", yieldTimeMs: 100 });
    const id = parseExecBannerSessionId(started)!;
    const dir = runDir(session, id);
    expect(existsSync(join(dir, "wrapper"))).toBe(true);
    const wrapper = Number(readFileSync(join(dir, "wrapper"), "utf8").split(" ")[0]);
    const child = Number(readFileSync(join(dir, "child"), "utf8"));
    process.kill(wrapper, "SIGKILL");
    process.kill(-child, "SIGKILL");
    const lost = await (await reopen(session)).writeStdin({ sessionId: id, chars: "" });
    expect(lost).toContain("Process exited with code 1");
    expect(output(lost)).toBe(`write_stdin failed: session not found: ${id}`);
  });

  test("stop still ends what a command left running after its own shell exited", async () => {
    const session = await workspace();
    const started = await session.execCommand({
      cmd: "sleep 30 >/dev/null 2>&1 & echo $!; sleep 1",
      yieldTimeMs: 300,
    });
    const id = parseExecBannerSessionId(started)!;
    const leftover = Number(output(started).trim());
    expect(leftover).toBeGreaterThan(0);
    await Bun.sleep(1_500);
    expect(existsSync(join(runDir(session, id), "exit"))).toBe(true);
    expect(() => process.kill(leftover, 0)).not.toThrow();
    expect(await (await reopen(session)).stopDurableProcess(id)).toBe(true);
    await Bun.sleep(300);
    expect(() => process.kill(leftover, 0)).toThrow();
  });

  test("input a command never reads is queued without ever blocking the caller", async () => {
    const session = await workspace();
    const started = await session.execCommand({ cmd: "sleep 30", yieldTimeMs: 100 });
    const id = parseExecBannerSessionId(started)!;
    const later = await reopen(session);
    // More than any pipe can hold here: an unprivileged pipe never exceeds
    // the host's pipe-max-size, and some hosts default well above 64 KiB.
    const pipeMax = existsSync("/proc/sys/fs/pipe-max-size")
      ? Number(readFileSync("/proc/sys/fs/pipe-max-size", "utf8"))
      : 1024 * 1024;
    const big = "x".repeat(pipeMax + 64 * 1024);
    const began = Date.now();
    const first = await later.writeStdin({ sessionId: id, chars: big, yieldTimeMs: 100 });
    expect(parseExecBannerSessionId(first)).toBe(id);
    const second = await later.writeStdin({ sessionId: id, chars: "y\n", yieldTimeMs: 100 });
    expect(Date.now() - began).toBeLessThan(15_000);
    expect(parseExecBannerSessionId(second)).toBe(id);
    expect(output(second)).toBe(
      `write_stdin failed: process ${id} has not read its earlier input yet, so this input was not sent. Read its output with empty input, then try again.`,
    );
    const writer = Number(readlinkSync(join(runDir(session, id), "wlock")).split(" ")[0]);
    expect(() => process.kill(writer, 0)).not.toThrow();
    // Ctrl-C needs no pipe space, so it still interrupts the command.
    const exited = await readUntilExit(later, id, "\u0003");
    expect(parseExecBannerExitCode(exited)).toBe(130);
    // The blocked writer ends with the command instead of lingering.
    await Bun.sleep(200);
    expect(() => process.kill(writer, 0)).toThrow();
  });

  test("a multibyte character split across reads is never torn", async () => {
    const session = await workspace();
    const started = await session.execCommand({
      cmd: "printf 'a\\342\\202'; sleep 0.6; printf '\\254b\\n'",
      yieldTimeMs: 250,
    });
    const id = parseExecBannerSessionId(started)!;
    expect(output(started)).toBe("a");
    const finished = await readUntilExit(await reopen(session), id);
    expect(finished.split("\n@@")[1]).toBe("\u20acb\n");
  });

  test("large output is delivered in full across bounded pages", async () => {
    const session = await workspace();
    const started = await session.execCommand({
      cmd: "head -c 2500000 /dev/zero | tr '\\0' x; sleep 0.3",
      yieldTimeMs: 100,
      maxOutputTokens: 10_000_000,
    });
    const id = parseExecBannerSessionId(started)!;
    let total = output(started).length;
    for (let i = 0; i < 20; i += 1) {
      const banner = await session.writeStdin({
        sessionId: id,
        chars: "",
        yieldTimeMs: 400,
        maxOutputTokens: 10_000_000,
      });
      total += output(banner).length;
      if (parseExecBannerExitCode(banner) !== null) break;
    }
    expect(total).toBe(2_500_000);
  });

  test("a command keeps the SDK's working directory, environment and path translation", async () => {
    const session = await workspace();
    const banner = await session.execCommand({
      cmd: 'pwd; printf "%s\\n" "$HOME" "$USER"; ls /workspace >/dev/null && echo mapped',
    });
    expect(parseExecBannerSessionId(banner)).toBeNull();
    expect(output(banner).trim().split("\n")).toEqual([
      "/workspace",
      "/workspace",
      "sandbox",
      "mapped",
    ]);
  });

  test("a terminal command runs under a real tty and reads typed input", async () => {
    const session = await workspace();
    const started = await session.execCommand({
      cmd: "[ -t 0 ] && echo tty; read line; echo got:$line",
      tty: true,
      yieldTimeMs: 300,
    });
    const id = parseExecBannerSessionId(started);
    // A host without util-linux script keeps the SDK's in-memory terminal.
    if (!Bun.which("script")) return;
    expect(id).not.toBeNull();
    expect(id!).toBeGreaterThanOrEqual(DURABLE_PROCESS_ID_MIN);
    const finished = await readUntilExit(await reopen(session), id!, "hello\n");
    expect(parseExecBannerExitCode(finished)).toBe(0);
    expect(`${output(started)}${finished.split("\n@@")[1]}`).toContain("got:hello");
  });

  test("closing a local workspace stops every command it still supervises", async () => {
    const session = await client.create(hostManifest());
    const started = await session.execCommand({ cmd: "sleep 30", yieldTimeMs: 100 });
    const id = parseExecBannerSessionId(started)!;
    const child = Number(readFileSync(join(runDir(session, id), "child"), "utf8"));
    await session.close();
    let alive = true;
    for (let i = 0; i < 40 && alive; i += 1) {
      try {
        process.kill(child, 0);
        await Bun.sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
