import { describe, expect, test } from "bun:test";

import {
  beginWorkspaceOperation,
  beginWorkspaceTransition,
  invalidateWorkspaceTransition,
  ownsWorkspaceOperation,
  settleWorkspaceOperation,
} from "./lib/workspace-transition";

const contextSource = await Bun.file(`${import.meta.dir}/context.tsx`).text();
const sessionListSource = await Bun.file(
  `${import.meta.dir}/components/rail/session-list.tsx`,
).text();
const transcriptionSettingsSource = await Bun.file(
  `${import.meta.dir}/components/transcription-settings.tsx`,
).text();
const workspaceSettingsSource = await Bun.file(
  `${import.meta.dir}/routes/workspace-settings.tsx`,
).text();
const rigDetailSource = await Bun.file(`${import.meta.dir}/routes/rig-detail.tsx`).text();
const slackIntegrationSource = await Bun.file(
  `${import.meta.dir}/components/capabilities/use-slack-integration.tsx`,
).text();

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
    ).toContain("invalidatePrincipalWorkspaceState({");
    expect(
      sourceBetween("async function handleManagedSignOut()", "const contextAddManualRepository"),
    ).toContain("invalidatePrincipalWorkspaceState();");

    const invalidation = sourceBetween(
      "const invalidatePrincipalWorkspaceState",
      "useEffect(() => {",
    );
    expect(invalidation).toContain("invalidatePrincipalTransition(");
    expect(invalidation).toContain("slackLinkPrepareController.clear()");
    expect(invalidation).toContain("options?.preservePendingSlackLink !== true");
    expect(invalidation).toContain("managedSelfContextIdentityRef.current = null");
    expect(invalidation).toContain("setManagedSelfContext(null)");
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
      "sessionChannelProjectionAuthority.clearWorkspace(previousWorkspaceId)",
    ]) {
      expect(reset).toContain(requiredFence);
    }
  });

  test("only managed sign-in may preserve the raw scrubbed Slack continuation", () => {
    const managedAuth = sourceBetween(
      "async function handleManagedAuth(",
      "async function handleManagedSignOut()",
    );
    expect(managedAuth).toContain("preservePendingSlackLink: preserveSlackLinkForManagedAuth(");
    expect(managedAuth).toContain("slackLinkPrepareController.phase()");

    for (const unrelatedTransition of [
      sourceBetween("function saveAccessKey()", "function forgetAccessKey()"),
      sourceBetween("function forgetAccessKey()", "async function handleManagedAuth("),
      sourceBetween("async function handleManagedSignOut()", "const contextAddManualRepository"),
    ]) {
      expect(unrelatedTransition).not.toContain("preservePendingSlackLink");
    }
  });

  test("access bootstrap is synchronously fenced by principal generation", () => {
    const accessLoad = sourceBetween(
      "void Promise.all([client.getAccessContext(), client.listWorkspaces(), selfContextPromise])",
      "const selectedInstalledRepositories",
    );
    expect(accessLoad).toContain(
      "ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)",
    );
    expect(accessLoad.indexOf("ownsPrincipalTransition(")).toBeLessThan(
      accessLoad.indexOf("setAccessContext(context)"),
    );
    expect(accessLoad.indexOf("ownsPrincipalTransition(")).toBeLessThan(
      accessLoad.indexOf('toast.error("Failed to load workspace access"'),
    );
  });

  test("browser actor changes unmount the old routed tree before transport rotation", () => {
    const transition = sourceBetween(
      "async function handleBrowserActorTransition(",
      "// Context actions keep one identity",
    );
    expect(transition).toContain("flushSync(() => {");
    expect(transition.indexOf("flushSync(() => {")).toBeLessThan(
      transition.indexOf("configureManagedActorEpoch("),
    );
    expect(transition.indexOf("if (transition.to === null) return;")).toBeLessThan(
      transition.indexOf("const acceptedPrincipal"),
    );
    expect(transition).toContain(
      'if (transition.to.selectedSlotId === null || transition.to.state !== "ready")',
    );
    expect(transition.indexOf('await navigate({ to: "/", replace: true });')).toBeGreaterThan(
      transition.indexOf("if (transition.to === null) return;"),
    );
    expect(transition.indexOf('await navigate({ to: "/", replace: true });')).toBeLessThan(
      transition.indexOf("const acceptedPrincipal"),
    );
    for (const requiredClear of [
      "invalidatePrincipalWorkspaceState();",
      "setAuthSession(undefined);",
      "setAccessContext(null);",
      "setWorkspaces([]);",
    ]) {
      expect(transition.indexOf(requiredClear)).toBeGreaterThan(
        transition.indexOf("flushSync(() => {"),
      );
      expect(transition.indexOf(requiredClear)).toBeLessThan(
        transition.indexOf("configureManagedActorEpoch("),
      );
    }
    expect(transition.indexOf("setAccessKeyVersion((version) => version + 1);")).toBeGreaterThan(
      transition.indexOf("configureManagedActorEpoch("),
    );
  });

  test("all remaining root workspace and session mutations use the invocation fence", () => {
    const sections = [
      sourceBetween("async function createWorkspace(", "async function renameWorkspace("),
      sourceBetween(
        "async function renameWorkspace(",
        "async function setWorkspaceInferenceControl(",
      ),
      sourceBetween("async function setWorkspaceInferenceControl(", "const refreshWorkspace"),
      sourceBetween(
        "const refreshWorkspace = useCallback",
        "async function updateWorkspaceSettings(",
      ),
      sourceBetween(
        "async function updateWorkspaceSettings(",
        "async function setWorkspaceDefaultRig(",
      ),
      sourceBetween("async function setWorkspaceDefaultRig(", "async function updateSessionTitle("),
      sourceBetween("async function updateSessionTitle(", "async function updateSessionPin("),
      sourceBetween("async function updateSessionPin(", "async function deleteWorkspace("),
      sourceBetween("async function deleteWorkspace(", "const refreshGitHub"),
    ];
    for (const section of sections) {
      expect(section).toContain("runCurrentTransitionInvocation({");
    }
  });

  test("mutation callers do not toast, refresh, or announce stale results", () => {
    expect(workspaceSettingsSource).toContain(
      "const updated = await context.setWorkspaceInferenceControl(workspaceId, action)",
    );
    expect(transcriptionSettingsSource).toContain(
      "const updated = await context.updateWorkspaceSettings(workspaceId",
    );
    expect(sessionListSource).toContain(
      "const acceptedTransition = context.captureWorkspaceInvocation(target.workspaceId)",
    );
    expect(sessionListSource).toContain(
      "if (!context.ownsWorkspaceInvocation(target.workspaceId, acceptedTransition)) return null",
    );
    expect(workspaceSettingsSource).toContain(
      "const acceptedTransition = captureWorkspaceInvocation(workspaceId)",
    );
    expect(rigDetailSource).toContain(
      "const acceptedTransition = context.captureWorkspaceInvocation(workspaceId)",
    );
    expect(slackIntegrationSource).toContain(
      "const acceptedTransition = context.captureWorkspaceInvocation(workspaceId)",
    );
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
    expect(startSession.indexOf("options?.onFailure?.(")).toBeGreaterThan(
      startSession.lastIndexOf("ownsWorkspaceOperation("),
    );
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
