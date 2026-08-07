// P4.1 — ensureDisplayStack unit (the command sequence + flock-idempotency),
// driven through a FAKE exec-capable session (no live box). The live-box proof
// (Modal/gVisor: xdpyinfo OK, :5900/:6080 listening, XTEST read-back, scrot) is
// the gated apps/worker integration test; here we pin the contract:
//
//   (1) ensureDisplayStack execs the canonical up-script under an in-box flock,
//       with the geometry/port env, and parses OPENGENI_DESKTOP_UP as success.
//   (2) the script the unit builds is exactly what a real box runs (buildDisplayStackScript).
//   (3) FLOCK-IDEMPOTENCY: a second call against an already-up box is a no-op —
//       the fake (modeling the in-box flock + PID guards) returns the same marker
//       and launches NOTHING new; we assert exactly-one-launch + N-safe re-call.
//   (4) a stage failure (exit 11/12/13, or the stderr marker via execCommand)
//       throws a typed DisplayStackError naming the stage.
//   (5) a session that cannot run commands throws DisplayStackUnsupportedError.
//   (6) execCommand-only sessions (no structured exitCode) infer success from
//       the marker line.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DESKTOP_GEOMETRY,
  DisplayStackError,
  DisplayStackUnsupportedError,
  STREAM_PORT,
  buildDisplayStackScript,
  ensureDisplayStack,
} from "../src/sandbox";

// A fake box that models the in-box flock + the up-script's PID guards: the
// FIRST `opengeni-desktop-up` "launches" the stack (records launches), every
// subsequent call observes it already up and is a NO-OP that re-prints the same
// marker (exactly what flock + alive-guards yield on a real box).
function makeFakeBox(opts: { mode?: "exec" | "execCommand"; failStage?: 11 | 12 | 13 | 14 } = {}) {
  const calls: string[] = [];
  let launches = 0;
  let up = false;

  const runUp = (): { exitCode: number; output: string } => {
    if (opts.failStage === 14) {
      // The PAINTABLE-FRAME gate: bring-up SUCCEEDED (marker printed) but scrot never
      // produced a non-empty frame, so both markers are present and the script exits 14.
      const marker = `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`;
      return {
        exitCode: 14,
        output: `${marker}\nOPENGENI_DESKTOP_NOT_PAINTING scrot empty after warmup`,
      };
    }
    if (opts.failStage) {
      const msg =
        opts.failStage === 11
          ? "Xvfb failed to come up"
          : opts.failStage === 12
            ? "x11vnc failed on :5900"
            : "websockify failed on 6080";
      return { exitCode: opts.failStage, output: msg };
    }
    if (!up) {
      launches += 1; // the real first-launch path (Xvfb..websockify spawned)
      up = true;
    }
    // marker is printed on every successful invocation (idempotent re-run too).
    return {
      exitCode: 0,
      output: `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
    };
  };

  const session: Record<string, unknown> = {};
  if ((opts.mode ?? "exec") === "exec") {
    session.exec = async ({ cmd }: { cmd: string }) => {
      calls.push(cmd);
      const r = runUp();
      return {
        output: r.output,
        stdout: r.output,
        stderr: "",
        exitCode: r.exitCode,
        wallTimeSeconds: 0.1,
      };
    };
  } else {
    session.execCommand = async ({ cmd }: { cmd: string }) => {
      calls.push(cmd);
      return runUp().output; // bare string — no exit code; success inferred from marker
    };
  }

  return {
    session,
    calls,
    get launches() {
      return launches;
    },
  };
}

describe("P4.1 ensureDisplayStack — command sequence + flock-idempotency (fake box)", () => {
  test("(1) execs the flock-wrapped up-script with geometry/port env and parses success", async () => {
    const box = makeFakeBox();
    const result = await ensureDisplayStack(box.session);

    expect(result.port).toBe(STREAM_PORT);
    expect(result.geometry).toEqual(DEFAULT_DESKTOP_GEOMETRY);
    expect(result.marker).toContain("OPENGENI_DESKTOP_UP");
    expect(box.calls).toHaveLength(1);

    const cmd = box.calls[0]!;
    // flock-wrapped (the idempotency mechanism), runs the canonical script.
    expect(cmd).toContain("flock");
    // The supervisor retains the lock while the launcher runs, but --close keeps
    // detached display processes from inheriting it permanently.
    expect(cmd).toContain("flock --close");
    expect(cmd).not.toContain("exec 8>");
    expect(cmd).toContain("opengeni-desktop-up");
    // the geometry + port env the script reads.
    expect(cmd).toContain(`DESKTOP_W=${DEFAULT_DESKTOP_GEOMETRY.width}`);
    expect(cmd).toContain(`DESKTOP_H=${DEFAULT_DESKTOP_GEOMETRY.height}`);
    expect(cmd).toContain(`DESKTOP_DPI=${DEFAULT_DESKTOP_GEOMETRY.dpi}`);
    expect(cmd).toContain(`STREAM_PORT=${STREAM_PORT}`);
  });

  test("(2) buildDisplayStackScript is the exact command a real box runs (custom geometry/port)", () => {
    const cmd = buildDisplayStackScript({
      geometry: { width: 1920, height: 1080, dpi: 120 },
      port: 7090,
    });
    expect(cmd).toContain("flock");
    expect(cmd).toContain("opengeni-desktop-up");
    expect(cmd).toContain("DESKTOP_W=1920 DESKTOP_H=1080 DESKTOP_DPI=120 STREAM_PORT=7090");
  });

  test("(2a) PAINTABLE-FRAME GATE: the script scrot-probes for a PAINTED (size-floor) frame and exits 14 when it never paints", () => {
    const cmd = buildDisplayStackScript({ port: 6080 });
    // The completion criterion is a REAL PAINTED scrot (not just ports listening, and not
    // merely NON-EMPTY). It must appear AFTER the bring-up (the up-script/precheck), chained
    // with && so a failed bring-up short-circuits it, and it must exit 14 (the "paint" stage)
    // on failure. The gate is a byte-size FLOOR (`wc -c` >= threshold), NOT the old `[ -s ]`
    // non-emptiness check — an unpainted root is small-but-non-empty and would falsely pass.
    const scrotIdx = cmd.indexOf("scrot -o");
    const upIdx = cmd.indexOf("opengeni-desktop-up");
    expect(scrotIdx).toBeGreaterThan(upIdx);
    // byte-size floor, not non-emptiness:
    expect(cmd).toContain("wc -c < ");
    expect(cmd).toContain("-ge 60000");
    expect(cmd).not.toContain("[ -s ");
    // SETTLE: must also require two consecutive above-floor probes that agree within the
    // settle delta (the gVisor staged-paint fix), not merely a single floor crossing.
    expect(cmd).toContain("prev=0");
    expect(cmd).toContain('"$prev" -ge 60000');
    expect(cmd).toContain("-le 2000");
    expect(cmd).toContain("exit 14");
    expect(cmd).toContain("OPENGENI_DESKTOP_NOT_PAINTING");
    // chained so a failed bring-up never reaches the paint probe.
    expect(cmd).toContain("&& {");
  });

  test("(2b) FAST PRE-CHECK: buildDisplayStackScript probes the exposed + VNC ports BEFORE the flock", () => {
    const cmd = buildDisplayStackScript({ port: 6080 });
    // The lock-free port probe (nc -z to the exposed port AND x11vnc:5900) must
    // appear, and it must appear BEFORE the flock so an already-up no-op caller
    // never serializes behind a lock holder (the regression: a turn re-ensuring
    // after a viewer attach timing out on flock -w 45).
    const precheckIdx = cmd.indexOf("nc -z 127.0.0.1 6080");
    const vncProbeIdx = cmd.indexOf("nc -z 127.0.0.1 5900");
    const flockIdx = cmd.indexOf("flock");
    expect(precheckIdx).toBeGreaterThanOrEqual(0);
    expect(vncProbeIdx).toBeGreaterThanOrEqual(0);
    expect(flockIdx).toBeGreaterThan(precheckIdx);
    // On a pre-check hit the script echoes the marker and skips the up-script.
    expect(cmd).toContain("OPENGENI_DESKTOP_UP");
  });

  test("(2c) FAST PRE-CHECK: an already-up stack returns the marker FAST — no flock wait, no relaunch", async () => {
    // Model the real box's lock-free pre-check: ports already listening -> the
    // command returns the `(precheck)` marker IMMEDIATELY without ever taking the
    // outer flock (so no `flock -w 45` timeout, no up-script relaunch). This is
    // the contended-but-already-up case the regression timed out on.
    const calls: string[] = [];
    const session = {
      exec: async ({ cmd, yieldTimeMs }: { cmd: string; yieldTimeMs?: number }) => {
        calls.push(cmd);
        // The pre-check resolves in milliseconds — assert we did NOT block for the
        // ~45-60s timeout the caller would allow on the flock path.
        expect(yieldTimeMs ?? 0).toBeGreaterThanOrEqual(0);
        return {
          output: "OPENGENI_DESKTOP_UP port=6080 geometry=1280x800 dpi=96 (precheck)",
          stdout: "OPENGENI_DESKTOP_UP port=6080 geometry=1280x800 dpi=96 (precheck)",
          stderr: "",
          exitCode: 0,
          wallTimeSeconds: 0.001,
        };
      },
    };
    const started = Date.now();
    const result = await ensureDisplayStack(session);
    const elapsed = Date.now() - started;

    expect(result.marker).toContain("OPENGENI_DESKTOP_UP");
    expect(result.marker).toContain("(precheck)");
    expect(calls).toHaveLength(1); // single probe; nothing relaunched
    expect(elapsed).toBeLessThan(1_000); // fast — nowhere near the 45s flock timeout
  });

  test("(3) FLOCK-IDEMPOTENCY: a second call against an already-up box launches NOTHING new (no-op)", async () => {
    const box = makeFakeBox();
    const first = await ensureDisplayStack(box.session);
    const second = await ensureDisplayStack(box.session);

    // Both calls return the same up marker...
    expect(first.marker).toContain("OPENGENI_DESKTOP_UP");
    expect(second.marker).toContain("OPENGENI_DESKTOP_UP");
    // ...but the stack was LAUNCHED exactly once (the second is the flock/PID
    // guarded no-op the real box performs). Two exec calls, one real launch.
    expect(box.calls).toHaveLength(2);
    expect(box.launches).toBe(1);
  });

  test("(3b) two concurrent cold callers serialize to exactly one launch", async () => {
    let launches = 0;
    let launch: Promise<void> | undefined;
    let up = false;
    let activeProviderCalls = 0;
    let maxActiveProviderCalls = 0;
    const session = {
      exec: async () => {
        activeProviderCalls += 1;
        maxActiveProviderCalls = Math.max(maxActiveProviderCalls, activeProviderCalls);
        try {
          if (!up) {
            if (!launch) {
              launches += 1;
              launch = Bun.sleep(25).then(() => {
                up = true;
              });
            }
            await launch;
          }
          return {
            output: `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
            exitCode: 0,
          };
        } finally {
          activeProviderCalls -= 1;
        }
      },
    };

    const [viewer, computer] = await Promise.all([
      ensureDisplayStack(session),
      ensureDisplayStack(session),
    ]);

    expect(viewer.marker).toContain("OPENGENI_DESKTOP_UP");
    expect(computer.marker).toContain("OPENGENI_DESKTOP_UP");
    expect(launches).toBe(1);
    expect(maxActiveProviderCalls).toBe(1);
  });

  test("(3c) a timed-out owner fences a same-sandbox sibling before cleanup permits retry", async () => {
    const events: string[] = [];
    let resolveA!: (result: { output: string; exitCode: number }) => void;
    let workCalls = 0;
    let allowRetry = false;
    let notifyWorkA!: () => void;
    const workAStarted = new Promise<void>((resolve) => {
      notifyWorkA = resolve;
    });
    const session = {
      state: { sandboxId: "same-sandbox-concurrent-fence-regression" },
      exec: async ({ cmd, signal }: { cmd: string; signal?: AbortSignal }) => {
        if (cmd.includes("OPENGENI_DISPLAY_CLEANUP")) {
          events.push("cleanup-complete");
          return { output: "OPENGENI_DISPLAY_CLEANUP status=stopped", exitCode: 0 };
        }
        workCalls += 1;
        if (workCalls === 1) {
          events.push("work-A");
          notifyWorkA();
          signal?.addEventListener("abort", () => events.push("abort-A"), { once: true });
          return await new Promise<{ output: string; exitCode: number }>((resolve) => {
            resolveA = resolve;
          });
        }
        if (!allowRetry) {
          events.push("stale-work");
          throw new Error("stale sibling issued provider work");
        }
        events.push("work-C");
        return {
          output: `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
          exitCode: 0,
        };
      },
    };

    const operationA = ensureDisplayStack(session, { timeoutMs: 30 });
    await workAStarted;
    // B has begun before A times out, but per-sandbox admission keeps it out of
    // the provider until A either succeeds or invalidates its generation.
    const operationB = ensureDisplayStack(session, { timeoutMs: 500 });
    void operationB.catch(() => undefined);
    await Promise.resolve();
    expect(workCalls).toBe(1);

    await expect(operationA).rejects.toMatchObject({ stage: "timeout" });
    expect(events).toContain("cleanup-complete");
    allowRetry = true;
    const operationC = ensureDisplayStack(session, { timeoutMs: 500 });
    await expect(operationC).resolves.toMatchObject({ port: STREAM_PORT });
    await expect(operationB).rejects.toMatchObject({ stage: "timeout" });

    expect(events).not.toContain("stale-work");
    expect(events.indexOf("work-C")).toBeGreaterThan(events.indexOf("cleanup-complete"));
    resolveA({ output: "late stale result", exitCode: 0 });
  });

  test("(3d) different physical sandboxes retain independent display admission", async () => {
    let activeProviderCalls = 0;
    let maxActiveProviderCalls = 0;
    const makeSession = (sandboxId: string) => ({
      state: { sandboxId },
      exec: async () => {
        activeProviderCalls += 1;
        maxActiveProviderCalls = Math.max(maxActiveProviderCalls, activeProviderCalls);
        try {
          await Bun.sleep(25);
          return {
            output: `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
            exitCode: 0,
          };
        } finally {
          activeProviderCalls -= 1;
        }
      },
    });

    await Promise.all([
      ensureDisplayStack(makeSession("independent-display-box-a")),
      ensureDisplayStack(makeSession("independent-display-box-b")),
    ]);

    expect(maxActiveProviderCalls).toBe(2);
  });

  test("(4a) a stage failure (exit 12) throws a typed DisplayStackError naming the stage", async () => {
    const box = makeFakeBox({ failStage: 12 });
    let thrown: unknown;
    try {
      await ensureDisplayStack(box.session);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DisplayStackError);
    expect((thrown as DisplayStackError).exitCode).toBe(12);
    expect((thrown as DisplayStackError).stage).toBe("x11vnc");
  });

  test("(4b) Xvfb stage failure (exit 11) maps to stage 'xvfb'", async () => {
    const box = makeFakeBox({ failStage: 11 });
    await expect(ensureDisplayStack(box.session)).rejects.toThrow(DisplayStackError);
    try {
      await ensureDisplayStack(box.session);
    } catch (e) {
      expect((e as DisplayStackError).stage).toBe("xvfb");
    }
  });

  test("(4c) PAINTABLE-FRAME failure (exit 14) throws DisplayStackError stage 'paint' — exec path", async () => {
    const box = makeFakeBox({ failStage: 14 });
    let thrown: unknown;
    try {
      await ensureDisplayStack(box.session);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DisplayStackError);
    expect((thrown as DisplayStackError).exitCode).toBe(14);
    expect((thrown as DisplayStackError).stage).toBe("paint");
  });

  test("(4d) PAINTABLE-FRAME failure via execCommand: NOT_PAINTING wins even though UP is also present", async () => {
    // Modal is execCommand-only (no structured exitCode), so success/failure is
    // string-inferred. On the paint-fail path the up-script ALREADY printed the UP
    // marker, so both markers are present — NOT_PAINTING must be authoritative.
    const box = makeFakeBox({ mode: "execCommand", failStage: 14 });
    let thrown: unknown;
    try {
      await ensureDisplayStack(box.session);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DisplayStackError);
    expect((thrown as DisplayStackError).stage).toBe("paint");
  });

  test("(5) a session that cannot run commands throws DisplayStackUnsupportedError", async () => {
    await expect(ensureDisplayStack({})).rejects.toThrow(DisplayStackUnsupportedError);
  });

  test("(6) execCommand-only session infers success from the OPENGENI_DESKTOP_UP marker", async () => {
    const box = makeFakeBox({ mode: "execCommand" });
    const result = await ensureDisplayStack(box.session);
    expect(result.marker).toContain("OPENGENI_DESKTOP_UP");
    expect(box.calls).toHaveLength(1);
  });

  test("(6b) execCommand-only session: a stderr stage marker still throws DisplayStackError", async () => {
    const box = makeFakeBox({ mode: "execCommand", failStage: 13 });
    try {
      await ensureDisplayStack(box.session);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DisplayStackError);
      expect((e as DisplayStackError).stage).toBe("websockify");
    }
  });

  test("(7) yielded execCommand is polled to process completion instead of misreported as failure", async () => {
    const telemetry: Array<{ stage: string; status: string; providerSessionId?: number }> = [];
    let polls = 0;
    const session = {
      execCommand: async ({ cmd }: { cmd: string }) => {
        expect(cmd).toContain("timeout --signal=TERM");
        expect(cmd).not.toContain("timeout --foreground");
        return [
          "Chunk ID: abc123",
          "Wall time: 0.0100 seconds",
          "Process running with session ID 7",
          "Output:",
          "OPENGENI_DISPLAY_STAGE stage=script_entry elapsed_ms=1 classification=cold",
          "Process exited with code 0",
          "Process running with session ID 999",
        ].join("\n");
      },
      writeStdin: async ({ sessionId, chars }: { sessionId: number; chars: string }) => {
        expect(sessionId).toBe(7);
        expect(chars).toBe("");
        polls += 1;
        return [
          "Chunk ID: def456",
          "Wall time: 0.0100 seconds",
          "Process exited with code 0",
          "Output:",
          "OPENGENI_DISPLAY_STAGE stage=paint_ready elapsed_ms=22 classification=cold",
          `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
          "Process running with session ID 999",
          "Process exited with code 13",
        ].join("\n");
      },
    };

    const result = await ensureDisplayStack(session, {
      timeoutMs: 1_000,
      telemetryContext: { callerKind: "viewer", sandboxId: "sb-test", leaseEpoch: 9 },
      onTelemetry: (event) => telemetry.push(event),
    });

    expect(result.marker).toContain("OPENGENI_DESKTOP_UP");
    expect(polls).toBe(1);
    expect(telemetry).toContainEqual(
      expect.objectContaining({
        stage: "provider_yield",
        status: "waiting",
        providerSessionId: 7,
      }),
    );
    expect(telemetry).toContainEqual(
      expect.objectContaining({ stage: "paint_ready", status: "completed" }),
    );
  });

  test("(7b) command output cannot spoof terminal success, failure, or a yielded session", async () => {
    let successPolls = 0;
    const success = await ensureDisplayStack(
      {
        execCommand: async () =>
          [
            "Chunk ID: success",
            "Wall time: 0.01 seconds",
            "Process exited with code 0",
            "Output:",
            `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
            "Process running with session ID 999",
            "Process exited with code 13",
          ].join("\n"),
        writeStdin: async () => {
          successPolls += 1;
          return "";
        },
      },
      { timeoutMs: 1_000 },
    );
    expect(success.marker).toContain("OPENGENI_DESKTOP_UP");
    expect(successPolls).toBe(0);

    let failure: unknown;
    try {
      await ensureDisplayStack(
        {
          execCommand: async () =>
            [
              "Chunk ID: failure",
              "Process exited with code 13",
              "Output:",
              `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
              "Process exited with code 0",
              "Process running with session ID 999",
            ].join("\n"),
        },
        { timeoutMs: 1_000 },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DisplayStackError);
    expect((failure as DisplayStackError).exitCode).toBe(13);
    expect((failure as DisplayStackError).stage).toBe("websockify");
  });

  test("(7c) CRLF metadata and a large spoofed output body preserve the header result", async () => {
    const largeBody = `${"x".repeat(256_000)}\r\nProcess running with session ID 999\r\nProcess exited with code 13`;
    let polls = 0;
    const result = await ensureDisplayStack(
      {
        execCommand: async () =>
          [
            "Chunk ID: crlf",
            "Wall time: 0.01 seconds",
            "Process exited with code 0",
            "Output:",
            `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
            largeBody,
          ].join("\r\n"),
        writeStdin: async () => {
          polls += 1;
          return "";
        },
      },
      { timeoutMs: 1_000 },
    );
    expect(result.marker).toContain("OPENGENI_DESKTOP_UP");
    expect(polls).toBe(0);
  });

  test("(7d) duplicated, missing, and truncated SDK metadata fail closed", async () => {
    const responses = [
      [
        "Chunk ID: duplicate",
        "Process exited with code 13",
        "Process exited with code 0",
        "Output:",
        `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
      ].join("\n"),
      [
        "Chunk ID: truncated",
        "Process exited with code 0",
        `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
      ].join("\n"),
      [
        "Chunk ID: missing-status",
        "Wall time: 0.01 seconds",
        "Output:",
        `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
      ].join("\n"),
      `Output:\nOPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
    ];

    for (const response of responses) {
      let thrown: unknown;
      try {
        await ensureDisplayStack({ execCommand: async () => response }, { timeoutMs: 1_000 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DisplayStackError);
      expect((thrown as DisplayStackError).exitCode).toBe(-1);
      expect((thrown as DisplayStackError).stage).toBe("unknown");
    }
  });

  test("(8) provider wait has a real wall deadline and the in-box owner is independently bounded", async () => {
    const commands: string[] = [];
    const session = {
      execCommand: async ({ cmd }: { cmd: string }) => {
        commands.push(cmd);
        return [
          "Chunk ID: abc123",
          "Wall time: 0.0100 seconds",
          "Process running with session ID 11",
          "Output:",
          "",
        ].join("\n");
      },
      writeStdin: async () => await new Promise<string>(() => undefined),
    };

    const started = Date.now();
    let thrown: unknown;
    try {
      await ensureDisplayStack(session, { timeoutMs: 120, onTelemetry: () => undefined });
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - started;

    expect(thrown).toBeInstanceOf(DisplayStackError);
    expect((thrown as DisplayStackError).stage).toBe("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(500);
    expect(commands[0]).toContain("timeout --signal=TERM");
    expect(commands[0]).not.toContain("timeout --foreground");
    expect(commands[0]).toContain("OPENGENI_DISPLAY_TIMEOUT");
  });

  test("(8a) a timed-out provider call is fenced before a retry can issue work", async () => {
    let resolveFirst!: (result: { output: string; exitCode: number }) => void;
    let workCalls = 0;
    const events: string[] = [];
    const session = {
      exec: async ({ cmd, signal }: { cmd: string; signal?: AbortSignal }) => {
        if (cmd.includes("OPENGENI_DISPLAY_CLEANUP")) {
          events.push("cleanup-issued");
          return { output: "OPENGENI_DISPLAY_CLEANUP status=stopped", exitCode: 0 };
        }
        workCalls += 1;
        if (workCalls === 1) {
          signal?.addEventListener("abort", () => events.push("provider-aborted"), {
            once: true,
          });
          return await new Promise<{ output: string; exitCode: number }>((resolve) => {
            resolveFirst = resolve;
          });
        }
        events.push("retry-issued");
        return {
          output: `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
          exitCode: 0,
        };
      },
    };

    await expect(
      ensureDisplayStack(session, {
        timeoutMs: 30,
        onTelemetry: (event) => events.push(event.stage),
      }),
    ).rejects.toMatchObject({ stage: "timeout" });
    expect(events).toContain("provider-aborted");

    const retry = ensureDisplayStack(session, { timeoutMs: 500 });
    await Bun.sleep(20);
    expect(workCalls).toBe(2);
    expect(events.indexOf("retry-issued")).toBeGreaterThan(events.indexOf("cleanup-issued"));

    resolveFirst({ output: "late stale result", exitCode: 0 });
    await retry;
    expect(workCalls).toBe(2);
    expect(events.indexOf("retry-issued")).toBeGreaterThan(events.indexOf("provider-aborted"));
  });

  test("(8a2) a fresh wrapper shares the physical fence and requires cleanup before retry", async () => {
    const events: string[] = [];
    let oldProcessAlive = true;

    const makeSession = (wrapper: string) => ({
      // This is the provider state identity, not the transient wrapper object.
      state: { sandboxId: "stable-display-regression-box" },
      exec: async ({ cmd, signal }: { cmd: string; signal?: AbortSignal }) => {
        if (cmd.includes("OPENGENI_DISPLAY_CLEANUP")) {
          oldProcessAlive = false;
          events.push(`${wrapper}:cleanup`);
          return { output: "OPENGENI_DISPLAY_CLEANUP status=stopped", exitCode: 0 };
        }
        events.push(`${wrapper}:work`);
        if (wrapper === "first") {
          signal?.addEventListener("abort", () => events.push("first:aborted"), { once: true });
          return await new Promise<{ output: string; exitCode: number }>(() => undefined);
        }
        // The second wrapper is only safe to use after the first process-group
        // cleanup has positively completed.
        expect(oldProcessAlive).toBe(false);
        return {
          output: `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96`,
          exitCode: 0,
        };
      },
    });

    await expect(ensureDisplayStack(makeSession("first"), { timeoutMs: 30 })).rejects.toMatchObject(
      { stage: "timeout" },
    );
    expect(events).toContain("first:cleanup");

    await ensureDisplayStack(makeSession("second"), { timeoutMs: 500 });
    expect(events.indexOf("second:work")).toBeGreaterThan(events.indexOf("first:cleanup"));
  });

  test("(8b) a wall-clock jump cannot extend the monotonic provider deadline", async () => {
    const originalDateNow = Date.now;
    const session = {
      exec: async () => await new Promise<never>(() => undefined),
    };
    Date.now = () => originalDateNow() + 86_400_000;
    const started = performance.now();
    try {
      await expect(ensureDisplayStack(session, { timeoutMs: 60 })).rejects.toMatchObject({
        stage: "timeout",
      });
    } finally {
      Date.now = originalDateNow;
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  // oxfmt-ignore
  test.skipIf(process.platform !== "linux" || Bun.which("flock") === null)("(8c) the in-box deadline kills a waiting flock tree before it can launch later", async () => {
    const root = await mkdtemp(join(tmpdir(), "display-stack-timeout-"));
    const bin = join(root, "bin");
    const lock = join(root, "outer.lock");
    const launches = join(root, "launches");
    const realFlock = Bun.which("flock");
    expect(realFlock).not.toBeNull();
    await Bun.$`mkdir -p ${bin}`;
    await Promise.all([
      writeFile(join(bin, "nc"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 }),
      writeFile(
        join(bin, "flock"),
        `#!/usr/bin/env bash\nargs=()\nfor arg in "$@"; do\n  if [ "$arg" = /tmp/opengeni-desktop/up.outer.lock ]; then arg="$DISPLAY_STACK_TEST_LOCK"; fi\n  args+=("$arg")\ndone\nexec "${realFlock}" "\${args[@]}"\n`,
        { mode: 0o755 },
      ),
      writeFile(
        join(bin, "opengeni-desktop-up"),
        '#!/usr/bin/env bash\necho launched >>"$DISPLAY_STACK_TEST_LAUNCHES"\nsleep 5\n',
        { mode: 0o755 },
      ),
      writeFile(join(bin, "scrot"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 }),
    ]);
    const holder = Bun.spawn([realFlock!, lock, "-c", "sleep 0.6"]);

    try {
      await Bun.sleep(50);
      const session = {
        exec: async ({ cmd }: { cmd: string }) => {
          const child = Bun.spawn(["bash", "-c", cmd], {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              DISPLAY_STACK_TEST_LOCK: lock,
              DISPLAY_STACK_TEST_LAUNCHES: launches,
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return { output: `${stdout}\n${stderr}`, exitCode };
        },
      };

      let thrown: unknown;
      try {
        await ensureDisplayStack(session, { port: 16_082, timeoutMs: 250 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DisplayStackError);
      expect((thrown as DisplayStackError).stage).toBe("timeout");

      await holder.exited;
      await Bun.sleep(300);
      const probe = Bun.spawn([realFlock!, "-n", lock, "-c", "true"]);
      expect(await probe.exited).toBe(0);
      expect(await Bun.file(launches).exists()).toBe(false);
    } finally {
      holder.kill();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("(8d) exit 137 is unknown without positive timeout evidence", async () => {
    const session = {
      exec: async () => ({ output: "provider terminated the process", exitCode: 137 }),
    };

    let thrown: unknown;
    try {
      await ensureDisplayStack(session, { timeoutMs: 2_000 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DisplayStackError);
    expect((thrown as DisplayStackError).exitCode).toBe(137);
    expect((thrown as DisplayStackError).stage).toBe("unknown");
  });

  test("(8e) a kill-after escalation retains typed timeout attribution", async () => {
    const session = {
      exec: async () => ({
        output: "OPENGENI_DISPLAY_TIMEOUT elapsed_ms=1000",
        exitCode: 137,
      }),
    };

    let thrown: unknown;
    try {
      await ensureDisplayStack(session, { timeoutMs: 2_000 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DisplayStackError);
    expect((thrown as DisplayStackError).exitCode).toBe(137);
    expect((thrown as DisplayStackError).stage).toBe("timeout");
  });

  test("(9) the canonical launcher supervises its inner lock without inherited FDs", async () => {
    const launcher = await Bun.file(
      new URL("../../../docker/desktop/opengeni-desktop-up.sh", import.meta.url),
    ).text();
    expect(launcher).toContain('exec flock --close "$RUN/up.lock"');
    expect(launcher).not.toContain('exec 9>"$RUN/up.lock"');
  });
});
