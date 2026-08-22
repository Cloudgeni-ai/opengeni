// Turn-time GitHub App binding resolution for bare repository URIs. A bare
// github.com resource (API caller, older session, or a child inheriting its
// parent's resources) must resolve to the workspace allowlist before the
// credential mint and the runtime clone plan derive binding ids from the same
// resource set, and an unusable bound repository must stay bare with a visible
// warning rather than failing the turn.

import { describe, expect, test } from "bun:test";
import type { CredentialAuthNeededPayload, ResourceRef } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { mergeResourceRefs } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  applyTurnGitHubRepositoryBindings,
  cachedGitHubRepositoryBindingLookup,
  createGitHubRepositoryLookupCache,
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

const stamped = (overrides: Record<string, unknown> = {}): ResourceRef =>
  repo({ provider: "github", githubInstallationId: 123, githubRepositoryId: 456, ...overrides });

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
      lookupCache: createGitHubRepositoryLookupCache(),
    });
    expect(result.resources).toEqual([stamped()]);
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
    ).toEqual([stamped(), { kind: "file", fileId: "11111111-1111-4111-8111-111111111111" }]);
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
      lookupCache: createGitHubRepositoryLookupCache(),
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
      lookupCache: createGitHubRepositoryLookupCache(),
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
      lookupCache: createGitHubRepositoryLookupCache(),
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
      resources: [stamped(), repo({ uri: "https://gitlab.com/acme/app.git", provider: "gitlab" })],
      listCandidates: async () => {
        throw new Error("must not list bindings");
      },
      lookup: async () => {
        throw new Error("must not call GitHub");
      },
    });
    expect(result.resources).toEqual([
      stamped(),
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

describe("cachedGitHubRepositoryBindingLookup", () => {
  test("memoizes positive and negative answers per workspace/installation/repository until the TTL", async () => {
    let clock = 1_000;
    const calls: string[] = [];
    const cache = createGitHubRepositoryLookupCache();
    const lookup = cachedGitHubRepositoryBindingLookup({
      workspaceId: "ws",
      cache,
      now: () => clock,
      ttlMs: 1_000,
      lookup: async (input) => {
        calls.push(`${input.installationId}:${input.owner}/${input.name}`);
        return input.name === "app" ? { id: 456 } : null;
      },
    });
    await expect(lookup({ installationId: 123, owner: "acme", name: "app" })).resolves.toEqual({
      id: 456,
    });
    await expect(lookup({ installationId: 123, owner: "ACME", name: "App" })).resolves.toEqual({
      id: 456,
    });
    await expect(
      lookup({ installationId: 123, owner: "acme", name: "missing" }),
    ).resolves.toBeNull();
    await expect(
      lookup({ installationId: 123, owner: "acme", name: "missing" }),
    ).resolves.toBeNull();
    expect(calls).toEqual(["123:acme/app", "123:acme/missing"]);
    // Another installation or workspace is a different key.
    await lookup({ installationId: 124, owner: "acme", name: "app" });
    await cachedGitHubRepositoryBindingLookup({
      workspaceId: "other",
      cache,
      now: () => clock,
      lookup: async (input) => {
        calls.push(`other ${input.installationId}:${input.owner}/${input.name}`);
        return null;
      },
    })({ installationId: 123, owner: "acme", name: "app" });
    expect(calls).toEqual([
      "123:acme/app",
      "123:acme/missing",
      "124:acme/app",
      "other 123:acme/app",
    ]);
    clock += 1_001;
    await lookup({ installationId: 123, owner: "acme", name: "app" });
    expect(calls).toHaveLength(5);
  });

  test("does not cache a failed lookup, so a GitHub blip is retried on the next turn", async () => {
    let fail = true;
    const lookup = cachedGitHubRepositoryBindingLookup({
      workspaceId: "ws",
      cache: createGitHubRepositoryLookupCache(),
      lookup: async () => {
        if (fail) throw new Error("GitHub API 502");
        return { id: 456 };
      },
    });
    await expect(lookup({ installationId: 123, owner: "acme", name: "app" })).rejects.toThrow(
      "GitHub API 502",
    );
    fail = false;
    await expect(lookup({ installationId: 123, owner: "acme", name: "app" })).resolves.toEqual({
      id: 456,
    });
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

describe("applyTurnGitHubRepositoryBindings (run.ts wiring)", () => {
  type Published = Array<{ type: "credential.auth_needed"; payload: CredentialAuthNeededPayload }>;

  function wiring(overrides: Record<string, unknown> = {}) {
    const published: Published[] = [];
    const warned: Array<{ message: string; fields: Record<string, string> }> = [];
    const input = {
      db,
      settings: testSettings(),
      workspaceId: "ws",
      sessionId: "session-1",
      activeSandboxBackend: "docker" as const,
      claimedTurnResources: [repo()],
      claimedRuntimeResources: [
        repo(),
        { kind: "file" as const, fileId: "11111111-1111-4111-8111-111111111111" },
      ],
      publish: async (events: Published) => {
        published.push(events);
      },
      warn: (message: string, fields: Record<string, string>) => {
        warned.push({ message, fields });
      },
      warningCache: createGitHubRepositoryLookupCache(),
      ...overrides,
    };
    return { input, published, warned };
  }

  const resolvingTo =
    (
      lookup: (input: {
        installationId: number;
        owner: string;
        name: string;
      }) => { id: number } | null,
    ) =>
    (args: Parameters<typeof resolveTurnGitHubRepositoryBindings>[0]) =>
      resolveTurnGitHubRepositoryBindings({
        ...args,
        listCandidates: candidates,
        lookup: async (request) => lookup(request),
        lookupCache: createGitHubRepositoryLookupCache(),
      });

  test("a Connected Machine turn keeps its stored resources and never resolves", async () => {
    const { input, published } = wiring({ activeSandboxBackend: "selfhosted" });
    const result = await applyTurnGitHubRepositoryBindings({
      ...input,
      resolve: async () => {
        throw new Error("must not resolve for a machine-primary turn");
      },
    });
    expect(result).toEqual({
      turnResources: input.claimedTurnResources,
      runtimeResources: input.claimedRuntimeResources,
    });
    expect(published).toEqual([]);
  });

  test("a thrown resolution is logged and the turn proceeds with bare resources", async () => {
    const { input, published, warned } = wiring();
    const result = await applyTurnGitHubRepositoryBindings({
      ...input,
      resolve: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(result).toEqual({
      turnResources: input.claimedTurnResources,
      runtimeResources: input.claimedRuntimeResources,
    });
    expect(published).toEqual([]);
    expect(warned).toEqual([
      {
        message: "GitHub repository binding resolution skipped",
        fields: expect.objectContaining({
          errorCode: "github_repository_binding_resolution_failed",
        }),
      },
    ]);
  });

  test("stamps both the claimed turn resources and the claimed runtime resources", async () => {
    const { input, published } = wiring();
    const result = await applyTurnGitHubRepositoryBindings({
      ...input,
      resolve: resolvingTo(() => ({ id: 456 })),
    });
    expect(result.turnResources).toEqual([stamped()]);
    expect(result.runtimeResources).toEqual([
      stamped(),
      { kind: "file", fileId: "11111111-1111-4111-8111-111111111111" },
    ]);
    expect(published).toEqual([]);
    // Both lists now mint the same single selection.
    expect(gitHubTokenMintSelections(result.turnResources)).toEqual(
      gitHubTokenMintSelections(result.runtimeResources),
    );
  });

  test("publishes a bound-but-unusable warning once per session and URI", async () => {
    const { input, published } = wiring({
      claimedTurnResources: [repo({ uri: "https://github.com/acme/not-selected.git" })],
      claimedRuntimeResources: [repo({ uri: "https://github.com/acme/not-selected.git" })],
    });
    const resolve = resolvingTo(() => ({ id: 999 }));
    const first = await applyTurnGitHubRepositoryBindings({ ...input, resolve });
    expect(first.turnResources).toEqual([
      repo({ uri: "https://github.com/acme/not-selected.git" }),
    ]);
    expect(published).toEqual([
      [
        {
          type: "credential.auth_needed",
          payload: expect.objectContaining({
            reason: "insufficient_scope",
            resource: "https://github.com/acme/not-selected.git",
          }),
        },
      ],
    ]);
    // A recovered attempt or the next turn of the same session stays quiet.
    await applyTurnGitHubRepositoryBindings({ ...input, resolve });
    expect(published).toHaveLength(1);
    // Another session in the same process warns on its own.
    await applyTurnGitHubRepositoryBindings({ ...input, sessionId: "session-2", resolve });
    expect(published).toHaveLength(2);
  });

  test("incident scenario: bare parent resource and inherited child resource both receive ids at turn start", async () => {
    // The parent was created (web, pre-fix) with a bound public repository as
    // a bare URI; the child was spawned with omitted resources and inherited
    // the parent's resources verbatim. Neither row is rewritten; each turn
    // resolves through the same seam and the same process-local memo.
    const lookupCache = createGitHubRepositoryLookupCache();
    const githubCalls: string[] = [];
    const resolve = (args: Parameters<typeof resolveTurnGitHubRepositoryBindings>[0]) =>
      resolveTurnGitHubRepositoryBindings({
        ...args,
        listCandidates: candidates,
        lookup: async (request) => {
          githubCalls.push(`${request.installationId}:${request.owner}/${request.name}`);
          return { id: 456 };
        },
        lookupCache,
      });
    const parentSessionResources = [repo()];
    const parentTurnResources: ResourceRef[] = [];
    const childSessionResources = [...parentSessionResources]; // inherited verbatim
    const childTurnResources: ResourceRef[] = [];

    const parent = wiring({
      sessionId: "parent",
      claimedTurnResources: mergeResourceRefs(parentSessionResources, parentTurnResources),
      claimedRuntimeResources: mergeResourceRefs(parentSessionResources, parentTurnResources),
    });
    const child = wiring({
      sessionId: "child",
      claimedTurnResources: mergeResourceRefs(childSessionResources, childTurnResources),
      claimedRuntimeResources: mergeResourceRefs(childSessionResources, childTurnResources),
    });
    const parentResult = await applyTurnGitHubRepositoryBindings({ ...parent.input, resolve });
    const childResult = await applyTurnGitHubRepositoryBindings({ ...child.input, resolve });

    for (const result of [parentResult, childResult]) {
      expect(result.turnResources).toEqual([stamped()]);
      expect(result.runtimeResources).toEqual([stamped()]);
      expect(gitHubTokenMintSelections(result.turnResources)).toEqual([
        { installationId: 123, repositoryIds: [456] },
      ]);
    }
    expect(parent.published).toEqual([]);
    expect(child.published).toEqual([]);
    // The child's turn reused the parent's memoized lookup.
    expect(githubCalls).toEqual(["123:acme/app"]);
  });
});
