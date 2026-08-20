import { describe, expect, test } from "bun:test";

import {
  beginWorkspaceOperation,
  beginWorkspaceTransition,
  invalidateWorkspaceTransition,
  ownsWorkspaceOperation,
  settleWorkspaceOperation,
} from "./lib/workspace-transition";

const contextSource = await Bun.file(`${import.meta.dir}/context.tsx`).text();

function sourceBetween(start: string, end: string): string {
  const startIndex = contextSource.indexOf(start);
  const endIndex = contextSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contextSource.slice(startIndex, endIndex);
}

describe("principal transition contract", () => {
  test("every credential and managed-principal mutation uses the complete invalidation seam", () => {
    expect(sourceBetween("function saveAccessKey()", "function forgetAccessKey()")).toContain(
      "invalidatePrincipalWorkspaceState();",
    );
    expect(
      sourceBetween("function forgetAccessKey()", "async function handleManagedAuth("),
    ).toContain("invalidatePrincipalWorkspaceState();");
    expect(
      sourceBetween("async function handleManagedAuth(", "async function handleManagedSignOut()"),
    ).toContain("invalidatePrincipalWorkspaceState();");
    expect(
      sourceBetween("async function handleManagedSignOut()", "const contextAddManualRepository"),
    ).toContain("invalidatePrincipalWorkspaceState();");

    const invalidation = sourceBetween(
      "const invalidatePrincipalWorkspaceState",
      "useEffect(() => {",
    );
    expect(invalidation).toContain("resetWorkspaceState(null, true)");

    const reset = sourceBetween("const resetWorkspaceState", "const prepareWorkspaceTransition");
    for (const requiredFence of [
      "activeCreateOperation.current = null",
      "pendingCreateAttempt.current = null",
      "githubRefreshId.current += 1",
      "mcpRefreshId.current += 1",
      "setManualRepos([])",
      "setSelectedRepoIds(new Set())",
      "setSelectedCapabilityToolIds(new Set())",
      "setWorkspaceStateOwnerId(workspaceId)",
    ]) {
      expect(reset).toContain(requiredFence);
    }
  });

  test("an old-credential create cannot install after same-route principal replacement", () => {
    const original = beginWorkspaceTransition({ workspaceId: null, revision: 0 }, "workspace-a");
    const started = beginWorkspaceOperation(0, original.identity);

    // Access-key replacement, sign-out, and sign-in all run this same forced
    // invalidation before the route is rebound to the new principal.
    const invalidated = invalidateWorkspaceTransition(original.identity);
    const rebound = beginWorkspaceTransition(invalidated, "workspace-a");
    const active = null;

    expect(ownsWorkspaceOperation(active, rebound.identity, started.operation, "workspace-a")).toBe(
      false,
    );
    expect(settleWorkspaceOperation(active, started.operation)).toEqual({
      active: null,
      settledCurrent: false,
    });
  });

  test("session creation and MCP refresh consume the shared transition fences", () => {
    const startSession = sourceBetween(
      "async function startSession(",
      "async function startGitHubAppManifestFlow",
    );
    expect(startSession).toContain("beginWorkspaceOperation(");
    expect(startSession).toContain("activeCreateOperation.current = operation");
    expect(startSession.match(/ownsWorkspaceOperation\(/g)).toHaveLength(2);
    expect(startSession).toContain(
      "settleWorkspaceOperation(activeCreateOperation.current, operation)",
    );

    const refreshMcp = sourceBetween(
      "const refreshWorkspaceMcpServers",
      "async function startSession(",
    );
    expect(refreshMcp).toContain("runCurrentWorkspaceRequest({");
    expect(refreshMcp).toContain("currentRequestId: () => mcpRefreshId.current");
  });

  test("every asynchronous GitHub mutation is invocation-bound before UI effects", () => {
    const refresh = sourceBetween("const refreshGitHub", "const refreshWorkspaceMcpServers");
    expect(refresh).toContain("const acceptedTransition = workspaceTransitionIdentity.current");
    expect(refresh).toContain("!ownsRefresh()");

    const manifest = sourceBetween(
      "async function startGitHubAppManifestFlow",
      "async function disconnectGitHubInstallation",
    );
    expect(manifest).toContain("runCurrentWorkspaceOperation({");
    expect(manifest.indexOf("ownsWorkspaceOperation(")).toBeLessThan(
      manifest.indexOf("submitGitHubManifest("),
    );

    const disconnect = sourceBetween(
      "async function disconnectGitHubInstallation",
      "function toggleGitHubRepository",
    );
    expect(disconnect).toContain("runCurrentWorkspaceOperation({");
    expect(disconnect.indexOf("ownsWorkspaceOperation(")).toBeLessThan(
      disconnect.indexOf("await refreshGitHub("),
    );
  });

  test("workspace refreshes used by Slack cannot upsert after their route transition", () => {
    const refreshWorkspace = sourceBetween(
      "const refreshWorkspace = useCallback",
      "async function updateWorkspaceSettings",
    );
    expect(refreshWorkspace).toContain("captureWorkspaceInvocation(workspaceId)");
    expect(refreshWorkspace.indexOf("ownsWorkspaceInvocation(")).toBeLessThan(
      refreshWorkspace.indexOf("setWorkspaces("),
    );
  });

  test("ambiguous managed sign-out reconciles the cookie before access reload", () => {
    const signOut = sourceBetween(
      "async function handleManagedSignOut()",
      "const contextAddManualRepository",
    );
    expect(signOut).not.toContain("previousAuthSession");
    expect(signOut).toContain("signOutWithAuthoritativeReconciliation<AuthSession>");
    expect(signOut).toContain("readSession: fetchAuthSession");
    expect(signOut.indexOf("setAuthSession(result.session)")).toBeLessThan(
      signOut.indexOf("setAccessKeyVersion((version) => version + 1)"),
    );
  });
});
