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
import { stableSandboxEnvironmentForRun } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
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
    const turnEnv = await sandboxEnvironmentForRun(settings, [], {});
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
  });

  test("the turn env (workspace environment attached) has NO delta against the attach env", async () => {
    const settings = baseSettings();
    const workspaceEnv = { DEPLOY_TARGET: "staging", API_KEY: "wsval-123" };

    // The turn loads + decrypts the workspace environment and layers it in; the
    // attach path loads the SAME workspace environment (loadWorkspaceEnvironmentForRun)
    // and threads it through the same stable helper. Here we feed both the same
    // decrypted values (the load+decrypt is exercised by the DB-backed paths).
    const turnEnv = await sandboxEnvironmentForRun(settings, [], workspaceEnv);
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
    const turnEnv = await sandboxEnvironmentForRun(settings, [], {});

    // The pre-fix attach env: NO git identity, NO HOME (just whatever the base
    // allowlist yields — empty in a clean test env).
    const oldAttachEnv: Record<string, string> = {};

    expect(hasNoEnvironmentDelta(oldAttachEnv, turnEnv)).toBe(false);
  });
});
