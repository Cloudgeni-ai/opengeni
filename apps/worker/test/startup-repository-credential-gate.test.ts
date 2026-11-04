import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { unboundGitHubRepositoryResources } from "@opengeni/core";
import type { ResourceRef } from "@opengeni/contracts";

const source = readFileSync(
  new URL("../src/activities/agent-turn/run.ts", import.meta.url),
  "utf8",
);
const parsed = parseSync("run.ts", source);
if (parsed.errors.length) throw new Error("Cannot parse production run stage");
let declaration: { start: number; end: number } | undefined;
function visit(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const value = node as Record<string, unknown>;
  if (
    value.type === "VariableDeclaration" &&
    (value.declarations as Array<{ id?: { name?: string } }>).some(
      (d) => d.id?.name === "hasCredentialProvider",
    )
  ) {
    if (declaration) throw new Error("Ambiguous production gate");
    declaration = value as unknown as { start: number; end: number };
    return;
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(visit);
    else if (child && typeof child === "object") visit(child);
  }
}
visit(parsed.program);
if (!declaration) throw new Error("Missing production gate");
// Execute the production expression rather than a second copy of the gate.
const evaluate = new Function(
  "activeSandboxBackend",
  "claimedTurnResources",
  "unboundGitHubRepositoryResources",
  "getWorkspaceCredentialProvider",
  `return (async () => {
  const db = {}, input = { accountId: "account", workspaceId: "workspace" };
  const cancellationSignal = undefined;
  const waitForTurnOperation = async (operation) => await operation;
  ${source.slice(declaration.start, declaration.end)}
  return hasCredentialProvider;
})();`,
) as (
  backend: string,
  resources: ResourceRef[],
  matcher: typeof unboundGitHubRepositoryResources,
  provider: () => Promise<{ enabled: boolean } | null>,
) => Promise<boolean>;
const bare: ResourceRef = { kind: "repository", uri: "https://github.com/acme/app" };
describe("turn repository credential-provider read", () => {
  test.each([
    ["none", []],
    ["compute", []],
    ["selfhosted", [bare]],
    ["compute", [{ kind: "file", fileId: "11111111-1111-4111-8111-111111111111" }]],
    ["compute", [{ ...bare, githubInstallationId: 1, githubRepositoryId: 2 }]],
    ["compute", [{ ...bare, connectionId: "11111111-1111-4111-8111-111111111111" }]],
    ["compute", [{ ...bare, uri: "https://example.test/team/repo" }]],
  ] as Array<[string, ResourceRef[]]>)(
    "skips an unconsumed provider read (%s)",
    async (backend, resources) => {
      let reads = 0;
      expect(
        await evaluate(backend, resources, unboundGitHubRepositoryResources, async () => {
          reads++;
          throw new Error("unused read");
        }),
      ).toBe(false);
      expect(reads).toBe(0);
    },
  );
  test.each([true, false])(
    "bare GitHub resources retain the live provider result (%s)",
    async (enabled) => {
      let reads = 0;
      expect(
        await evaluate("compute", [bare], unboundGitHubRepositoryResources, async () => {
          reads++;
          return { enabled };
        }),
      ).toBe(enabled);
      expect(reads).toBe(1);
    },
  );
  test("preserves absence and read failure for a binding consumer", async () => {
    expect(
      await evaluate("compute", [bare], unboundGitHubRepositoryResources, async () => null),
    ).toBe(false);
    const error = new Error("provider lookup failed");
    await expect(
      evaluate("compute", [bare], unboundGitHubRepositoryResources, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
