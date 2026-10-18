import { afterAll, expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import { DURABLE_PROCESS_ID_MIN } from "../src/sandbox/durable-shell-process";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import { dockerProvider } from "../src/sandbox/providers/docker";

// A real container: set OPENGENI_TEST_DOCKER_IMAGE to any image with a POSIX
// userland (the sandbox image, or for example debian:stable-slim).
const image = process.env.OPENGENI_TEST_DOCKER_IMAGE?.trim();

type Session = {
  state: { containerId: string };
  execCommand(args: Record<string, unknown>): Promise<string>;
  writeStdin(args: Record<string, unknown>): Promise<string>;
  isDurableProcessHandle(id: number): boolean;
  stopDurableProcess(id: number): Promise<boolean>;
  close(): Promise<void>;
};
type Client = {
  create(manifest: Manifest): Promise<Session>;
  resumeExact(state: unknown): Promise<Session>;
};

const opened: Session[] = [];
afterAll(async () => {
  for (const session of opened) await session.close().catch(() => undefined);
});

function output(banner: string): string {
  return banner.slice(banner.indexOf("Output:\n") + "Output:\n".length);
}

test.skipIf(!image)(
  "a container command outlives its session object and is driven by another one",
  async () => {
    const client = dockerProvider.build({
      settings: { dockerImage: image },
      exposedPorts: [],
    } as never) as unknown as Client;
    const session = await client.create(new Manifest());
    opened.push(session);

    const shell = await session.execCommand({ cmd: "sh", yieldTimeMs: 200 });
    const id = parseExecBannerSessionId(shell)!;
    expect(id).toBeGreaterThanOrEqual(DURABLE_PROCESS_ID_MIN);

    // A later turn or the reaper: a different session object, same container.
    const later = await client.resumeExact(structuredClone(session.state));
    expect(later).not.toBe(session);
    expect(later.isDurableProcessHandle(id)).toBe(true);
    const answer = await later.writeStdin({
      sessionId: id,
      chars: "echo $((6 * 7))\n",
      yieldTimeMs: 800,
    });
    expect(parseExecBannerSessionId(answer)).toBe(id);
    expect(output(answer)).toBe("42\n");

    const server = await later.execCommand({ cmd: "sleep 60", yieldTimeMs: 100 });
    const serverId = parseExecBannerSessionId(server)!;
    const reaper = await client.resumeExact(structuredClone(session.state));
    expect(await reaper.stopDurableProcess(serverId)).toBe(true);
    let stopped = "";
    for (let i = 0; i < 20 && parseExecBannerExitCode(stopped) === null; i += 1) {
      stopped = await reaper.writeStdin({ sessionId: serverId, chars: "", yieldTimeMs: 500 });
    }
    expect(parseExecBannerExitCode(stopped)).toBe(143);

    // Ctrl-C reaches a command started by the container's own /bin/sh, given
    // any tool that can restore SIGINT (a BusyBox-only image has none).
    const canRestore = await later.execCommand({
      cmd: "env --default-signal=INT true 2>/dev/null || command -v perl || command -v python3",
      yieldTimeMs: 5_000,
    });
    if (parseExecBannerExitCode(canRestore) === 0) {
      const sleeper = await later.execCommand({ cmd: "sleep 60", yieldTimeMs: 100 });
      const sleeperId = parseExecBannerSessionId(sleeper)!;
      let interrupted = await reaper.writeStdin({
        sessionId: sleeperId,
        chars: "\u0003",
        yieldTimeMs: 500,
      });
      for (let i = 0; i < 10 && parseExecBannerExitCode(interrupted) === null; i += 1) {
        interrupted = await reaper.writeStdin({
          sessionId: sleeperId,
          chars: "",
          yieldTimeMs: 500,
        });
      }
      expect(parseExecBannerExitCode(interrupted)).toBe(130);
    }

    let exited = await reaper.writeStdin({ sessionId: id, chars: "exit 5\n", yieldTimeMs: 800 });
    for (let i = 0; i < 10 && parseExecBannerExitCode(exited) === null; i += 1) {
      exited = await reaper.writeStdin({ sessionId: id, chars: "", yieldTimeMs: 500 });
    }
    expect(parseExecBannerExitCode(exited)).toBe(5);
  },
  120_000,
);
