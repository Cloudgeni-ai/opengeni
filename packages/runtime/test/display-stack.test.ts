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
      return { exitCode: 14, output: `${marker}\nOPENGENI_DESKTOP_NOT_PAINTING scrot empty after warmup` };
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
    return { exitCode: 0, output: `OPENGENI_DESKTOP_UP port=${STREAM_PORT} geometry=1280x800 dpi=96` };
  };

  const session: Record<string, unknown> = {};
  if ((opts.mode ?? "exec") === "exec") {
    session.exec = async ({ cmd }: { cmd: string }) => {
      calls.push(cmd);
      const r = runUp();
      return { output: r.output, stdout: r.output, stderr: "", exitCode: r.exitCode, wallTimeSeconds: 0.1 };
    };
  } else {
    session.execCommand = async ({ cmd }: { cmd: string }) => {
      calls.push(cmd);
      return runUp().output; // bare string — no exit code; success inferred from marker
    };
  }

  return { session, calls, get launches() { return launches; } };
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
    expect(cmd).toContain("opengeni-desktop-up");
    // the geometry + port env the script reads.
    expect(cmd).toContain(`DESKTOP_W=${DEFAULT_DESKTOP_GEOMETRY.width}`);
    expect(cmd).toContain(`DESKTOP_H=${DEFAULT_DESKTOP_GEOMETRY.height}`);
    expect(cmd).toContain(`DESKTOP_DPI=${DEFAULT_DESKTOP_GEOMETRY.dpi}`);
    expect(cmd).toContain(`STREAM_PORT=${STREAM_PORT}`);
  });

  test("(2) buildDisplayStackScript is the exact command a real box runs (custom geometry/port)", () => {
    const cmd = buildDisplayStackScript({ geometry: { width: 1920, height: 1080, dpi: 120 }, port: 7090 });
    expect(cmd).toContain("flock");
    expect(cmd).toContain("opengeni-desktop-up");
    expect(cmd).toContain("DESKTOP_W=1920 DESKTOP_H=1080 DESKTOP_DPI=120 STREAM_PORT=7090");
  });

  test("(2a) PAINTABLE-FRAME GATE: the script scrot-probes for a non-empty frame and exits 14 when it never paints", () => {
    const cmd = buildDisplayStackScript({ port: 6080 });
    // The completion criterion is a REAL scrot (not just ports listening). It must
    // appear AFTER the bring-up (the up-script/precheck), chained with && so a failed
    // bring-up short-circuits it, and it must exit 14 (the "paint" stage) on failure.
    const scrotIdx = cmd.indexOf("scrot -o");
    const upIdx = cmd.indexOf("opengeni-desktop-up");
    expect(scrotIdx).toBeGreaterThan(upIdx);
    expect(cmd).toContain("[ -s ");
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
});
