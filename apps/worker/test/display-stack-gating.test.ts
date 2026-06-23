// P4.1 — the worker-side ensureDisplayStack GATING (creds-free, no live box).
//
// resumeBoxForTurn's spawner branch calls ensureDisplayStack(settings, established)
// on every cold-restore. This pins the I5 headless-rollover gate:
//
//   (1) sandboxDesktopEnabled=false  -> NO-OP (the box is never touched).
//   (2) flag ON but the backend is headless-only (unix_local: DesktopStream
//       unavailable) -> NO-OP (degradation is a value, not a throw).
//   (3) flag ON + a desktop-capable backendId (modal) -> DELEGATES: execs the
//       canonical flock-wrapped opengeni-desktop-up on the box exactly once.
//   (4) a desktop-capable box that cannot run commands degrades to Channel-A
//       (DisplayStackUnsupportedError is swallowed) rather than failing the turn.
//
// The live proof (xdpyinfo/sockets/XTEST/scrot on real Modal/gVisor) is the
// OPENGENI_P41_LIVE_MODAL-gated integration test below this one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testSettings } from "@opengeni/testing";
import type { EstablishedSandboxSession } from "@opengeni/runtime";
import { ensureDisplayStack } from "../src/sandbox-resume";

function fakeBox(backendId: string) {
  const calls: string[] = [];
  const session = {
    exec: async ({ cmd }: { cmd: string }) => {
      calls.push(cmd);
      return {
        output: "OPENGENI_DESKTOP_UP port=6080 geometry=1280x800 dpi=96",
        stdout: "OPENGENI_DESKTOP_UP port=6080 geometry=1280x800 dpi=96",
        stderr: "",
        exitCode: 0,
        wallTimeSeconds: 0.1,
      };
    },
  };
  const established: EstablishedSandboxSession = {
    client: {},
    session,
    sessionState: {},
    instanceId: "box-1",
    backendId,
  };
  return { established, calls };
}

describe("P4.1 worker ensureDisplayStack gating (I5 headless-rollover branch)", () => {
  test("(1) flag OFF -> no-op (box never touched)", async () => {
    const settings = testSettings({ sandboxDesktopEnabled: false });
    const { established, calls } = fakeBox("modal");
    await ensureDisplayStack(settings, established);
    expect(calls).toHaveLength(0);
  });

  test("(2) flag ON but headless-only backend (unix_local) -> no-op", async () => {
    const settings = testSettings({ sandboxDesktopEnabled: true });
    const { established, calls } = fakeBox("unix_local");
    await ensureDisplayStack(settings, established);
    expect(calls).toHaveLength(0);
  });

  test("(3) flag ON + desktop-capable backend (modal) -> execs the flock-wrapped up-script once", async () => {
    const settings = testSettings({ sandboxDesktopEnabled: true });
    const { established, calls } = fakeBox("modal");
    await ensureDisplayStack(settings, established);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("flock");
    expect(calls[0]).toContain("opengeni-desktop-up");
    expect(calls[0]).toContain("STREAM_PORT=6080");
  });

  test("(4) a desktop-capable box that cannot run commands degrades (no throw)", async () => {
    const settings = testSettings({ sandboxDesktopEnabled: true });
    const established: EstablishedSandboxSession = {
      client: {},
      session: {}, // no exec/execCommand
      sessionState: {},
      instanceId: "box-2",
      backendId: "modal",
    };
    // Channel-A-only fallback: swallowed, not thrown.
    await ensureDisplayStack(settings, established);
    expect(true).toBe(true);
  });
});

// ── Regression: the computer-use "400 Invalid input[N].output.image_url" fix ───
// The trigger was that resumeBoxForTurn brought up the desktop :0 ONLY on the
// SPAWNER branch; a turn ATTACHING to a warm box whose display was never up (box
// first warmed by a Channel-A op, or a snapshot rollover dropped the X stack)
// drove computer-use against a dead :0 — scrot returned an empty PNG, the Agents
// SDK built `image_url: ''`, and the model 400'd the turn. FIX A re-ensures the
// display stack on the ATTACHED/REARMED branch too. We pin the structural
// invariant (source-level, no live modal box needed): BOTH resume branches call
// ensureDisplayStack(settings, established). This fails loud if the attached-path
// ensure is ever removed.
describe("REGRESSION: resumeBoxForTurn ensures the display stack on BOTH the spawner AND the attached branch", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "sandbox-resume.ts"), "utf8");

  test("ensureDisplayStack is called at least twice in the source (spawner + attached)", () => {
    const calls = source.match(/await ensureDisplayStack\(settings, established\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test("the attached/rearmed branch (resume-by-id) ensures the stack before returning the established session", () => {
    // The attached branch establishes from the lease's resume_state then returns
    // { established, leaseEpoch, release }. Assert ensureDisplayStack runs between
    // that establish and that return — i.e. an attaching turn always finds a live :0.
    const attachedBranch = source.slice(source.indexOf("Prefer the lease's resume_state"));
    const ensureIdx = attachedBranch.indexOf("await ensureDisplayStack(settings, established)");
    const returnIdx = attachedBranch.indexOf("return { established, leaseEpoch, release }");
    expect(ensureIdx).toBeGreaterThan(0);
    expect(returnIdx).toBeGreaterThan(ensureIdx);
  });
});
