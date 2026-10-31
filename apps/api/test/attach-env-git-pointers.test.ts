// Regression: the viewer-attach cold-create path must declare the SAME stable
// git-auth pointer env a repo turn does (GIT_ASKPASS / GIT_TERMINAL_PROMPT) — an attach-warmed box missing those keys kills the next repo turn on
// the SDK's "Live sandbox sessions cannot change manifest environment variables"
// guard. Live instance: session 0566bad3 (2026-07-02) — the open session page's
// viewer attach won the cold-create race against the first turn.
//
// DB-free: sessionAttachEnvironment derives the environment from settings only.

import { describe, expect, test } from "bun:test";
import { applyGitAuthPointerEnvironment, stableSandboxEnvironmentForRun } from "@opengeni/config";
import type { Session } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { sessionAttachEnvironment } from "../src/sandbox/viewer";

const settings = testSettings({
  sandboxBackend: "modal",
  gitAuthorName: "Opengeni Bot",
  gitAuthorEmail: "bot@opengeni.dev",
  githubAppId: "12345",
  githubAppSlug: "opengeni-test",
});

function sessionWith(resources: Session["resources"], sandboxBackend = "modal"): Session {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    sandboxBackend,
    resources,
  } as unknown as Session;
}

const services = { db: null as never, settings, bus: null as never } as never;

describe("sessionAttachEnvironment — repo-attached git-pointer parity", () => {
  test("a GitHub-App repo session's attach env carries the stable git-auth pointers the turn declares", async () => {
    const attachEnv = await sessionAttachEnvironment(
      services,
      "ws",
      sessionWith([
        {
          kind: "repository",
          uri: "https://github.com/acme/repo.git",
          ref: "main",
          githubInstallationId: 123,
          githubRepositoryId: 456,
        },
      ]),
      null,
    );
    const expected = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun(settings, { workspaceId: "ws" }),
    );
    expect(attachEnv).toEqual(expected);
    expect(attachEnv.GIT_ASKPASS).toBe("/workspace/.opengeni/askpass");
    expect(attachEnv.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("a session with NO GitHub-App repo keeps the plain stable base (no pointers)", async () => {
    const attachEnv = await sessionAttachEnvironment(services, "ws", sessionWith([]), null);
    expect(attachEnv).toEqual(stableSandboxEnvironmentForRun(settings, { workspaceId: "ws" }));
    expect(attachEnv.GIT_ASKPASS).toBeUndefined();
  });

  test("a non-GitHub brokered repo gets git auth pointers without GitHub bot identity", async () => {
    const attachEnv = await sessionAttachEnvironment(
      services,
      "ws",
      sessionWith([
        {
          kind: "repository",
          uri: "https://gitlab.com/acme/repo.git",
          ref: "main",
          provider: "gitlab",
          repositoryId: "gl-123",
        },
      ]),
      null,
    );
    const expected = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun(settings, { workspaceId: "ws" }),
    );
    expect(attachEnv).toEqual(expected);
    expect(attachEnv.GIT_ASKPASS).toBe("/workspace/.opengeni/askpass");
    expect(attachEnv.GIT_AUTHOR_NAME).toBe("Opengeni Bot");
    expect(attachEnv.GIT_AUTHOR_EMAIL).toBe("bot@opengeni.dev");
  });

  test("a personal-GitHub session's attach env never carries the App bot identity", async () => {
    // Regression: the viewer used to cold-create any GitHub-repo session's box
    // with the bot identity, so a personal-only session whose viewer won the
    // cold-create race committed as the bot for the box's whole life.
    const noDeploymentIdentity = testSettings({
      sandboxBackend: "modal",
      gitAuthorName: undefined,
      gitAuthorEmail: undefined,
      githubAppId: "12345",
      githubAppSlug: "opengeni-test",
    });
    const attachEnv = await sessionAttachEnvironment(
      { db: null as never, settings: noDeploymentIdentity, bus: null as never } as never,
      "ws",
      sessionWith([
        {
          kind: "repository",
          uri: "https://github.com/octocat/private-repository",
          ref: "main",
          provider: "github",
          connectionType: "github_personal",
          credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          repositoryId: "9007199254740993123",
          access: "write",
        },
        {
          kind: "repository",
          uri: "https://github.com/acme/repo.git",
          ref: "main",
          githubInstallationId: 123,
          githubRepositoryId: 456,
        },
      ]),
      null,
    );
    expect(attachEnv.GIT_ASKPASS).toBe("/workspace/.opengeni/askpass");
    expect(attachEnv.GIT_AUTHOR_NAME).toBeUndefined();
    expect(attachEnv.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(attachEnv.GIT_COMMITTER_NAME).toBeUndefined();
    expect(attachEnv.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  test("the attach env is keyed off the SESSION's backend, not the deployment default (HOME + pointers move with it)", async () => {
    // The box is established with backendOverride: session.sandboxBackend and the
    // turn builds its env from the session's backend too — an attach env keyed
    // off the deployment default would cold-create an e2b session's box with
    // /workspace-rooted HOME/token-file/askpass while the turn declares
    // /home/user ones, the same guard-killed first turn again.
    const attachEnv = await sessionAttachEnvironment(
      services,
      "ws",
      sessionWith(
        [
          {
            kind: "repository",
            uri: "https://github.com/acme/repo.git",
            ref: "main",
            githubInstallationId: 123,
            githubRepositoryId: 456,
          },
        ],
        "e2b",
      ),
    );
    const expected = applyGitAuthPointerEnvironment(
      stableSandboxEnvironmentForRun({ ...settings, sandboxBackend: "e2b" }, { workspaceId: "ws" }),
    );
    expect(attachEnv).toEqual(expected);
    expect(attachEnv.HOME).toBe("/home/user");
    expect(attachEnv.OPENGENI_GIT_TOKEN_FILE).toBe("/home/user/.opengeni/git-token");
    expect(attachEnv.GIT_ASKPASS).toBe("/home/user/.opengeni/askpass");
  });

  test("a plain-URI repo (no installation ids) does not trigger the pointers — mirrors the turn's selection predicate", async () => {
    const attachEnv = await sessionAttachEnvironment(
      services,
      "ws",
      sessionWith([
        {
          kind: "repository",
          uri: "https://github.com/acme/public.git",
          ref: "main",
        },
      ]),
      null,
    );
    expect(attachEnv.GIT_ASKPASS).toBeUndefined();
  });
});
