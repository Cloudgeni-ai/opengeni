// Stage D (machine-primary, B + D1-lite) — the DB-free unit surface.
//
// Covers the three load-bearing seams a real hosted turn would otherwise be the
// only witness to:
//   (B)  sandboxEnvironmentForRun skips platform Git and keeps Codemode material
//        out of the machine manifest when the effective backend is connected.
//   (D1) establishSelfhostedTurnSession binds the live machine session DIRECTLY —
//        no Modal box, env threaded into the manifest (env-parity), agent id + cwd
//        bound — so a machine-primary turn never establishes or leases a phantom box.
//   (warm-rate) the warm meter, keyed off the EFFECTIVE backend, accrues ZERO
//        cost for selfhosted even when a cloud rate is configured (the money bug).

import { describe, expect, test } from "bun:test";
import { sandboxWarmRateMicrosPerSecond } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import type { ResourceRef } from "@opengeni/contracts";
import { sandboxEnvironmentForRun } from "../src/activities/environment";
import { establishSelfhostedTurnSession } from "../src/sandbox-routing";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_INSTANCE_ID = "33333333-3333-4333-8333-333333333333";
const EMPTY_OPERATION_POLICY = {
  memoryMaxBytes: null,
  memoryHighBytes: null,
  cpuMaxMillicores: null,
  revision: 0,
  updatedAt: null,
} as const;

const repoResource = (): ResourceRef => ({
  kind: "repository",
  uri: "https://github.com/acme/repo",
  ref: "main",
  githubInstallationId: 123,
  githubRepositoryId: 456,
});

const cloudSettings = () =>
  testSettings({
    sandboxBackend: "modal",
    gitAuthorName: "OpenGeni Bot",
    gitAuthorEmail: "bot@opengeni.dev",
  });

describe("change B — sandboxEnvironmentForRun transient delivery for a machine turn", () => {
  test("a repo-attached machine turn skips platform Git and Codemode manifest pointers", async () => {
    const settings = cloudSettings();
    // A repo resource normally triggers the run-scoped GitHub App token mint. With
    // skipGitHubToken (the effective backend is a connected machine) the mint is
    // skipped entirely — no network, no GH_TOKEN — and the STABLE base env is
    // returned. The machine uses its own git creds; exec routes over NATS.
    // TOKEN-BROKER (B1): sandboxEnvironmentForRun returns { environment, gitToken }.
    const { environment: env, gitToken } = await sandboxEnvironmentForRun(
      settings,
      [repoResource()],
      {},
      { skipGitHubToken: true, codemodeDelivery: "transient_exec" },
    );
    expect(gitToken).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.OPENGENI_CODEMODE_URL).toBeUndefined();
    expect(env.OPENGENI_CODEMODE_TOKEN_FILE).toBeUndefined();
    expect(env.OPENGENI_OGTOOL_PACKAGE_SPEC).toBeUndefined();
    // The stable base (git identity + HOME) is intact — the SAME object feeds the
    // box manifest + the agent, so env-parity holds.
    expect(env.GIT_AUTHOR_NAME).toBe("OpenGeni Bot");
    expect(env.HOME).toBe("/workspace");
  });

  test("the SAME repo-attached turn STILL mints for cloud (no skip) — proven by reaching the mint", async () => {
    const settings = cloudSettings();
    // With NO skip (a cloud turn) the repo selection drives the token mint; the
    // clean test env has no GitHub App configured, so reaching the mint throws the
    // configuration error. That throw IS the proof the cloud path still mints (vs the
    // clean return above). Failure-sensitive: were the skip applied unconditionally,
    // this would resolve instead of throwing.
    await expect(sandboxEnvironmentForRun(settings, [repoResource()], {})).rejects.toThrow();
  });

  test("no repo attached: skip flag is a no-op (the base env either way)", async () => {
    const settings = cloudSettings();
    const withSkip = await sandboxEnvironmentForRun(settings, [], {}, { skipGitHubToken: true });
    const withoutSkip = await sandboxEnvironmentForRun(
      settings,
      [],
      {},
      { skipGitHubToken: false },
    );
    expect(withSkip).toEqual(withoutSkip);
    expect(withSkip.environment.GH_TOKEN).toBeUndefined();
    expect(withSkip.gitToken).toBeUndefined();
  });
});

describe("warm-rate keyed off the EFFECTIVE backend (selfhosted bills zero)", () => {
  test("selfhosted resolves to 0 even when a cloud (modal) rate is configured", () => {
    const settings = testSettings({
      sandboxWarmRateMicrosPerSecondJson: JSON.stringify({ modal: 50 }),
    });
    // A machine-primary turn keys the warm meter off "selfhosted" (the effective
    // backend), which has no configured rate → 0. Keying off the home backend
    // ("modal", 50) would bill cloud seconds for a box that does not exist.
    expect(sandboxWarmRateMicrosPerSecond(settings, "selfhosted")).toBe(0);
    expect(sandboxWarmRateMicrosPerSecond(settings, "modal")).toBe(50);
  });
});

describe("D1-lite — establishSelfhostedTurnSession binds the machine, no Modal box", () => {
  const settings = () =>
    testSettings({ sandboxSelfhostedEnabled: true, selfhostedRelayUrl: "wss://relay.example" });

  test("binds the SelfhostedSession directly (backendId selfhosted, agent id + env + cwd threaded) — no Modal client", async () => {
    const env = { HOME: "/workspace", GIT_AUTHOR_NAME: "OpenGeni Bot", DEPLOY_TARGET: "vm1" };
    const established = await establishSelfhostedTurnSession(
      // db is never touched on this path (no lease here); bus undefined ⇒ the control
      // RPC is offline-until-bound, and resume() is a pure subject re-address (no NATS).
      { db: null as never, settings: settings(), bus: undefined },
      {
        accountId: ACCOUNT_ID,
        workspaceId: "ws-1",
        sessionId: SESSION_ID,
        agentId: "enr_1",
        connectionInstanceId: CONNECTION_INSTANCE_ID,
        workspaceRoot: "/home/user/repo",
        opStream: false,
        operationResourcePolicy: EMPTY_OPERATION_POLICY,
        operationResourcePolicySupported: false,
        operationCpuQuotaSupported: false,
        epoch: 4,
        environment: env,
        workingDir: "/home/user/repo",
      },
    );

    // NO Modal box: the established backend is the machine itself.
    expect(established.backendId).toBe("selfhosted");
    expect(established.instanceId).toBe("enr_1");
    // The owned-sandbox client is the selfhosted client (its serializeSessionState
    // round-trips {agentId}); never a Modal SandboxClient.
    expect((established.client as { backendId?: string }).backendId).toBe("selfhosted");

    const state = (
      established.session as {
        state: {
          agentId: string;
          environment: Record<string, string>;
          manifest: { root: string; resolveEnvironment(): Promise<Record<string, string>> };
        };
      }
    ).state;
    expect(state.agentId).toBe("enr_1");
    // Env threaded onto BOTH the SDK state env AND the manifest env → the SDK's
    // per-turn provided-session env delta is empty (no "cannot change manifest
    // environment variables" throw on the machine-primary turn).
    expect(state.environment).toEqual(env);
    expect(state.manifest.root).toBe("/home/user/repo");
    expect(await state.manifest.resolveEnvironment()).toEqual(env);
  });

  test("serializeSessionState round-trips {agentId} only (selfhosted is re-addressed, never snapshotted)", async () => {
    const established = await establishSelfhostedTurnSession(
      { db: null as never, settings: settings(), bus: undefined },
      {
        accountId: ACCOUNT_ID,
        workspaceId: "ws-1",
        sessionId: SESSION_ID,
        agentId: "enr_xyz",
        connectionInstanceId: CONNECTION_INSTANCE_ID,
        workspaceRoot: "/home/user/repo",
        opStream: false,
        operationResourcePolicy: EMPTY_OPERATION_POLICY,
        operationResourcePolicySupported: false,
        operationCpuQuotaSupported: false,
        epoch: 1,
        environment: {},
        workingDir: null,
      },
    );
    const serialized = await (
      established.session as { serializeSessionState(): Promise<{ agentId: string }> }
    ).serializeSessionState();
    expect(serialized).toEqual({ agentId: "enr_xyz" });
  });
});
