import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_INSTRUCTIONS_CORE_PLACEHOLDER, DEFAULT_AGENT_INSTRUCTIONS } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  composeAgentInstructions,
  coreInstructions,
  rigInstructions,
  rigSetupScriptCommand,
  runRigSetupHook,
  type RigSetupDescriptor,
} from "../src/index";

// A rig setup descriptor with a per-test timeout; rigName/ids are cosmetic.
function rigSetup(overrides: Partial<RigSetupDescriptor> = {}): RigSetupDescriptor {
  return {
    rigId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    rigName: "dev-machine",
    script: "echo ok > /var/opengeni/proof",
    timeoutMs: 600_000,
    ...overrides,
  };
}

describe("rig doctrine block (M3)", () => {
  const rig = { name: "dev-machine", version: 3 };

  test("coreInstructions is byte-identical without a rig, appends the block with one", () => {
    const withoutRig = coreInstructions();
    const withRig = coreInstructions(undefined, rig);
    // The rig block is purely additive: the goal-loop line still leads.
    expect(withRig.slice(0, withoutRig.length)).toEqual(withoutRig);
    expect(withRig.length).toBe(withoutRig.length + rigInstructions(rig).length);
  });

  test("composeAgentInstructions renders the rig name + version and the propose-change guidance", () => {
    const composed = composeAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, undefined, rig);
    expect(composed).toContain('rig "dev-machine" (active version v3)');
    expect(composed).toContain("EPHEMERAL FORK");
    expect(composed).toContain("rig_propose_change");
    expect(composed).toContain("rig_get");
  });

  test("a rig-less composition never mentions rigs", () => {
    const composed = composeAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS);
    expect(composed).not.toContain("rig_propose_change");
    expect(composed).not.toContain("EPHEMERAL FORK");
  });

  test("the block is data-conditional through the agent builder (present iff options.rig)", () => {
    const withRig = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], { rig });
    expect(withRig.instructions).toContain('rig "dev-machine" (active version v3)');
    const without = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    expect(without.instructions).not.toContain("rig_propose_change");
  });

  test("the block is non-bypassable: it survives a white-label {{core}} template", () => {
    const template = `You are ACME's co-pilot. ${AGENT_INSTRUCTIONS_CORE_PLACEHOLDER} Stay on brand.`;
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      instructionsTemplate: template,
      rig,
    });
    expect(agent.instructions).toContain("You are ACME's co-pilot.");
    expect(agent.instructions).toContain("rig_propose_change");
  });
});

describe("rigSetupScriptCommand (M3)", () => {
  test("guards on the per-version marker and only touches it on success", () => {
    const command = rigSetupScriptCommand("echo hi", "22222222-2222-4222-8222-222222222222", {
      timeoutMs: 600_000,
    });
    expect(command).toContain("mkdir -p '/var/opengeni'");
    expect(command).toContain("/var/opengeni/rig-setup-22222222-2222-4222-8222-222222222222.done");
    // Skip path prints the sentinel and exits 0 without running the script.
    expect(command).toContain("__OPENGENI_RIG_SETUP_SKIPPED__");
    // The script is hard-killed by coreutils timeout (NOT bash -e), and the
    // marker is touched only on rc 0.
    expect(command).toContain('timeout -k 5s "${__OG_RIG_TIMEOUT_SECS}s" bash "$__OG_RIG_SCRIPT"');
    expect(command).toContain('if [ "$__OG_RIG_RC" -eq 0 ]; then');
    expect(command).toContain('touch "$__OG_RIG_VERSION_MARKER"');
    // First attach is atomically claimed with a mkdir lockdir.
    expect(command).toContain('if mkdir "$__OG_RIG_LOCK" 2>/dev/null; then');
    // The user script rides a quoted heredoc so it is executed verbatim.
    expect(command).toContain("echo hi");
  });

  test("rejects invalid timeout and marker roots before building shell", () => {
    const versionId = "22222222-2222-4222-8222-222222222222";
    expect(() => rigSetupScriptCommand("echo hi", versionId, { timeoutMs: Number.NaN })).toThrow(
      "positive finite duration",
    );
    expect(() => rigSetupScriptCommand("echo hi", versionId, { markerRoot: "/" })).toThrow(
      "non-root absolute path",
    );
  });

  test.skipIf(Bun.which("timeout") === null)(
    "hard timeout kills setup and leaves the marker absent",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "opengeni-rig-timeout-"));
      try {
        const versionId = "22222222-2222-4222-8222-222222222222";
        const command = rigSetupScriptCommand("sleep 3", versionId, {
          timeoutMs: 1_000,
          markerRoot: root,
        });
        const proc = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
        const exitCode = await proc.exited;
        expect(exitCode).not.toBe(0);
        expect(existsSync(join(root, `rig-setup-${versionId}.done`))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(Bun.which("timeout") === null)(
    "concurrent first attach runs the setup body once",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "opengeni-rig-lock-"));
      try {
        const versionId = "22222222-2222-4222-8222-222222222222";
        const proof = join(root, "proof.log");
        const command = rigSetupScriptCommand(
          `printf 'setup\\n' >> ${JSON.stringify(proof)}\nsleep 1`,
          versionId,
          { timeoutMs: 10_000, markerRoot: root },
        );
        const first = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
        const second = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
        expect(await first.exited).toBe(0);
        expect(await second.exited).toBe(0);
        const proofLines = (await readFile(proof, "utf8")).trim().split("\n");
        expect(proofLines).toEqual(["setup"]);
        expect(existsSync(join(root, `rig-setup-${versionId}.done`))).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(Bun.which("timeout") === null)(
    "a waiter retries ownership after a failed owner releases the lock",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "opengeni-rig-retry-"));
      try {
        const versionId = "22222222-2222-4222-8222-222222222222";
        const marker = join(root, `rig-setup-${versionId}.done`);
        const lock = `${marker}.lock`;
        const proof = join(root, "proof.log");
        await mkdir(lock);
        const command = rigSetupScriptCommand(
          `printf 'recovered\\n' >> ${JSON.stringify(proof)}`,
          versionId,
          { timeoutMs: 10_000, markerRoot: root },
        );
        const waiter = Bun.spawn(["bash", "-lc", command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await Bun.sleep(100);
        await rm(lock, { recursive: true });

        expect(await waiter.exited).toBe(0);
        expect(await readFile(proof, "utf8")).toBe("recovered\n");
        expect(existsSync(marker)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test("fails immediately when the writable marker root cannot be created", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-rig-unwritable-"));
    try {
      const markerRoot = join(root, "not-a-directory");
      await writeFile(markerRoot, "occupied");
      const command = rigSetupScriptCommand(
        "printf should-not-run",
        "22222222-2222-4222-8222-222222222222",
        { timeoutMs: 60_000, markerRoot },
      );
      const proc = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(exitCode).toBe(73);
      expect(stderr).toContain("unable to create rig setup marker root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a trusted immutable-image marker skips without writing runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-rig-trusted-"));
    try {
      const markerRoot = join(root, "runtime");
      const trustedContentMarkerRoot = join(root, "image");
      const contentHash = `sha256:${"a".repeat(64)}`;
      await mkdir(trustedContentMarkerRoot, { recursive: true });
      await writeFile(
        join(trustedContentMarkerRoot, `rig-setup-content-${"a".repeat(64)}.done`),
        "",
      );
      const proof = join(root, "setup-ran");
      const command = rigSetupScriptCommand(
        `printf setup-ran > ${JSON.stringify(proof)}`,
        "22222222-2222-4222-8222-222222222222",
        { markerRoot, trustedContentMarkerRoot, contentHash },
      );
      const proc = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(output).toContain("__OPENGENI_RIG_SETUP_SKIPPED__");
      expect(existsSync(proof)).toBe(false);
      expect(existsSync(markerRoot)).toBe(true);
      expect(
        existsSync(join(markerRoot, "rig-setup-22222222-2222-4222-8222-222222222222.done")),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// A fake sandbox session whose exec returns a scripted result, capturing the args.
function fakeSession(result: unknown) {
  const calls: Array<Record<string, unknown>> = [];
  const session = {
    exec: async (args: Record<string, unknown>) => {
      calls.push(args);
      return result;
    },
  };
  return { session, calls };
}

describe("runRigSetupHook (M3)", () => {
  test("exact verified provider image skips without a marker command", async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const calls: Array<Record<string, unknown>> = [];
    const session = {
      state: { imageId: "im-exact-verified" },
      exec: async (args: Record<string, unknown>) => {
        calls.push(args);
        throw new Error("exact verified image must not need a marker probe");
      },
    };

    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup({
        contentHash: `sha256:${"a".repeat(64)}`,
        verifiedProviderImageId: "im-exact-verified",
      }),
      onRuntimeEvent: (event) => {
        events.push(event as any);
      },
    });

    expect(calls).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(["rig.setup.started", "rig.setup.skipped"]);
  });

  test("provider image mismatch retains the existing marker fallback", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const session = {
      state: { imageId: "im-other" },
      exec: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { status: 0, output: "__OPENGENI_RIG_SETUP_SKIPPED__\n" };
      },
    };

    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup({
        contentHash: `sha256:${"a".repeat(64)}`,
        verifiedProviderImageId: "im-exact-verified",
      }),
    });

    expect(calls).toHaveLength(1);
  });

  test("provider image identity without a content hash cannot bypass the marker", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const session = {
      state: { imageId: "im-exact-verified" },
      exec: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { status: 0, output: "__OPENGENI_RIG_SETUP_SKIPPED__\n" };
      },
    };

    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup({ verifiedProviderImageId: "im-exact-verified" }),
    });

    expect(calls).toHaveLength(1);
  });

  test("marker present → completed{skipped:true}, no throw", async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const { session } = fakeSession({ status: 0, output: "__OPENGENI_RIG_SETUP_SKIPPED__\n" });
    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup(),
      onRuntimeEvent: (event) => {
        events.push(event as any);
      },
    });
    expect(events.map((e) => e.type)).toEqual(["rig.setup.started", "rig.setup.skipped"]);
    const terminal = events.at(-1)!;
    expect(terminal.payload.rigId).toBe("11111111-1111-4111-8111-111111111111");
    expect(terminal.payload.versionId).toBe("22222222-2222-4222-8222-222222222222");
  });

  test("script ran and exited 0 → completed{skipped:false}", async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const { session } = fakeSession({ status: 0, output: "installed\n" });
    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup(),
      onRuntimeEvent: (event) => {
        events.push(event as any);
      },
    });
    expect(events.map((e) => e.type)).toEqual(["rig.setup.started", "rig.setup.completed"]);
    expect(events.at(-1)!.payload.skipped).toBe(false);
  });

  test("nonzero exit → failed event + throw naming the rig/version with output tail", async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const { session } = fakeSession({ status: 7, output: "boom: dependency missing" });
    await expect(
      runRigSetupHook(session as any, {
        environment: {},
        rigSetup: rigSetup({ rigName: "broken-rig" }),
        onRuntimeEvent: (event) => {
          events.push(event as any);
        },
      }),
    ).rejects.toThrow(/broken-rig/);
    expect(events.map((e) => e.type)).toEqual(["rig.setup.started", "rig.setup.failed"]);
    expect(events.at(-1)!.payload.error).toContain("exited with code 7");
    expect(events.at(-1)!.payload.error).toContain("boom: dependency missing");
  });

  test("still-running past the rig timeout → failed (timeout) + throw", async () => {
    const events: Array<{ type: string; payload: any }> = [];
    // The provider signals "still running" by returning a session id.
    const { session } = fakeSession({ sessionId: 42, output: "compiling…" });
    await expect(
      runRigSetupHook(session as any, {
        environment: {},
        rigSetup: rigSetup({ timeoutMs: 2_000 }),
        onRuntimeEvent: (event) => {
          events.push(event as any);
        },
      }),
    ).rejects.toThrow(/did not finish within the rig setup timeout \(2000ms\)/);
    expect(events.at(-1)!.type).toBe("rig.setup.failed");
  });

  test("coreutils timeout exit → failed (timeout) + throw", async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const { session } = fakeSession({ status: 124, output: "terminated" });
    await expect(
      runRigSetupHook(session as any, {
        environment: {},
        rigSetup: rigSetup({ timeoutMs: 2_000 }),
        onRuntimeEvent: (event) => {
          events.push(event as any);
        },
      }),
    ).rejects.toThrow(/did not finish within the rig setup timeout \(2000ms\)/);
    expect(events.at(-1)!.type).toBe("rig.setup.failed");
  });

  test("passes a yield budget above the in-box hard timeout", async () => {
    const { session, calls } = fakeSession({ status: 0, output: "" });
    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup({ timeoutMs: 2_000, contentHash: `sha256:${"a".repeat(64)}` }),
    });
    expect(calls[0]?.yieldTimeMs).toBe(9_000);
    expect(String(calls[0]?.cmd)).toContain("__OG_RIG_TIMEOUT_SECS=2");
    expect(String(calls[0]?.cmd)).toContain("/tmp/opengeni/rig-setup");
    expect(String(calls[0]?.cmd)).toContain("/var/opengeni/rig-setup-content-");
    expect(calls[0]?.workdir).toBe("/workspace");
  });

  test("stages large setup scripts in bounded chunks before execution", async () => {
    const script = `set -eu\n${"printf x >/dev/null\n".repeat(5_000)}`;
    const calls: Array<Record<string, unknown>> = [];
    const session = {
      exec: async (args: Record<string, unknown>) => {
        calls.push(args);
        return calls.length === 1 ? { status: 42, output: "" } : { status: 0, output: "" };
      },
    };

    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup({ script }),
    });

    expect(calls.length).toBeGreaterThan(4);
    expect(calls.every((call) => Buffer.byteLength(String(call.cmd), "utf8") < 32 * 1024)).toBe(
      true,
    );
    expect(
      calls
        .filter((call) => String(call.cmd).startsWith("printf '%s'"))
        .every((call) => Buffer.byteLength(String(call.cmd), "utf8") < 8 * 1024),
    ).toBe(true);
    expect(calls.some((call) => String(call.cmd).includes("base64 -d"))).toBe(true);
    expect(calls.some((call) => String(call.cmd).includes("exec bash '/tmp/opengeni/"))).toBe(true);
    expect(calls.every((call) => !String(call.cmd).includes(script))).toBe(true);
  });

  test("stages moderate scripts before wrapper expansion reaches provider ARG_MAX", async () => {
    const script = `set -eu\n${"printf x >/dev/null\n".repeat(240)}`;
    const calls: Array<Record<string, unknown>> = [];
    const session = {
      exec: async (args: Record<string, unknown>) => {
        calls.push(args);
        return calls.length === 1 ? { status: 42, output: "" } : { status: 0, output: "" };
      },
    };

    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup({ script }),
    });

    expect(Buffer.byteLength(script, "utf8")).toBeGreaterThan(4 * 1024);
    expect(calls.some((call) => String(call.cmd).includes("base64 -d"))).toBe(true);
    expect(calls.every((call) => Buffer.byteLength(String(call.cmd), "utf8") < 8 * 1024)).toBe(
      true,
    );
  });

  test("a cached large setup skips before transferring its payload", async () => {
    const script = `set -eu\n${"printf x >/dev/null\n".repeat(5_000)}`;
    const { session, calls } = fakeSession({
      status: 0,
      output: "__OPENGENI_RIG_SETUP_SKIPPED__\n",
    });

    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup({ script, contentHash: `sha256:${"a".repeat(64)}` }),
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.cmd)).not.toContain("base64");
  });

  test("chooses a heredoc delimiter that cannot terminate inside the setup script", () => {
    const first = rigSetupScriptCommand("echo first", "version-1");
    const delimiter = first.match(/<<'([^']+)'/)?.[1];
    expect(delimiter).toBeTruthy();
    const adversarial = `echo before\n${delimiter}\necho after`;
    const command = rigSetupScriptCommand(adversarial, "version-1");
    const selected = command.match(/<<'([^']+)'/)?.[1];
    expect(selected).not.toBe(delimiter);
    expect(command).toContain(adversarial);
  });

  test("no-op when no rig setup is attached", async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const { session, calls } = fakeSession({ status: 0, output: "" });
    await runRigSetupHook(session as any, {
      environment: {},
      onRuntimeEvent: (event) => {
        events.push(event as any);
      },
    });
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
