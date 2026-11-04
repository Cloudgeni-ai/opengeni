import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { buildManifest, buildOpenGeniAgent, runOwnedSandboxSetup } from "../src/index";
import {
  ownedBoxRepairCommand,
  ownedBoxRepairHost,
  ownedBoxRepairNote,
  parseOwnedBoxRepairOutput,
} from "../src/sandbox/owned-box-repair";

const WORKER_EPOCH = 1_793_800_000; // 2026-11-04
const BOX_2001 = 978_307_200; // 2001-01-01
const PLATFORM_CMDLINE =
  "console=ttyS0 ip=169.254.0.21::169.254.0.22:255.255.255.252::eth0:off:169.254.0.22 clocksource=kvm-clock\n";
const HOST = "staging.app.opengeni.ai";

/**
 * A fake box: the script's own files live in a temp directory and `date`,
 * `getent`, `id` and `sudo` are stubs first on PATH. `getent` resolves only
 * while resolv.conf names the platform server, like the real box did.
 */
let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "owned-box-repair-"));
  const bin = join(box, "bin");
  spawnSync("mkdir", ["-p", bin]);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    "date",
    `if [ "$1 $2" = "-u +%s" ]; then cat "${box}/clock"; exit 0; fi
if [ "$1 $2" = "-u -s" ]; then
  [ -f "${box}/date-fails" ] && exit 1
  printf '%s' "$3" > "${box}/clock-set"; exit 0
fi
exit 2`,
  );
  stub("getent", `grep -qx 'nameserver 169.254.0.22' "${box}/resolv.conf" 2>/dev/null`);
  stub("id", `cat "${box}/uid"`);
  // Never reach a real sudo (or the real clock) from a test.
  stub("sudo", "exit 1");
  writeFileSync(join(box, "uid"), "0\n");
  writeFileSync(join(box, "cmdline"), PLATFORM_CMDLINE);
});
afterEach(() => rmSync(box, { recursive: true, force: true }));

function runOnBox(options: { clock: number; resolv?: string; host?: string | null }) {
  writeFileSync(join(box, "clock"), `${options.clock}\n`);
  if (options.resolv !== undefined) writeFileSync(join(box, "resolv.conf"), options.resolv);
  const command = ownedBoxRepairCommand({
    workerEpochSeconds: WORKER_EPOCH,
    host: options.host === undefined ? HOST : options.host,
    resolvConfPath: join(box, "resolv.conf"),
    kernelCmdlinePath: join(box, "cmdline"),
  });
  const run = spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(box, "bin")}:${process.env.PATH}` },
  });
  expect(run.status).toBe(0);
  return {
    stdout: run.stdout,
    report: parseOwnedBoxRepairOutput(run.stdout),
    clockSet: existsSync(join(box, "clock-set"))
      ? readFileSync(join(box, "clock-set"), "utf8")
      : null,
    resolv: existsSync(join(box, "resolv.conf"))
      ? readFileSync(join(box, "resolv.conf"), "utf8")
      : null,
    replaced: existsSync(join(box, "resolv.conf.opengeni-replaced"))
      ? readFileSync(join(box, "resolv.conf.opengeni-replaced"), "utf8")
      : null,
  };
}

describe("a cloud computer's clock and resolver are repaired at turn setup", () => {
  test("a clock set back to 2001 is set to the worker's time", () => {
    const result = runOnBox({ clock: BOX_2001, resolv: "nameserver 169.254.0.22\n" });
    expect(result.clockSet).toBe(`@${WORKER_EPOCH}`);
    expect(result.report).toEqual({
      clock: { set: true, fromEpochSeconds: BOX_2001, toEpochSeconds: WORKER_EPOCH },
    });
  });

  test("a clock within a few minutes, and a working resolver, are left alone", () => {
    const result = runOnBox({ clock: WORKER_EPOCH + 120, resolv: "nameserver 169.254.0.22\n" });
    expect(result.stdout).toBe("");
    expect(result.clockSet).toBeNull();
    expect(result.report).toEqual({});
  });

  test("a clock that cannot be set is reported, not fatal", () => {
    writeFileSync(join(box, "uid"), "1000\n");
    const result = runOnBox({ clock: BOX_2001, resolv: "nameserver 169.254.0.22\n" });
    expect(result.clockSet).toBeNull();
    expect(result.report.clock).toEqual({
      set: false,
      fromEpochSeconds: BOX_2001,
      toEpochSeconds: WORKER_EPOCH,
    });
  });

  test("a resolver that cannot look up Opengeni is restored from the kernel command line", () => {
    const result = runOnBox({ clock: WORKER_EPOCH, resolv: "nameserver 192.0.2.1\n" });
    expect(result.resolv).toBe("nameserver 169.254.0.22\n");
    expect(result.replaced).toBe("nameserver 192.0.2.1\n");
    expect(result.report).toEqual({
      dns: { outcome: "restored", servers: ["169.254.0.22"], host: HOST },
    });
  });

  test("a resolver that works is never touched, whatever it says", () => {
    const custom = "# mine\nnameserver 169.254.0.22\noptions ndots:2\n";
    const result = runOnBox({ clock: WORKER_EPOCH, resolv: custom });
    expect(result.resolv).toBe(custom);
    expect(result.replaced).toBeNull();
    expect(result.report).toEqual({});
  });

  test("without platform name servers the resolver is reported, not rewritten", () => {
    writeFileSync(join(box, "cmdline"), "console=ttyS0 ip=dhcp\n");
    const result = runOnBox({ clock: WORKER_EPOCH, resolv: "nameserver 192.0.2.1\n" });
    expect(result.resolv).toBe("nameserver 192.0.2.1\n");
    expect(result.report.dns).toEqual({
      outcome: "unrepaired",
      reason: "no-platform-servers",
      host: HOST,
    });
  });

  test("a missing resolv.conf is recreated", () => {
    const result = runOnBox({ clock: WORKER_EPOCH });
    expect(result.resolv).toBe("nameserver 169.254.0.22\n");
    expect(result.report.dns?.outcome).toBe("restored");
  });

  test("without Opengeni's host there is no DNS check", () => {
    const result = runOnBox({ clock: WORKER_EPOCH, resolv: "nameserver 192.0.2.1\n", host: null });
    expect(result.resolv).toBe("nameserver 192.0.2.1\n");
    expect(result.report).toEqual({});
  });

  test("the model is told what changed", () => {
    expect(
      ownedBoxRepairNote({
        clock: { set: true, fromEpochSeconds: BOX_2001, toEpochSeconds: WORKER_EPOCH },
        dns: { outcome: "restored", servers: ["169.254.0.22"], host: HOST },
      }),
    ).toBe(
      [
        "[Opengeni repaired this chat's cloud computer before this turn]",
        "- Its clock said 2001-01-01 00:00 UTC, so Opengeni set it to 2026-11-04 13:46 UTC.",
        "- It could not look up staging.app.opengeni.ai, so Opengeni restored /etc/resolv.conf to the platform name servers (169.254.0.22); the previous file is /etc/resolv.conf.opengeni-replaced.",
      ].join("\n"),
    );
    expect(ownedBoxRepairNote({})).toBeNull();
    expect(
      ownedBoxRepairNote({
        clock: { set: false, fromEpochSeconds: BOX_2001, toEpochSeconds: WORKER_EPOCH },
      }),
    ).toBeNull();
  });

  test("the host comes from the Codemode URL", () => {
    expect(
      ownedBoxRepairHost({
        OPENGENI_CODEMODE_URL: "https://staging.app.opengeni.ai/v1/workspaces/w/codemode",
      }),
    ).toBe(HOST);
    expect(ownedBoxRepairHost({})).toBeNull();
    expect(ownedBoxRepairHost({ OPENGENI_CODEMODE_URL: "not a url" })).toBeNull();
  });
});

describe("owned setup repairs only the chat's own cloud computer", () => {
  async function setup(
    backend: "compute" | "modal" | "selfhosted",
    repairOutput: string,
    configuredBackend: "compute" | "modal" = backend === "modal" ? "modal" : "compute",
  ) {
    // A chat on compute can move to a Connected Machine; its configured
    // backend stays compute while the active one is selfhosted.
    const settings = testSettings({ sandboxBackend: configuredBackend, webSearchEnabled: false });
    const environment = {
      HOME: "/workspace",
      OPENGENI_CODEMODE_URL: "https://staging.app.opengeni.ai/v1/workspaces/w/codemode",
    };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
      activeSandboxBackend: backend,
      ...(backend === "selfhosted" ? { sandboxWorkspaceRoot: "/Users/person" } : {}),
    });
    const commands: string[] = [];
    const session = {
      state: { manifest: buildManifest(settings, [], environment) },
      exec: async (args: { cmd: string }) => {
        commands.push(args.cmd);
        return {
          exitCode: 0,
          output: args.cmd.includes("opengeni-box-repair:") ? repairOutput : "",
        };
      },
    };
    const preparedInput = { input: "hello", persistedHistoryCount: 0 };
    await runOwnedSandboxSetup(agent, session as never, session as never, {
      settings,
      environment,
      preparedInput,
    });
    return {
      repairCommands: commands.filter((cmd) => cmd.includes("opengeni-box-repair:")),
      input: preparedInput.input,
    };
  }

  test("a compute box is checked, and the model hears what was repaired", async () => {
    const result = await setup(
      "compute",
      `opengeni-box-repair: clock=set from=${BOX_2001} to=${WORKER_EPOCH}\n`,
    );
    expect(result.repairCommands).toHaveLength(1);
    expect(result.repairCommands[0]).toContain(`host='${HOST}'`);
    expect(result.input).toContain("hello");
    expect(result.input).toContain("Its clock said 2001-01-01 00:00 UTC");
  });

  test("a healthy compute box leaves the input unchanged", async () => {
    const result = await setup("compute", "");
    expect(result.repairCommands).toHaveLength(1);
    expect(result.input).toBe("hello");
  });

  test.each(["modal", "selfhosted"] as const)(
    "a %s box's clock and resolver are never touched",
    async (backend) => {
      const result = await setup(backend, "");
      expect(result.repairCommands).toEqual([]);
    },
  );
});
