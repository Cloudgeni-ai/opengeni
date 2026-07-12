import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    const command = rigSetupScriptCommand(
      "echo hi",
      "22222222-2222-4222-8222-222222222222",
      600_000,
    );
    expect(command).toContain(
      '__OG_RIG_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/opengeni-rig-setup-$(id -u)"',
    );
    expect(command).toContain(
      `__OG_RIG_MARKER="$__OG_RIG_ROOT"/'rig-setup-22222222-2222-4222-8222-222222222222.done'`,
    );
    expect(command).toContain('case "$__OG_RIG_ROOT" in /*)');
    expect(command).toContain('if [ ! -d "$__OG_RIG_ROOT" ] || [ ! -w "$__OG_RIG_ROOT" ]');
    // Skip path prints the sentinel and exits 0 without running the script.
    expect(command).toContain("__OPENGENI_RIG_SETUP_SKIPPED__");
    // The script is hard-killed by coreutils timeout (NOT bash -e), and the
    // marker is touched only on rc 0.
    expect(command).toContain('timeout -k 5s "${__OG_RIG_TIMEOUT_SECS}s" bash "$__OG_RIG_SCRIPT"');
    expect(command).toContain('if [ "$__OG_RIG_RC" -eq 0 ]; then touch "$__OG_RIG_MARKER"; fi');
    // First attach is atomically claimed with a mkdir lockdir.
    expect(command).toContain('if mkdir "$__OG_RIG_LOCK" 2>/dev/null; then');
    // The user script rides a quoted heredoc so it is executed verbatim.
    expect(command).toContain("echo hi");
  });

  test("the default marker root uses the caller-owned runtime directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-rig-unprivileged-"));
    try {
      const versionId = "22222222-2222-4222-8222-222222222222";
      const proc = Bun.spawn(
        ["bash", "-lc", rigSetupScriptCommand("printf ok", versionId, 10_000)],
        {
          env: { ...process.env, XDG_RUNTIME_DIR: root, TMPDIR: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await proc.exited).toBe(0);
      expect(
        existsSync(
          join(
            root,
            `opengeni-rig-setup-${process.getuid?.() ?? 0}`,
            `rig-setup-${versionId}.done`,
          ),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hard timeout kills setup and leaves the marker absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-rig-timeout-"));
    try {
      const versionId = "22222222-2222-4222-8222-222222222222";
      const command = rigSetupScriptCommand("sleep 3", versionId, 1_000, root);
      const proc = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
      expect(existsSync(join(root, `rig-setup-${versionId}.done`))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("concurrent first attach runs the setup body once", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-rig-lock-"));
    try {
      const versionId = "22222222-2222-4222-8222-222222222222";
      const proof = join(root, "proof.log");
      const command = rigSetupScriptCommand(
        `printf 'setup\\n' >> ${JSON.stringify(proof)}\nsleep 1`,
        versionId,
        10_000,
        root,
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
  }, 15_000);
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

  test("passes a yield budget above the in-box hard timeout", async () => {
    const { session, calls } = fakeSession({ status: 0, output: "" });
    await runRigSetupHook(session as any, {
      environment: {},
      rigSetup: rigSetup({ timeoutMs: 2_000 }),
    });
    expect(calls[0]?.yieldTimeMs).toBe(9_000);
    expect(String(calls[0]?.cmd)).toContain("__OG_RIG_TIMEOUT_SECS=2");
    expect(calls[0]?.workdir).toBe("/workspace");
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
