import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  agentWorkspaceVersion,
  sourceTreeAgentVersion,
  stableAgentVersion,
} from "../src/sandbox/agent-release";
import { promotedAgentVersion } from "../src/sandbox/machines";

describe("the stable agent release", () => {
  test("reads the agent workspace version every agent release is tagged from", () => {
    const manifest = [
      "[workspace]",
      'members = ["crates/*"]',
      "",
      "[workspace.package]",
      'version = "0.2.7"',
      'edition = "2021"',
      "",
      "[workspace.dependencies]",
      'serde = { version = "1.0.1" }',
    ].join("\n");
    expect(agentWorkspaceVersion(manifest)).toBe("0.2.7");
    expect(agentWorkspaceVersion('[package]\nversion = "1.0.0"\n')).toBeNull();
    expect(agentWorkspaceVersion('[workspace.package]\nversion = "1.0.0-rc.1"\n')).toBeNull();
  });

  test("is the operator's pin when set, otherwise this source tree's agent release", async () => {
    const cargo = await readFile(new URL("../../../agent/Cargo.toml", import.meta.url), "utf8");
    const ownRelease = agentWorkspaceVersion(cargo);
    expect(ownRelease).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(sourceTreeAgentVersion()).toBe(ownRelease!);
    expect(stableAgentVersion({ agentStableVersion: undefined })).toBe(ownRelease!);
    expect(stableAgentVersion({ agentStableVersion: "1.4.2" })).toBe("1.4.2");
    // Machines on either channel are promoted to it unless beta is pinned.
    const unpinned = { agentStableVersion: undefined, agentBetaVersion: undefined };
    expect(promotedAgentVersion(unpinned, "stable")).toBe(ownRelease!);
    expect(promotedAgentVersion(unpinned, "beta")).toBe(ownRelease!);
    expect(promotedAgentVersion({ ...unpinned, agentBetaVersion: "9.0.0" }, "beta")).toBe("9.0.0");
  });

  test("is unknown, not an older default, when neither a pin nor the source tree names one", () => {
    const withoutSourceTree = () => null;
    expect(stableAgentVersion({ agentStableVersion: undefined }, withoutSourceTree)).toBeNull();
    expect(stableAgentVersion({ agentStableVersion: "1.4.2" }, withoutSourceTree)).toBe("1.4.2");
  });
});
