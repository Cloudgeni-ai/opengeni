import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression for the production capacity incident of 2026-07-15: every
// filesystem turn eagerly started Xvfb/XFCE/ffmpeg, occupying all turn-worker
// slots for minutes and creating a large Modal burst. The turn resume path is
// now strictly compute-only. Viewer attach and managed ComputerSession operations
// own desktop initialization in their respective lazy paths.
describe("turn sandbox resume is desktop-free", () => {
  const resumeSource = readFileSync(
    join(import.meta.dir, "..", "src", "sandbox-resume.ts"),
    "utf8",
  );
  const agentTurnSource = readFileSync(
    join(import.meta.dir, "..", "src", "activities", "agent-turn", "agent-build.ts"),
    "utf8",
  );

  test("resumeBoxForTurn never launches the display or resolves a stream port", () => {
    expect(resumeSource).not.toContain("ensureDisplayStack(");
    expect(resumeSource).not.toContain("exposeStreamPort(");
    expect(resumeSource).not.toContain("resolveExposedPort(");
    expect(resumeSource).toContain("dataPlaneUrl: null");
  });

  test("agent turns do not expose the retired model-bound computer or on-turn recording seams", () => {
    expect(agentTurnSource).not.toContain("onComputerUseReady");
    expect(agentTurnSource).not.toContain("computerToolMode");
    expect(agentTurnSource).not.toContain("maybeStartOnTurnRecording");
  });
});
