import { describe, expect, test } from "bun:test";
import path from "node:path";
import { OpenGeniClient } from "../src/index";
import { OpenGeniCoreClient } from "../src/core";
import { OpenGeniBrowserClient } from "../src/browser";
import { SITE_BROWSER_RUNTIME } from "../src/site-browser-runtime.gen";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const clientPath = path.join(repoRoot, "packages/sdk/src/client.ts");

// These methods predate the browser-specific entry. Keep the list explicit so
// removing legacy surface tightens the boundary, while adding a browser-unused
// method to the eager client fails review until it moves to a focused subpath.
const legacyBrowserUnusedMethods = [
  // Identity proposals are confirmed in the conversation that made them.
  "activateCompanyProfileRevision",
  "addDocument",
  "advanceExternalBrowserAuthRun",
  "applyGoalRevision",
  "browseAtlassianSources",
  // Only the removed Agents page cancelled sessions from the web client.
  "cancelSession",
  "captureComputerTarget",
  "codexAccountUsage",
  "codexDisconnect",
  "codexStatus",
  "codexUsage",
  "createDocumentBase",
  "createWorkspaceInstructionPolicyOnboardingProposal",
  "createOrganization",
  "deleteDocument",
  "diffCompanyProfileRevisions",
  "diffWorkspaceInstructionPolicyRevisions",
  "exportWorkspaceState",
  "getCompanyProfileRevision",
  "getDocumentBase",
  "getDocumentOriginalFile",
  "getEnvironment",
  "getLatestEventResult",
  "getLatestStartedTurn",
  "getPreferenceRegistryFullContent",
  "getPreferenceRegistrySummary",
  "getRetainedArtifactContent",
  "getSessionRetainedArtifactContent",
  "getVideoGenerationOperation",
  "gitLog",
  "gitShow",
  "githubConnectUrl",
  "importLegacyWorkspaceInstructionPolicyDraft",
  // Retain the existing public SDK method after the browser's duplicate
  // override-settings navigation was removed in #2490.
  "listAgentLearningOverrides",
  "listDocuments",
  // The rebuilt Knowledge page folds Files into Knowledge entries, and the
  // organization identity is drafted rather than edited or rolled back inline.
  "listFiles",
  "listGoalRevisionPage",
  "listGoalRevisions",
  "listTranscriptionRecordings",
  "moveDocument",
  "openExternalBrowserAuthFlow",
  "pauseGoal",
  "rejectGoalRevision",
  "resumeGoal",
  "revokeUserResourceGrant",
  "rollbackCompanyProfile",
  "rollbackGoalRevision",
  "setAtlassianLifecycle",
  "startApiIntegrationOAuth",
  "startOpenGeniSlackBotInstall",
  "startPersonalGitHubOAuth",
  "supergrokStatus",
  "undoGovernedLearningActivation",
  "updateCompanyProfile",
  "updateOrganizationWorkspaceSettings",
  // The session agent-configuration panel (web milestone M5) adopts this.
  "verifyPersonalGitHubRepositorySelections",
];

// The agent's browser still capture uses the same authenticated, bounded SDK
// response transport as the existing computer capture method. It is intentionally
// available to runtime callers even though the web UI does not call it.
const agentInteractionMethods = ["captureBrowserTarget", "getBrowserTargetState", "readBrowserDom"];

function countIdentifier(source: string, identifier: string): number {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`\\b${escaped}\\b`, "g"))?.length ?? 0;
}

async function readBrowserProductionSources(): Promise<string> {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const roots = ["apps/web/src", "packages/react/src"];
  const sources: string[] = [];

  for (const root of roots) {
    for await (const file of glob.scan({ cwd: path.join(repoRoot, root), absolute: true })) {
      if (/\.(?:test|spec)\.[^.]+$/.test(file)) continue;
      sources.push(await Bun.file(file).text());
    }
  }

  return sources.join("\n");
}

describe("browser client runtime surface", () => {
  test("preserves retired organization usage reads on public compatibility clients only", async () => {
    for (const Client of [OpenGeniClient, OpenGeniCoreClient]) {
      const requests: URL[] = [];
      const client = new Client({
        baseUrl: "https://api.example.test",
        fetch: async (input) => {
          requests.push(new URL(String(input)));
          return Response.json({ accountId: "account" });
        },
      });
      expect(await client.getOrganizationUsageSummary({ accountId: "account" })).toMatchObject({
        accountId: "account",
      });
      await client.getOrganizationUsageWorkspacePage({
        accountId: "account",
        period: "week",
        until: "2026-10-03T00:00:00Z",
        afterWorkspaceId: "workspace",
      });
      expect(requests.map((url) => url.pathname)).toEqual([
        "/v1/billing/usage-summary",
        "/v1/billing/usage-workspaces",
      ]);
      expect(requests[0]!.searchParams.get("period")).toBe("month");
      expect(Object.fromEntries(requests[1]!.searchParams)).toEqual({
        accountId: "account",
        period: "week",
        until: "2026-10-03T00:00:00Z",
        afterWorkspaceId: "workspace",
      });
    }
    const browser = new OpenGeniBrowserClient({ baseUrl: "https://api.example.test" });
    expect("getOrganizationUsageSummary" in browser).toBe(false);
    expect("getOrganizationUsageWorkspacePage" in browser).toBe(false);
    expect(browser.getOrganizationModelUsage).toBeFunction();
  });

  test("excludes retired organization usage routes from browser and Site bundles", async () => {
    const result = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixtures/core-bundle-entry.ts")],
      target: "browser",
      format: "esm",
      minify: true,
    });
    if (!result.success) throw new AggregateError(result.logs, "Browser bundle failed");
    const browserBundle = await result.outputs[0]!.text();
    for (const route of ["/v1/billing/usage-summary", "/v1/billing/usage-workspaces"]) {
      expect(browserBundle.includes(route)).toBe(false);
      expect(SITE_BROWSER_RUNTIME.includes(route)).toBe(false);
    }
    expect(browserBundle).toContain("/v1/billing/usage-models");
  });

  test("rejects new SDK methods that the browser does not use", async () => {
    const [clientSource, browserSource] = await Promise.all([
      Bun.file(clientPath).text(),
      readBrowserProductionSources(),
    ]);
    const methodNames = [
      ...clientSource.matchAll(/^  (?:async )?([A-Za-z_$][A-Za-z0-9_$]*)\(/gm),
    ].map((match) => match[1]!);
    const browserUnusedMethods = [...new Set(methodNames)]
      .filter(
        (methodName) =>
          countIdentifier(browserSource, methodName) === 0 &&
          countIdentifier(clientSource, methodName) === 1,
      )
      .sort();

    expect(browserSource).toContain("@opengeni/sdk/browser");
    expect(browserSource).not.toContain("@opengeni/sdk/core");
    expect(browserUnusedMethods).toEqual(
      [...legacyBrowserUnusedMethods, ...agentInteractionMethods].sort(),
    );
  });
});
