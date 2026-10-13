import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("personal-resource direct-read authority", () => {
  test("local title and publication admission use the linked effective permission ceiling", async () => {
    const source = await readFile(
      new URL("../src/activities/agent-turn/tool-environment.ts", import.meta.url),
      "utf8",
    );
    const admission = source.slice(
      source.indexOf("const titleToolPlan ="),
      source.indexOf("const googleDriveConnectorBindings"),
    );
    expect(admission).not.toContain("session.firstPartyMcpPermissions");
    expect(admission).toContain("firstPartyMcpPermissions: effectiveFirstPartyPermissions");
    expect(
      admission.match(/effectiveFirstPartyPermissions \?\? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS/g),
    ).toHaveLength(2);
    expect(admission).not.toContain("?.length");
  });
  test("revalidates Rig reads early and never materializes Variable Sets into the turn", async () => {
    const governance = await readFile(
      new URL("../src/activities/agent-turn/governance-model.ts", import.meta.url),
      "utf8",
    );
    const toolEnvironment = await readFile(
      new URL("../src/activities/agent-turn/tool-environment.ts", import.meta.url),
      "utf8",
    );
    const orchestrator = await readFile(
      new URL("../src/activities/agent-turn/run.ts", import.meta.url),
      "utf8",
    );
    const authorize = governance.indexOf("await resolveSessionAttemptPersonalResources(db");
    const rigRead = governance.indexOf("await materializeRigVersionForAttempt(db", authorize);
    expect(authorize).toBeGreaterThan(0);
    expect(authorize).toBeLessThan(rigRead);
    expect(governance.slice(authorize - 240, authorize)).toContain("zero-row no-op");
    // W1 (secrets delivery): the turn no longer materializes Variable Sets at all.
    expect(toolEnvironment).not.toContain("loadWorkspaceEnvironmentForRunWithCredentials(");
    expect(toolEnvironment).not.toContain("variableSetAuthority");
    expect(orchestrator.indexOf("prepareGovernanceAndModel(")).toBeGreaterThan(0);
    expect(orchestrator.indexOf("prepareGovernanceAndModel(")).toBeLessThan(
      orchestrator.indexOf("prepareTurnToolPolicy("),
    );
    expect(governance).not.toContain(
      'throw new Error("variable-set materialization requires an initiating human subject")',
    );
    expect(toolEnvironment).not.toContain(
      'throw new Error("variable-set materialization requires an initiating human subject")',
    );
  });
});
