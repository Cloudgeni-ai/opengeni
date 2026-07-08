// Regression: the viewer-attach cold-create path must declare the SAME stable
// git-auth pointer env a repo turn does (GIT_ASKPASS / GIT_TERMINAL_PROMPT / bot
// identity) — an attach-warmed box missing those keys kills the next repo turn on
// the SDK's "Live sandbox sessions cannot change manifest environment variables"
// guard. Live instance: session 0566bad3 (2026-07-02) — the open session page's
// viewer attach won the cold-create race against the first turn.
//
// DB-free: sessionAttachEnvironment only touches the db when the session has an
// environmentId (loadWorkspaceEnvironmentForRun returns early on null).

import { describe, expect, test } from "bun:test";
import { applyGitAuthPointerEnvironment, stableSandboxEnvironmentForRun } from "@opengeni/config";
import { githubAppBotIdentity } from "@opengeni/github";
import type { Session } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { sessionAttachEnvironment } from "../src/sandbox/viewer";

const settings = testSettings({
  sandboxBackend: "modal",
  gitAuthorName: "OpenGeni Bot",
  gitAuthorEmail: "bot@opengeni.dev",
  githubAppId: "12345",
  githubAppSlug: "opengeni-test",
});

function sessionWith(resources: Session["resources"], sandboxBackend = "modal"): Session {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    environmentId: null,
    sandboxBackend,
    resources,
  } as unknown as Session;
}

const services = { db: null as never, settings, bus: null as never } as never;

describe("sessionAttachEnvironment — repo-attached git-pointer parity", () => {
  test("a GitHub-App repo session's attach env carries the stable git-auth pointers the turn declares", async () => {
    const attachEnv = await sessionAttachEnvironment(services, "ws", sessionWith([{
      kind: "repository",
      uri: "https://github.com/acme/repo.git",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    }]));
    const expected = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun(settings, {}),
      githubAppBotIdentity(settings),
    );
    expect(attachEnv).toEqual(expected);
    expect(attachEnv.GIT_ASKPASS).toBe("/workspace/.opengeni/askpass");
    expect(attachEnv.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("a session with NO GitHub-App repo keeps the plain stable base (no pointers)", async () => {
    const attachEnv = await sessionAttachEnvironment(services, "ws", sessionWith([]));
    expect(attachEnv).toEqual(stableSandboxEnvironmentForRun(settings, {}));
    expect(attachEnv.GIT_ASKPASS).toBeUndefined();
  });

  test("a non-GitHub brokered repo gets git auth pointers without GitHub bot identity", async () => {
    const attachEnv = await sessionAttachEnvironment(services, "ws", sessionWith([{
      kind: "repository",
      uri: "https://gitlab.com/acme/repo.git",
      ref: "main",
      provider: "gitlab",
      repositoryId: "gl-123",
    }]));
    const expected = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun(settings, {}),
      null,
    );
    expect(attachEnv).toEqual(expected);
    expect(attachEnv.GIT_ASKPASS).toBe("/workspace/.opengeni/askpass");
    expect(attachEnv.GIT_AUTHOR_NAME).toBe("OpenGeni Bot");
    expect(attachEnv.GIT_AUTHOR_EMAIL).toBe("bot@opengeni.dev");
  });

  test("the attach env is keyed off the SESSION's backend, not the deployment default (HOME + pointers move with it)", async () => {
    // The box is established with backendOverride: session.sandboxBackend and the
    // turn builds its env from the session's backend too — an attach env keyed
    // off the deployment default would cold-create an e2b session's box with
    // /workspace-rooted HOME/token-file/askpass while the turn declares
    // /home/user-rooted ones, the same guard-killed first turn again.
    const attachEnv = await sessionAttachEnvironment(services, "ws", sessionWith([{
      kind: "repository",
      uri: "https://github.com/acme/repo.git",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    }], "e2b"));
    const expected = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun({ ...settings, sandboxBackend: "e2b" }, {}),
      githubAppBotIdentity(settings),
    );
    expect(attachEnv).toEqual(expected);
    expect(attachEnv.HOME).toBe("/home/user");
    expect(attachEnv.OPENGENI_GIT_TOKEN_FILE).toBe("/home/user/.opengeni/git-token");
    expect(attachEnv.GIT_ASKPASS).toBe("/home/user/.opengeni/askpass");
  });

  test("a plain-URI repo (no installation ids) does not trigger the pointers — mirrors the turn's selection predicate", async () => {
    const attachEnv = await sessionAttachEnvironment(services, "ws", sessionWith([{
      kind: "repository",
      uri: "https://github.com/acme/public.git",
      ref: "main",
    }]));
    expect(attachEnv.GIT_ASKPASS).toBeUndefined();
  });
});
