import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRigSetupHook, type RigSetupDescriptor } from "../src/index";
import { hostShellSession } from "./isolated-git-home-fixture";

const setup = (script: string): RigSetupDescriptor => ({
  rigId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  rigName: "test-machine",
  timeoutMs: 10_000,
  script,
});

for (const gzipAvailable of [true, false]) {
  test.skipIf(gzipAvailable && Bun.which("gzip") === null)(
    `setup payload round-trips with gzip ${gzipAvailable ? "available" : "unavailable"}`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), "opengeni-setup-transfer-"));
      const payloadRoot = join(home, "payloads");
      const script = `set -eu\n${"printf '%s' 'sky ☁️ $HOME `literal`' >/dev/null\n".repeat(2_000)}`;
      const calls: string[] = [];
      let executions = 0;
      const host = hostShellSession(home, {
        rewriteCommand: (cmd) => cmd.replaceAll("/tmp/opengeni/rig-setup-payloads", payloadRoot),
      });
      const session = {
        exec: async ({ cmd }: { cmd: string }) => {
          calls.push(cmd);
          if (cmd.endsWith("\nexit 42")) return { status: 42, output: "" };
          const executable = cmd.match(/exec bash '(\/tmp\/opengeni\/[^']+\.sh)'/u);
          if (executable) {
            executions++;
            const path = executable[1]!.replace("/tmp/opengeni/rig-setup-payloads", payloadRoot);
            expect(await readFile(path, "utf8")).toBe(script);
            expect((await stat(path)).mode & 0o777).toBe(0o700);
            return { status: 0, output: "" };
          }
          return await host.exec({
            cmd: gzipAvailable
              ? cmd
              : cmd.replace("command -v gzip", "command -v __opengeni_test_missing_gzip"),
          });
        },
      };
      try {
        await runRigSetupHook(session as never, { environment: {}, rigSetup: setup(script) });
        expect(executions).toBe(1);
        expect(calls.some((cmd) => cmd.includes("| gzip -dc"))).toBe(gzipAvailable);
        const transfers = calls.filter((cmd) => cmd.startsWith("printf '%s'"));
        expect(transfers.every((cmd) => Buffer.byteLength(cmd, "utf8") < 4 * 1024)).toBe(true);
        if (gzipAvailable) expect(transfers.length).toBeLessThan(4);
        else expect(transfers.length).toBeGreaterThan(40);
        expect(await readdir(payloadRoot)).toEqual([]);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(Bun.which("gzip") === null)(
  "a corrupt compressed transfer fails before execution and removes staged files",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "opengeni-setup-corrupt-"));
    const payloadRoot = join(home, "payloads");
    const host = hostShellSession(home, {
      rewriteCommand: (cmd) => cmd.replaceAll("/tmp/opengeni/rig-setup-payloads", payloadRoot),
    });
    const calls: string[] = [];
    const session = {
      exec: async ({ cmd }: { cmd: string }) => {
        calls.push(cmd);
        if (cmd.endsWith("\nexit 42")) return { status: 42, output: "" };
        const damaged = cmd.startsWith("printf '%s'")
          ? cmd.replace(/'([A-Za-z0-9+/=]+)' >>/u, "'AAAA' >>")
          : cmd;
        return await host.exec({ cmd: damaged });
      },
    };
    try {
      await expect(
        runRigSetupHook(session as never, {
          environment: {},
          rigSetup: setup(`set -eu\n${"printf x >/dev/null\n".repeat(2_000)}`),
        }),
      ).rejects.toThrow("payload staging");
      expect(calls.some((cmd) => cmd.includes("exec bash '/tmp/opengeni/"))).toBe(false);
      expect(calls.filter((cmd) => cmd.startsWith("printf '%s'"))).toHaveLength(1);
      expect(await readdir(payloadRoot)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
