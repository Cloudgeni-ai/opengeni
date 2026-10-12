import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { REMOVAL_RULES, findVariableSetRemovalViolations } from "./check-variable-set-removal";

const repoRoot = join(import.meta.dir, "..");

describe("Variable Set removal guard", () => {
  test("product code no longer uses the removed Variable Set client surface", async () => {
    expect(await findVariableSetRemovalViolations(repoRoot)).toEqual([]);
  });

  test("each rule catches the surface it guards", () => {
    const samples = [
      "await client.listVariableSets(workspaceId);",
      'await this.requestJson("GET", `/v1/workspaces/${id}/variable-sets`);',
      'import { SessionVariableSetPicker } from "@/components/session/session-variable-set-picker";',
    ];
    REMOVAL_RULES.forEach((rule, index) => {
      expect(rule.pattern.test(samples[index]!)).toBe(true);
    });
    expect(REMOVAL_RULES.some((rule) => rule.pattern.test("client.vaults(workspaceId)"))).toBe(
      false,
    );
  });
});
