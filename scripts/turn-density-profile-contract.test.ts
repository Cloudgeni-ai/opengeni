import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("uses the granted workspace subject for synthetic turn execution", async () => {
  const source = await readFile(
    resolve(import.meta.dir, "operator/turn-density-profile.ts"),
    "utf8",
  );

  expect(source).toContain("const profileSubjectId = `operator:turn-density-profile:${runId}`;");
  expect(source.match(/subjectId: profileSubjectId/g)).toHaveLength(2);
  expect(source).not.toContain('subjectId: "turn-density-profile"');
  expect(source).toContain(".delete(schema.managedAccounts)");
  expect(source).toContain(".where(eq(schema.managedAccounts.id, accountId))");
});

test("isolates first-party MCP setup from the deployment access mode", async () => {
  const source = await readFile(
    resolve(import.meta.dir, "operator/turn-density-profile.ts"),
    "utf8",
  );

  expect(source).toContain("const densityMcp = startTestMcpServer();");
  expect(source).toContain("const densityMcpUrl = `${densityMcp.url}?workspace={workspaceId}`;");
  expect(source).toContain("opengeniMcpUrl: densityMcpUrl");
  expect(source).toContain('id: "opengeni"');
  expect(source).toContain("densityMcp.close();");
  expect(source).toContain("if (runFailure) throw runFailure;");
  expect(source).toContain("process.exit(process.exitCode ?? 0);");
});
