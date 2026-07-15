import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression for the production capacity incident of 2026-07-15: every
// filesystem turn eagerly started Xvfb/XFCE/ffmpeg, occupying all turn-worker
// slots for minutes and creating a large Modal burst. The turn resume path is
// now strictly compute-only. Viewer attach and actual computer-use own desktop
// initialization in their respective lazy paths.
describe("turn sandbox resume is desktop-free", () => {
  const resumeSource = readFileSync(
    join(import.meta.dir, "..", "src", "sandbox-resume.ts"),
    "utf8",
  );
  const agentTurnSource = readFileSync(
    join(import.meta.dir, "..", "src", "activities", "agent-turn.ts"),
    "utf8",
  );

  test("resumeBoxForTurn never launches the display or resolves a stream port", () => {
    expect(resumeSource).not.toContain("ensureDisplayStack(");
    expect(resumeSource).not.toContain("exposeStreamPort(");
    expect(resumeSource).not.toContain("resolveExposedPort(");
    expect(resumeSource).toContain("dataPlaneUrl: null");
  });

  test("recording starts only from the actual computer-use callback", () => {
    expect(agentTurnSource).toContain("onComputerUseReady: async () =>");
    const eagerCalls = agentTurnSource.match(/await maybeStartOnTurnRecording\(/g) ?? [];
    expect(eagerCalls).toHaveLength(1);
    const callback = agentTurnSource.slice(agentTurnSource.indexOf("onComputerUseReady: async"));
    expect(callback.indexOf("await maybeStartOnTurnRecording(")).toBeGreaterThan(0);
  });
});
