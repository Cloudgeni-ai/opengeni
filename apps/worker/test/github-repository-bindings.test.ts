// Turn-time GitHub App binding resolution for bare repository URIs. A bare
// github.com resource (API caller, older session, or a child inheriting its
// parent's resources) must resolve to the workspace allowlist before the
// credential mint and the runtime clone plan derive binding ids from the same
// resource set, and an unusable bound repository must stay bare with a visible
// warning rather than failing the turn.

import { describe, expect, test } from "bun:test";
import type { ResourceRef } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  gitHubRepositoryBindingWarning,
  resolveTurnGitHubRepositoryBindings,
} from "../src/activities/agent-turn/github-repository-bindings";
import { gitHubTokenMintSelections } from "../src/activities/environment";

const db = {} as Database;

const repo = (overrides: Record<string, unknown> = {}): ResourceRef =>
  ({
    kind: "repository",
    uri: "https://github.com/acme/app.git",
    ref: "main",
    mountPath: "repos/github.com/acme/app",
    ...overrides,
  }) as ResourceRef;

const candidates = async () => [
  { installationId: 123, accountLogin: "acme", repositoryIds: [456] },
];

describe("resolveTurnGitHubRepositoryBindings", () => {
  test("stamps a bound public repository so the mint path selects a scoped token", async () => {
    const lookups: unknown[] = [];
    const result = await resolveTurnGitHubRepositoryBindings({
      db,
      settings: testSettings(),
      workspaceId: "ws",
      resources: [repo()],
      listCandidates: candidates,
      lookup: async (input) => {
        lookups.push(input);
        return { id: 456 };
      },
    });
    expect(result.resources).toEqual([
      repo({ provider: "github", githubInstallationId: 123, githubRepositoryId: 456 }),
    ]);
    expect(result.warnings).toEqual([]);
    expect(lookups).toEqual([{ installationId: 123, owner: "acme", name: "app" }]);
    // The exact selection the worker mints (and the revocation recheck covers).
    expect(gitHubTokenMintSelections(result.resources)).toEqual([
      { installationId: 123, repositoryIds: [456] },
    ]);
    // Runtime resources (session repositories + this turn's files) receive the
    // same stamping, so the credential-helper binding hash matches the token file.
    expect(
      result.apply([repo(), { kind: "file", fileId: "11111111-1111-4111-8111-111111111111" }]),
    ).toEqual([
      repo({ provider: "github", githubInstallationId: 123, githubRepositoryId: 456 }),
      { kind: "file", fileId: "11111111-1111-4111-8111-111111111111" },
    ]);
  });

  test("keeps an unbound public repository anonymous without touching GitHub", async () => {
    const result = await resolveTurnGitHubRepositoryBindings({
      db,
      settings: testSettings(),
      workspaceId: "ws",
      resources: [repo({ uri: "https://github.com/other-org/lib.git" })],
      listCandidates: candidates,
      lookup: async () => {
        throw new Error("must not be called for an unbound owner");
      },
    });
    expect(result.resources).toEqual([repo({ uri: "https://github.com/other-org/lib.git" })]);
    expect(result.warnings).toEqual([]);
    expect(gitHubTokenMintSelections(result.resources)).toEqual([]);
  });

  test("reports a bound owner's non-allowlisted repository and keeps it bare", async () => {
    const result = await resolveTurnGitHubRepositoryBindings({
      db,
      settings: testSettings(),
      workspaceId: "ws",
      resources: [repo({ uri: "https://github.com/acme/not-selected.git" })],
      listCandidates: candidates,
      lookup: async () => ({ id: 999 }),
    });
    expect(result.resources).toEqual([repo({ uri: "https://github.com/acme/not-selected.git" })]);
    expect(result.warnings).toEqual([
      {
        credentialClass: "run",
        providerDomain: "github.com",
        reason: "insufficient_scope",
        resource: "https://github.com/acme/not-selected.git",
        message: expect.stringContaining("acme/not-selected is not in the repository allowlist"),
      },
    ]);
  });

  test("reports an unavailable lookup instead of failing the turn", async () => {
    const result = await resolveTurnGitHubRepositoryBindings({
      db,
      settings: testSettings(),
      workspaceId: "ws",
      resources: [repo()],
      listCandidates: candidates,
      lookup: async () => {
        throw new Error("GitHub API 403: This installation has been suspended");
      },
    });
    expect(result.resources).toEqual([repo()]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        reason: "refresh_failed",
        resource: "https://github.com/acme/app.git",
        message: expect.stringContaining("This installation has been suspended"),
      }),
    ]);
  });

  test("does not query bindings or GitHub when no resource is a bare GitHub repository", async () => {
    const result = await resolveTurnGitHubRepositoryBindings({
      db,
      settings: testSettings(),
      workspaceId: "ws",
      resources: [
        repo({ githubInstallationId: 123, githubRepositoryId: 456 }),
        repo({ uri: "https://gitlab.com/acme/app.git", provider: "gitlab" }),
      ],
      listCandidates: async () => {
        throw new Error("must not list bindings");
      },
      lookup: async () => {
        throw new Error("must not call GitHub");
      },
    });
    expect(result.resources).toEqual([
      repo({ githubInstallationId: 123, githubRepositoryId: 456 }),
      repo({ uri: "https://gitlab.com/acme/app.git", provider: "gitlab" }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  test("skips resolution when the GitHub App cannot mint tokens on this deployment", async () => {
    const result = await resolveTurnGitHubRepositoryBindings({
      db,
      settings: testSettings({
        githubAppId: undefined,
        githubAppPrivateKey: undefined,
      } as any),
      workspaceId: "ws",
      resources: [repo()],
      listCandidates: async () => {
        throw new Error("must not list bindings without an App");
      },
    });
    expect(result.resources).toEqual([repo()]);
    expect(result.warnings).toEqual([]);
  });
});

describe("gitHubRepositoryBindingWarning", () => {
  test("is silent for resolved and unbound repositories", () => {
    const base = { uri: "https://github.com/acme/app.git", owner: "acme", name: "app" };
    expect(
      gitHubRepositoryBindingWarning({
        ...base,
        outcome: { status: "resolved", binding: { installationId: 1, repositoryId: 2 } },
      }),
    ).toBeNull();
    expect(gitHubRepositoryBindingWarning({ ...base, outcome: { status: "unbound" } })).toBeNull();
    expect(
      gitHubRepositoryBindingWarning({
        ...base,
        outcome: { status: "ambiguous", installationIds: [1, 2] },
      }),
    ).toMatchObject({ reason: "insufficient_scope", message: expect.stringContaining("1, 2") });
  });
});
