import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const clientPath = path.join(repoRoot, "packages/sdk/src/client.ts");

// These methods predate the browser-specific entry. Keep the list explicit so
// removing legacy surface tightens the boundary, while adding a browser-unused
// method to the eager client fails review until it moves to a focused subpath.
const legacyBrowserUnusedMethods = [
  "addDocument",
  "advanceExternalBrowserAuthRun",
  "applyGoalRevision",
  "browseAtlassianSources",
  "captureComputerTarget",
  "codexAccountUsage",
  "codexDisconnect",
  "codexStatus",
  "codexUsage",
  "createDocumentBase",
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
  "getScheduledTask",
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
  "listGoalRevisionPage",
  "listGoalRevisions",
  "listTranscriptionRecordings",
  "moveDocument",
  "openExternalBrowserAuthFlow",
  "pauseGoal",
  "rejectGoalRevision",
  "resumeGoal",
  "revokeUserResourceGrant",
  "rollbackGoalRevision",
  "rollbackWorkspaceInstructionPolicyRevision",
  "setAtlassianLifecycle",
  "startApiIntegrationOAuth",
  "startOpenGeniSlackBotInstall",
  "startPersonalGitHubOAuth",
  "supergrokStatus",
  "undoGovernedLearningActivation",
  "updateOrganizationWorkspaceSettings",
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
