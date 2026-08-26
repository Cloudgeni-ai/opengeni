import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("personal-resource direct-read authority", () => {
  test("revalidates Rig reads early and threads exact attempt authority into every Variable Set materialization", async () => {
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
    const variableRead = toolEnvironment.indexOf("loadWorkspaceEnvironmentForRunWithCredentials(");
    expect(authorize).toBeGreaterThan(0);
    expect(authorize).toBeLessThan(rigRead);
    expect(variableRead).toBeGreaterThan(0);
    expect(governance.slice(authorize - 240, authorize)).toContain("zero-row no-op");
    expect(toolEnvironment).toContain("const variableSetAuthority = {");
    expect(toolEnvironment).toContain("attemptId: input.attemptId");
    expect(toolEnvironment).toContain("executionGeneration: turn.executionGeneration");
    expect(toolEnvironment).toContain("initiator: turn.initiator");
    expect(toolEnvironment).toContain("initiatingHumanSubjectId: fileAuthoritySubjectId");
    expect(toolEnvironment.match(/variableSetAuthority,/gu)?.length).toBe(2);
    const selectionGuard = toolEnvironment.indexOf(
      "sessionVariableSetIds.length > 0 || rigDefaultVariableSetIds.length > 0",
    );
    expect(selectionGuard).toBeGreaterThan(0);
    expect(selectionGuard).toBeLessThan(variableRead);
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
