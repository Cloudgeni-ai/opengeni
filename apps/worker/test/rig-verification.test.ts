import { afterEach, describe, expect, test } from "bun:test";
import { rm, readFile, stat } from "node:fs/promises";
import type { RigVersion } from "@opengeni/contracts";
import type { EstablishedSandboxSession } from "@opengeni/runtime";
import {
  runCandidate,
  runRigVerificationScript,
  terminateThrowaway,
} from "../src/activities/rig-verification";

const cleanup: string[] = [];
const LOCAL_BASH = "/bin/bash";

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("rig verification Bash execution", () => {
  test("the local verification harness has the same absolute Bash contract as Linux sandboxes", async () => {
    expect((await stat(LOCAL_BASH)).isFile()).toBe(true);
  });

  test("preserves cd, exports, functions, set/pipefail, traps, and exit semantics in one context", async () => {
    const root = `/tmp/opengeni-rig-state-${crypto.randomUUID()}`;
    cleanup.push(root);
    const script = [
      `mkdir -p '${root}'`,
      `cd '${root}'`,
      "export RIG_STATE=preserved",
      'verify_state() { test "$RIG_STATE" = preserved && test "$PWD" = "' + root + '"; }',
      "set -euo pipefail",
      `trap 'printf trapped > "${root}/trap.txt"' EXIT`,
      "verify_state",
      "false | true",
      "exit 0",
    ].join("\n");
    const result = await runRigVerificationScript(localSession(), script, 2_000);
    expect(result.status).toBe("failed");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(`${root}/trap.txt`, "utf8")).toBe("trapped");
  });

  test("preserves an explicit artifact exit code", async () => {
    const result = await runRigVerificationScript(localSession(), "exit 23", 2_000);
    expect(result).toMatchObject({ status: "failed", exitCode: 23 });
    expect(result.timedOut).toBeUndefined();
  });

  test("hard-times out inside the Bash environment", async () => {
    const started = Date.now();
    const result = await runRigVerificationScript(localSession(), "sleep 5", 150);
    expect(result.status).toBe("failed");
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("an ambiguous launch with no exit code fails closed", async () => {
    const result = await runRigVerificationScript(
      { exec: async () => ({ output: "provider returned no process status" }) },
      "true",
      1_000,
    );
    expect(result).toMatchObject({ status: "failed", exitCode: null });
    expect(result.infrastructureError).toContain("no exit code");
  });

  test("a provider exception is a structured infrastructure failure", async () => {
    const result = await runRigVerificationScript(
      { exec: async () => Promise.reject(new Error("provider launch failed")) },
      "true",
      1_000,
    );
    expect(result).toMatchObject({ status: "failed", exitCode: null });
    expect(result.infrastructureError).toContain("provider launch failed");
    expect(result.output).toContain("provider launch failed");
  });

  test("preserves log lines while redacting and bounding provider failures", async () => {
    const secret = `ghp_${"a".repeat(30)}`;
    const oversized = `${"x".repeat(70_000)}\nprovider token=${secret}`;
    const result = await runRigVerificationScript(
      { exec: async () => Promise.reject(new Error(oversized)) },
      "true",
      1_000,
    );
    expect(result.output).toContain("\nprovider [REDACTED]");
    expect(result.output).not.toContain(secret);
    expect(result.output.length).toBeLessThanOrEqual(64 * 1024);
  });

  test("an unresponsive provider call has a real outer deadline", async () => {
    const started = Date.now();
    const result = await runRigVerificationScript(
      { exec: async () => await new Promise(() => undefined) },
      "true",
      20,
      30,
    );
    expect(result).toMatchObject({
      status: "failed",
      exitCode: null,
      timedOut: true,
    });
    expect(result.infrastructureError).toContain("did not return");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("rig verification aggregate deadline and cleanup", () => {
  test("applies the aggregate deadline as each artifact's minimum, skips expired checks, and treats deadline timeout as infrastructure failure", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let invocation = 0;
    const clock = [1_000, 2_500, 4_000, 5_000][Symbol.iterator]();
    const result = await runCandidate(
      {
        exec: async (args) => {
          calls.push(args);
          invocation += 1;
          return { exitCode: invocation === 3 ? 124 : 0, output: "" };
        },
      },
      rigVersion({
        setupScript: "setup",
        checks: [check("first"), check("deadline"), check("unstarted")],
      }),
      10_000,
      5_000,
      () => clock.next().value as number,
    );

    expect(calls.map((call) => call.yieldTimeMs)).toEqual([11_000, 9_500, 8_000]);
    expect(result.setupResult.status).toBe("passed");
    expect(result.checkResults.map((checkResult) => checkResult.status)).toEqual([
      "passed",
      "failed",
      "skipped",
    ]);
    expect(result.checkResults[1]?.timedOut).toBe(true);
    expect(result.checkResults[2]?.skippedReason).toContain("deadline");
    expect(result.infrastructureError).toContain("aggregate command deadline");
    expect(result.passed).toBe(false);
  });

  test("pre-expired aggregate deadline launches no setup or check command and skips every artifact", async () => {
    let launches = 0;
    const result = await runCandidate(
      {
        exec: async () => {
          launches += 1;
          throw new Error("must not launch after aggregate deadline");
        },
      },
      rigVersion({ setupScript: "setup", checks: [check("one"), check("two")] }),
      10_000,
      99,
      () => 100,
    );

    expect(launches).toBe(0);
    expect(result.setupResult.status).toBe("skipped");
    expect(result.checkResults.every((checkResult) => checkResult.status === "skipped")).toBe(true);
    expect(result.infrastructureError).toContain("aggregate command deadline");
    expect(result.passed).toBe(false);
  });

  test("prefers client.delete(sessionState) and does not invoke session fallback", async () => {
    const calls: string[] = [];
    await terminateThrowaway(
      establishedSandbox(
        {
          delete: async (state) => {
            calls.push(`delete:${String(state)}`);
          },
        },
        {
          terminate: async () => calls.push("terminate"),
        },
      ),
      20,
    );
    expect(calls).toEqual(["delete:state"]);
  });

  test("falls back through terminate, kill, and close until a cleanup primitive succeeds", async () => {
    const calls: string[] = [];
    await terminateThrowaway(
      establishedSandbox(
        {
          delete: async () => {
            calls.push("delete");
            throw new Error("delete unavailable");
          },
        },
        {
          terminate: async () => {
            calls.push("terminate");
            throw new Error("terminate unavailable");
          },
          kill: async () => calls.push("kill"),
          close: async () => calls.push("close"),
        },
      ),
      20,
    );
    expect(calls).toEqual(["delete", "terminate", "kill"]);
  });

  test("bounds all cleanup attempts and reports an actionable redacted error when all fail", async () => {
    const secret = `ghp_${"a".repeat(30)}`;
    const hangs = async () => await new Promise<void>(() => undefined);
    await expect(
      terminateThrowaway(
        establishedSandbox(
          { delete: hangs },
          {
            terminate: hangs,
            kill: async () => {
              throw new Error(`provider token=${secret}`);
            },
            close: async () => {
              throw new Error(`provider token=${secret}`);
            },
          },
        ),
        10,
      ),
    ).rejects.toThrow(/cleanup failed.*timed out.*\[REDACTED\]/i);
  });

  test("fails clearly when no cleanup primitive is available", async () => {
    await expect(terminateThrowaway(establishedSandbox({}, {}), 10)).rejects.toThrow(
      "no client.delete(sessionState)",
    );
  });
});

function check(name: string) {
  return { name, command: `check-${name}` };
}

function rigVersion(overrides: Partial<RigVersion> = {}): RigVersion {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    rigId: "00000000-0000-0000-0000-000000000002",
    version: 1,
    image: null,
    setupScript: null,
    checks: [],
    credentialHooks: [],
    defaultVariableSetIds: [],
    active: true,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  } as RigVersion;
}

function establishedSandbox(client: unknown, session: unknown): EstablishedSandboxSession {
  return {
    client,
    session,
    sessionState: "state",
    instanceId: "verification-test",
    backendId: "test",
  };
}

function localSession() {
  return {
    exec: async (args: Record<string, unknown>) => {
      const process = Bun.spawn([LOCAL_BASH, "-lc", String(args.cmd)], {
        cwd: String(args.workdir ?? "/workspace"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      return { exitCode, output: [stdout, stderr].filter(Boolean).join("\n") };
    },
  };
}
