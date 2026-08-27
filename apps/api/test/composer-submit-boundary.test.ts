import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

describe("composer submit application boundary", () => {
  test("keeps the HTTP route as an adapter over the public core command", () => {
    const routeSource = readFileSync(join(repoRoot, "apps/api/src/routes/sessions.ts"), "utf8");
    const start = routeSource.indexOf(
      'app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/composer-draft/submit"',
    );
    const end = routeSource.indexOf(
      'app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/events"',
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = routeSource.slice(start, end);

    expect(handler).toContain("submitComposerDraftForRequest(");
    expect(handler).not.toContain("acceptSessionUserMessageWithOutcome(");
    expect(handler).not.toContain(
      "Accepted composer draft submission did not return its next draft",
    );
    expect(handler).not.toContain("mcpCredentialUpdates: payload.mcpCredentialUpdates");
  });

  test("exports the application command from the core public barrel", () => {
    const coreIndex = readFileSync(join(repoRoot, "packages/core/src/index.ts"), "utf8");
    const command = readFileSync(
      join(repoRoot, "packages/core/src/application/composer-submit.ts"),
      "utf8",
    );

    expect(coreIndex).toContain('export * from "./application/composer-submit"');
    expect(command).toContain("Promise<SubmitComposerDraftResponse>");
    expect(command).toContain("acceptSessionUserMessageWithOutcome(");
  });
});
