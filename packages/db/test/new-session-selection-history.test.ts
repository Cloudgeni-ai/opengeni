import { describe, expect, test } from "bun:test";
import type { NewSessionSelectionHistory } from "@opengeni/contracts";
import { rememberNewSessionSelection } from "../src/new-session-drafts";

describe("new-session successful-create hierarchy", () => {
  const projectA = "00000000-0000-4000-8000-000000000031";
  const projectB = "00000000-0000-4000-8000-000000000032";
  const machineA = "00000000-0000-4000-8000-000000000041";
  const machineB = "00000000-0000-4000-8000-000000000042";

  test("keeps project, machine, and absolute path recency tied together", () => {
    let history: NewSessionSelectionHistory = { projects: [] };
    history = rememberNewSessionSelection(history, {
      channelId: projectA,
      targetSandboxId: machineA,
      workingDir: "/workspace/opengeni",
    });
    history = rememberNewSessionSelection(history, {
      channelId: projectA,
      targetSandboxId: machineB,
      workingDir: "repos/cloudgeni",
    });
    history = rememberNewSessionSelection(history, {
      channelId: projectB,
      targetSandboxId: machineA,
      workingDir: "/srv/project-b",
    });

    expect(history.projects).toEqual([
      {
        channelId: projectB,
        targetSandboxId: machineA,
        machines: [{ sandboxId: machineA, workingDir: "/srv/project-b" }],
      },
      {
        channelId: projectA,
        targetSandboxId: machineB,
        machines: [
          { sandboxId: machineB, workingDir: "repos/cloudgeni" },
          { sandboxId: machineA, workingDir: "/workspace/opengeni" },
        ],
      },
    ]);
  });

  test("remembering sandbox keeps prior per-machine paths for that project", () => {
    const history = rememberNewSessionSelection(
      {
        projects: [
          {
            channelId: projectA,
            targetSandboxId: machineA,
            machines: [{ sandboxId: machineA, workingDir: "/absolute/project-a" }],
          },
        ],
      },
      { channelId: projectA, targetSandboxId: null, workingDir: null },
    );
    expect(history.projects[0]).toEqual({
      channelId: projectA,
      targetSandboxId: null,
      machines: [{ sandboxId: machineA, workingDir: "/absolute/project-a" }],
    });
  });
});
