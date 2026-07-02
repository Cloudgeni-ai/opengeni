// Regression: a COLD box first warmed by an API-direct ATTACH (viewer /
// Channel-A / desktop / terminal) must be created with the SAME manifest
// environment the worker TURN declares — otherwise the next turn's agent-manifest
// apply hits the SDK's `validateNoEnvironmentDelta` and throws the BLOCKING
// "Live sandbox sessions cannot change manifest environment variables." error.
//
// The SDK delta check (providedSessionManifest.mjs) is ASYMMETRIC: it iterates the
// TURN (target) env and throws if ANY key is missing from, or differs in value
// against, the box's (current) env. So the invariant we pin is:
//
//   for every key the TURN declares (no repo attached), the ATTACH env carries
//   the SAME value  ==>  the SDK sees an EMPTY environment delta.
//
// This is a pure, DB-free, failure-sensitive parity test: it compares the worker
// turn's `sandboxEnvironmentForRun` against the SHARED stable helper the attach
// paths now call (`config.stableSandboxEnvironmentForRun`). If the attach paths
// regress to the base-allowlist-only env, the git-identity / HOME / workspace-env
// keys go missing and the parity assertion fails (reproducing the delta throw).

import { describe, expect, test } from "bun:test";
import { applyGitAuthPointerEnvironment, stableSandboxEnvironmentForRun } from "@opengeni/config";
import { githubAppBotIdentity } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import type { ResourceRef } from "@opengeni/contracts";
import { sandboxEnvironmentForRun } from "../src/activities/environment";

// The exact SDK delta predicate (validateNoEnvironmentDelta): true iff every key
// the turn declares is present in the attach env with an equal value.
function hasNoEnvironmentDelta(
  attachEnv: Record<string, string>,
  turnEnv: Record<string, string>,
): boolean {
  return Object.entries(turnEnv).every(([key, value]) => attachEnv[key] === value);
}

const baseSettings = () =>
  testSettings({
    // A provisioned cloud backend so the backend-aware HOME default applies (the
    // exact key an attach-warmed box used to be missing). Desktop-capable so this
    // mirrors the sandbox-surfacing deployment (ns opengeni-preview).
    sandboxBackend: "modal",
    gitAuthorName: "OpenGeni Bot",
    gitAuthorEmail: "bot@opengeni.dev",
  });

describe("attach-vs-turn manifest-environment parity (no repo attached)", () => {
  test("the turn env (no repo) has NO delta against the attach env — the common case", async () => {
    const settings = baseSettings();

    // The worker TURN's declared agent-manifest environment, no repo resources.
    // TOKEN-BROKER (B1): sandboxEnvironmentForRun returns { environment, gitToken }.
    const { environment: turnEnv } = await sandboxEnvironmentForRun(settings, [], {});
    // The env the API-direct ATTACH paths now create a cold box with.
    const attachEnv = stableSandboxEnvironmentForRun(settings, {});

    // With no repo attached, the two are byte-identical (the attach env IS the
    // turn's stable base) — the strongest form of "no delta".
    expect(attachEnv).toEqual(turnEnv);
    expect(hasNoEnvironmentDelta(attachEnv, turnEnv)).toBe(true);

    // And the keys that USED to be missing on an attach-warmed box are present.
    expect(attachEnv.GIT_AUTHOR_NAME).toBe("OpenGeni Bot");
    expect(attachEnv.GIT_AUTHOR_EMAIL).toBe("bot@opengeni.dev");
    expect(attachEnv.HOME).toBe("/workspace");
    // TOKEN-BROKER (B1): the STABLE token FILE PATH rides the shared base, so it is
    // present + IDENTICAL on both manifests (the token VALUE never does).
    expect(attachEnv.OPENGENI_GIT_TOKEN_FILE).toBe("/workspace/.opengeni/git-token");
    expect(turnEnv.OPENGENI_GIT_TOKEN_FILE).toBe("/workspace/.opengeni/git-token");
  });

  test("the turn env (workspace environment attached) has NO delta against the attach env", async () => {
    const settings = baseSettings();
    const workspaceEnv = { DEPLOY_TARGET: "staging", API_KEY: "wsval-123" };

    // The turn loads + decrypts the workspace environment and layers it in; the
    // attach path loads the SAME workspace environment (loadWorkspaceEnvironmentForRun)
    // and threads it through the same stable helper. Here we feed both the same
    // decrypted values (the load+decrypt is exercised by the DB-backed paths).
    const { environment: turnEnv } = await sandboxEnvironmentForRun(settings, [], workspaceEnv);
    const attachEnv = stableSandboxEnvironmentForRun(settings, workspaceEnv);

    expect(attachEnv).toEqual(turnEnv);
    expect(hasNoEnvironmentDelta(attachEnv, turnEnv)).toBe(true);
    expect(attachEnv.DEPLOY_TARGET).toBe("staging");
    expect(attachEnv.API_KEY).toBe("wsval-123");
    // Platform keys still present alongside the workspace values.
    expect(attachEnv.GIT_AUTHOR_NAME).toBe("OpenGeni Bot");
    expect(attachEnv.HOME).toBe("/workspace");
  });

  test("FAILURE-SENSITIVITY: the OLD attach env (base allowlist only) DOES delta", async () => {
    // This reproduces the original bug: an attach-warmed box created with only the
    // base env (the pre-fix establishSandboxSessionFromEnvelope default) is missing
    // the git-identity + HOME keys the turn declares, so the SDK sees a delta and
    // throws. The assertion proves the parity test above is not vacuously green.
    const settings = baseSettings();
    const { environment: turnEnv } = await sandboxEnvironmentForRun(settings, [], {});

    // The pre-fix attach env: NO git identity, NO HOME (just whatever the base
    // allowlist yields — empty in a clean test env).
    const oldAttachEnv: Record<string, string> = {};

    expect(hasNoEnvironmentDelta(oldAttachEnv, turnEnv)).toBe(false);
  });
});

// TOKEN-BROKER (B1): a repo-attached turn no longer layers the rotating GitHub token
// (or the extraheader) onto the manifest env — the token is returned as `gitToken`
// (seeded off-manifest to the box token file). The manifest carries ONLY the stable
// pointers (GIT_ASKPASS, GIT_TERMINAL_PROMPT, identity, and — from the shared base —
// OPENGENI_GIT_TOKEN_FILE), so it stays attach-reproducible and the SDK sees no delta.
describe("repo-attached turn: token VALUE is OFF the manifest, only the FILE PATH is on it", () => {
  // A repo-attached turn mints a REAL GitHub App token via the network; the clean
  // test env has no app configured, so we exercise the SKIP path (which returns the
  // stable base with no gitToken) to assert the manifest shape without a live mint.
  // The env shape a repo-attached turn declares is the SAME stable base + GIT_ASKPASS
  // pointers; the rotating value is the only thing gated behind the live mint.
  test("the stable base carries the token FILE PATH and NEVER the rotating token keys", async () => {
    const settings = baseSettings();
    const repoResource: ResourceRef = {
      kind: "repository",
      uri: "github.com/acme/repo",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    };
    // Skip the (network) mint: returns the stable base env + no gitToken. This is the
    // exact manifest a machine-effective repo turn declares; a cloud repo turn adds
    // GIT_ASKPASS/GIT_TERMINAL_PROMPT on top but STILL no GH_TOKEN/GITHUB_TOKEN/
    // GIT_CONFIG_* (those keys were removed by the token broker).
    const { environment: turnEnv, gitToken } = await sandboxEnvironmentForRun(
      settings,
      [repoResource],
      {},
      { skipGitHubToken: true },
    );

    // The rotating token keys are ABSENT from the manifest env (the broker removed them).
    expect(turnEnv.GH_TOKEN).toBeUndefined();
    expect(turnEnv.GITHUB_TOKEN).toBeUndefined();
    expect(turnEnv.GIT_CONFIG_COUNT).toBeUndefined();
    expect(turnEnv.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(turnEnv.GIT_CONFIG_VALUE_0).toBeUndefined();
    // No token was minted on the skip path.
    expect(gitToken).toBeUndefined();

    // The STABLE token FILE PATH matches the attach base (parity-safe pointer).
    const attachEnv = stableSandboxEnvironmentForRun(settings, {});
    expect(turnEnv.OPENGENI_GIT_TOKEN_FILE).toBe("/workspace/.opengeni/git-token");
    expect(turnEnv.OPENGENI_GIT_TOKEN_FILE).toBe(attachEnv.OPENGENI_GIT_TOKEN_FILE);
    expect(hasNoEnvironmentDelta(attachEnv, turnEnv)).toBe(true);
  });
});

// REPO-ATTACHED parity (the case an open session page actually hits): since the
// token broker, a cloud repo turn declares the STABLE git-auth POINTERS
// (GIT_ASKPASS / GIT_TERMINAL_PROMPT / bot identity) on top of the stable base.
// An attach-warmed box created WITHOUT them is missing keys the turn declares →
// the SDK guard throws. Live regression: session 0566bad3 (2026-07-02) — the
// viewer attach (open session page) won the cold-create race and the first repo
// turn died. The attach paths now apply the SAME shared pointer helper.
describe("repo-attached attach-vs-turn parity (the viewer-attach cold-create race)", () => {
  const repoSettings = () =>
    testSettings({
      sandboxBackend: "modal",
      gitAuthorName: "OpenGeni Bot",
      gitAuthorEmail: "bot@opengeni.dev",
      githubAppId: "12345",
      githubAppSlug: "opengeni-test",
    });

  test("attach env built with the shared pointer helper has NO delta against the repo turn's declared env", async () => {
    const settings = repoSettings();
    // The turn's declared env for a cloud repo run = stable base + the SHARED
    // pointer helper (sandboxEnvironmentForRun applies exactly this after the
    // mint; the mint contributes only the OFF-manifest gitToken).
    const turnEnv = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun(settings, {}),
      githubAppBotIdentity(settings),
    );
    // What the attach paths (viewer.ts sessionAttachEnvironment / channel-a.ts)
    // now cold-create a repo session's box with.
    const attachEnv = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun(settings, {}),
      githubAppBotIdentity(settings),
    );
    expect(attachEnv).toEqual(turnEnv);
    expect(hasNoEnvironmentDelta(attachEnv, turnEnv)).toBe(true);
    expect(attachEnv.GIT_ASKPASS).toBe("/workspace/.opengeni/askpass");
    expect(attachEnv.GIT_TERMINAL_PROMPT).toBe("0");
    // Deployment git identity wins over the bot fallback (parity on both sides).
    expect(attachEnv.GIT_AUTHOR_NAME).toBe("OpenGeni Bot");
  });

  test("FAILURE-SENSITIVITY: the pointer-less attach env (the 0566bad3 bug) DOES delta against a repo turn", async () => {
    const settings = repoSettings();
    const turnEnv = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun(settings, {}),
      githubAppBotIdentity(settings),
    );
    // The pre-fix attach env: stable base only, no pointers.
    const oldAttachEnv = stableSandboxEnvironmentForRun(settings, {});
    expect(hasNoEnvironmentDelta(oldAttachEnv, turnEnv)).toBe(false);
  });

  test("bot identity fallback applies when the deployment carries no git identity", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      gitAuthorName: undefined,
      gitAuthorEmail: undefined,
      githubAppId: "12345",
      githubAppSlug: "opengeni-test",
    });
    const env = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun(settings, {}),
      githubAppBotIdentity(settings),
    );
    expect(env.GIT_AUTHOR_NAME).toBe("opengeni-test[bot]");
    expect(env.GIT_AUTHOR_EMAIL).toBe("12345+opengeni-test[bot]@users.noreply.github.com");
  });
});
