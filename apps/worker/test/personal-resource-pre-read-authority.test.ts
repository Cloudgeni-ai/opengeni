import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("personal-resource direct-read authority", () => {
  test("revalidates Rig reads early and threads exact attempt authority into every Variable Set materialization", async () => {
    const source = await readFile(
      new URL("../src/activities/agent-turn.ts", import.meta.url),
      "utf8",
    );
    const authorize = source.indexOf("await resolveSessionAttemptPersonalResources(db");
    const rigRead = source.indexOf("await materializeRigVersionForAttempt(db", authorize);
    const variableRead = source.indexOf(
      "loadWorkspaceEnvironmentForRunWithCredentials(",
      authorize,
    );
    expect(authorize).toBeGreaterThan(0);
    expect(authorize).toBeLessThan(rigRead);
    expect(authorize).toBeLessThan(variableRead);
    expect(source.slice(authorize - 240, authorize)).toContain("zero-row no-op");
    expect(source).toContain("const variableSetAuthority = {");
    expect(source).toContain("attemptId: input.attemptId");
    expect(source).toContain("executionGeneration: turn.executionGeneration");
    expect(source).toContain("initiatingHumanSubjectId: fileAuthoritySubjectId");
    expect(source.match(/variableSetAuthority,/gu)?.length).toBe(2);
    const selectionGuard = source.indexOf(
      "if (session.variableSetId !== null || rigDefaultVariableSetIds.length > 0)",
      authorize,
    );
    const subjectGuard = source.indexOf("if (!fileAuthoritySubjectId)", selectionGuard);
    expect(selectionGuard).toBeGreaterThan(authorize);
    expect(selectionGuard).toBeLessThan(variableRead);
    expect(subjectGuard).toBeGreaterThan(selectionGuard);
  });
});
