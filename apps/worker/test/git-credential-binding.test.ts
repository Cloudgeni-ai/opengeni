import { describe, expect, test } from "bun:test";
import type { GitHubRepository } from "@opengeni/contracts";
import type { Database, SandboxGitCredentialBinding } from "@opengeni/db";
import type { GitCredentialTokenWriterSession } from "@opengeni/runtime";
import {
  assertMintedGitCredentialBindingCoverage,
  GitCredentialLifecycleError,
  matchObservedGitHubRepositories,
  assertCredentialRepositoryRefSecretFree,
  repositoryIdentityForCredentialRef,
  resolveGitCredentialBindingForSession,
  validateRebindGitCredentialsResult,
  validateReboundCredentialRefs,
} from "../src/activities/git-credential-binding";
import {
  mintRunGitCredentials,
  mintRunGitCredentialsFromRepositoryRefs,
} from "../src/activities/environment";
import { testSettings } from "@opengeni/testing";

const observed = [{ provider: "github" as const, canonical: "github.com/Acme/Private" }];
const scope = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
};
const repository = (overrides: Partial<GitHubRepository> = {}): GitHubRepository => ({
  id: 7,
  installationId: 42,
  fullName: "Acme/Private",
  name: "Private",
  private: true,
  htmlUrl: "https://github.com/Acme/Private",
  cloneUrl: "https://github.com/Acme/Private.git",
  defaultBranch: "main",
  accountLogin: "Acme",
  accountType: "Organization",
  ...overrides,
});

const storedBinding = (
  overrides: Partial<SandboxGitCredentialBinding> = {},
): SandboxGitCredentialBinding => ({
  id: "00000000-0000-4000-8000-000000000004",
  ...scope,
  provider: "github",
  source: "observed_checkout",
  status: "active",
  repositoryRefs: [
    {
      provider: "github",
      uri: "https://github.com/Acme/Private.git",
      ref: "main",
      repositoryId: 7,
      installationId: 42,
    },
  ],
  generation: 1,
  reasonCode: null,
  lastValidatedAt: new Date("2026-07-19T00:00:00.000Z"),
  createdAt: new Date("2026-07-19T00:00:00.000Z"),
  updatedAt: new Date("2026-07-19T00:00:00.000Z"),
  ...overrides,
});

describe("resource-less Git credential binding", () => {
  test("matches exactly one authorized repository and returns only typed refs", () => {
    expect(matchObservedGitHubRepositories(observed, [repository()])).toEqual({
      status: "bound",
      repositoryRefs: [
        {
          provider: "github",
          uri: "https://github.com/Acme/Private.git",
          ref: "main",
          repositoryId: 7,
          installationId: 42,
        },
      ],
    });
  });

  test("zero and ambiguous catalog matches fail without selecting a token scope", () => {
    expect(matchObservedGitHubRepositories(observed, [])).toEqual({
      status: "not_found",
      reasonCode: "repository_not_authorized",
    });
    expect(
      matchObservedGitHubRepositories(observed, [repository(), repository({ installationId: 99 })]),
    ).toEqual({ status: "ambiguous", reasonCode: "repository_match_ambiguous" });
  });

  test("rejects credential-bearing rebound refs without reflecting their secrets", () => {
    const secret = "never-reflect-this";
    let message = "";
    try {
      repositoryIdentityForCredentialRef({
        provider: "github",
        uri: `https://user:${secret}@github.com/Acme/Private.git?token=${secret}#${secret}`,
        ref: "main",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("credential-bearing URL components");
    expect(message).not.toContain(secret);
  });

  test("rejects non-Git URL protocols and credential-like SCP usernames", () => {
    expect(() =>
      assertCredentialRepositoryRefSecretFree({
        provider: "github",
        uri: "file:///tmp/repository",
        ref: "main",
      }),
    ).toThrow("not a supported absolute Git URL");
    expect(() =>
      assertCredentialRepositoryRefSecretFree({
        provider: "gitlab",
        uri: "deploy@gitlab.example.com:Acme/Private.git",
        ref: "main",
      }),
    ).toThrow("unsupported SCP-style components");
    expect(
      assertCredentialRepositoryRefSecretFree({
        provider: "gitlab",
        uri: "ssh://git@git.internal.example/Acme/Private.git",
        ref: "main",
      }).uri,
    ).toBe("ssh://git@git.internal.example/Acme/Private.git");
  });

  test("requires the rebound refs to cover exactly the sanitized observed set", () => {
    expect(() =>
      validateReboundCredentialRefs(
        [
          {
            provider: "github",
            uri: "https://github.com/Acme/Other.git",
            ref: "main",
            repositoryId: 8,
            installationId: 42,
          },
        ],
        observed,
      ),
    ).toThrow("did not exactly cover");
  });

  test("validates successful embedded rebinds and every typed failure status", () => {
    expect(
      validateRebindGitCredentialsResult(scope.workspaceId, observed, {
        status: "bound",
        workspaceId: scope.workspaceId,
        repositoryRefs: storedBinding().repositoryRefs,
      }),
    ).toEqual({ status: "bound", repositoryRefs: storedBinding().repositoryRefs });

    for (const status of ["not_found", "ambiguous", "unavailable", "revoked"] as const) {
      expect(
        validateRebindGitCredentialsResult(scope.workspaceId, observed, {
          status,
          workspaceId: scope.workspaceId,
          reasonCode: `host_${status}`,
        }),
      ).toEqual({ status, providers: ["github"], reasonCode: `host_${status}` });
    }
  });

  test("rejects embedded workspace-echo, unsafe-host, and exact-coverage mismatches", () => {
    expect(() =>
      validateRebindGitCredentialsResult(scope.workspaceId, observed, {
        status: "bound",
        workspaceId: "00000000-0000-4000-8000-000000000099",
        repositoryRefs: storedBinding().repositoryRefs,
      }),
    ).toThrow("scoped to workspace");
    expect(() =>
      validateRebindGitCredentialsResult(scope.workspaceId, observed, {
        status: "bound",
        workspaceId: scope.workspaceId,
        repositoryRefs: [
          {
            provider: "github",
            uri: "https://example.com/Acme/Private.git",
            ref: "main",
          },
        ],
      }),
    ).toThrow("unsupported Git host");
    expect(() =>
      validateRebindGitCredentialsResult(scope.workspaceId, observed, {
        status: "bound",
        workspaceId: scope.workspaceId,
        repositoryRefs: [
          {
            provider: "github",
            uri: "https://github.com/Acme/Other.git",
            ref: "main",
          },
        ],
      }),
    ).toThrow("did not exactly cover");
  });

  test("rejects explicit GitHub metadata for a non-GitHub host before broker mint", async () => {
    const secret = "must-not-be-reflected";
    let mintCalls = 0;
    let message = "";
    try {
      await mintRunGitCredentials(
        testSettings(),
        [
          {
            kind: "repository",
            provider: "github",
            uri: `https://example.com/Acme/${secret}.git`,
            ref: "main",
            githubInstallationId: 42,
            githubRepositoryId: 7,
          },
        ],
        {
          scope,
          gitCredentials: async (request) => {
            mintCalls += 1;
            return { token: "must-not-mint", workspaceId: request.workspaceId };
          },
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("unsupported Git host");
    expect(message).not.toContain(secret);
    expect(mintCalls).toBe(0);
  });

  test("rejects insecure or nonstandard explicit GitHub endpoints before broker mint", async () => {
    const secret = "must-not-be-reflected";
    let mintCalls = 0;
    for (const uri of [
      `http://github.com/Acme/${secret}.git`,
      `https://github.com:8443/Acme/${secret}.git`,
    ]) {
      let message = "";
      try {
        await mintRunGitCredentials(
          testSettings(),
          [
            {
              kind: "repository",
              provider: "github",
              uri,
              ref: "main",
              githubInstallationId: 42,
              githubRepositoryId: 7,
            },
          ],
          {
            scope,
            gitCredentials: async (request) => {
              mintCalls += 1;
              return { token: "must-not-mint", workspaceId: request.workspaceId };
            },
          },
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("unsupported transport");
      expect(message).not.toContain(secret);
    }
    expect(mintCalls).toBe(0);
  });

  test("an incomplete worker discovery never reuses, rebinds, or persists authorization", async () => {
    let rebinds = 0;
    let upserts = 0;
    const marked: string[][] = [];
    const result = await resolveGitCredentialBindingForSession({
      db: {} as Database,
      settings: testSettings(),
      scope,
      session: {} as GitCredentialTokenWriterSession,
      resources: [],
      connectionCredentials: {
        rebindGitCredentials: async () => {
          rebinds += 1;
          throw new Error("must not run");
        },
      },
      operations: {
        listBindings: async () => [storedBinding()],
        upsertBinding: async () => {
          upserts += 1;
          return storedBinding();
        },
        markBindingsStatus: async (_db, input) => {
          marked.push([...input.providers]);
          return [];
        },
        detectRepositories: async () => ({
          repositories: [],
          complete: false,
          degradedReason: "result_limit_exceeded",
        }),
      },
    });
    expect(result).toEqual({
      status: "unavailable",
      providers: ["github"],
      reasonCode: "discovery_incomplete",
    });
    expect({ rebinds, upserts, marked }).toEqual({
      rebinds: 0,
      upserts: 0,
      marked: [["github"]],
    });
  });

  test("invalid host responses fail typed and request cleanup only for an unfenced legacy file", async () => {
    const result = await resolveGitCredentialBindingForSession({
      db: {} as Database,
      settings: testSettings(),
      scope,
      session: {} as GitCredentialTokenWriterSession,
      resources: [],
      connectionCredentials: {
        rebindGitCredentials: async () => ({
          status: "bound",
          workspaceId: scope.workspaceId,
          repositoryRefs: [
            {
              provider: "github",
              uri: "file:///tmp/not-a-provider-repository",
              ref: "main",
            },
          ],
        }),
      },
      operations: {
        listBindings: async () => [],
        detectRepositories: async () => ({
          repositories: observed,
          complete: true,
          degradedReason: null,
        }),
      },
    });
    expect(result).toEqual({
      status: "unavailable",
      providers: ["github"],
      reasonCode: "host_response_invalid",
      legacyInvalidationProviders: ["github"],
    });
  });

  test("a managed checkout with no explicit resource auto-discovers and persists its host binding", async () => {
    const upserts: Array<{ source: string; repositoryRefs: unknown[] }> = [];
    const result = await resolveGitCredentialBindingForSession({
      db: {} as Database,
      settings: testSettings(),
      scope,
      session: {} as GitCredentialTokenWriterSession,
      resources: [],
      connectionCredentials: {
        rebindGitCredentials: async (request) => ({
          status: "bound",
          workspaceId: request.workspaceId,
          repositoryRefs: storedBinding().repositoryRefs,
        }),
      },
      operations: {
        listBindings: async () => [],
        detectRepositories: async () => ({
          repositories: observed,
          complete: true,
          degradedReason: null,
        }),
        upsertBinding: async (_db, input) => {
          upserts.push({
            source: input.source,
            repositoryRefs: [...input.repositoryRefs],
          });
          return storedBinding({ source: input.source, repositoryRefs: [...input.repositoryRefs] });
        },
      },
    });
    expect(result.status).toBe("bound");
    expect(upserts).toEqual([
      {
        source: "observed_checkout",
        repositoryRefs: storedBinding().repositoryRefs,
      },
    ]);
  });

  test("lifecycle errors expose only a fixed typed code", () => {
    const secret = "provider-secret-must-not-escape";
    const error = new GitCredentialLifecycleError("token_install_failed");
    expect(error).toMatchObject({
      name: "GitCredentialLifecycleError",
      code: "token_install_failed",
    });
    expect(error.message).toBe("Git credential lifecycle failed (token_install_failed)");
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  test("a partial multi-provider token bundle fails closed without reflecting token values", () => {
    const secret = "partial-provider-token-must-not-escape";
    const binding = {
      status: "bound" as const,
      repositoryRefs: [
        ...storedBinding().repositoryRefs,
        {
          provider: "gitlab" as const,
          uri: "https://gitlab.example.com/Acme/Private.git",
          ref: "main",
          repositoryId: 8,
          connectionId: "gitlab-connection",
        },
      ],
      bindings: [storedBinding()],
      expectedGenerations: { github: 1, gitlab: 1 },
    };
    let message = "";
    try {
      assertMintedGitCredentialBindingCoverage(binding, {
        gitTokens: { github: secret },
        expiresAt: {},
      });
    } catch (error) {
      expect(error).toMatchObject({
        name: "GitCredentialLifecycleError",
        code: "token_mint_failed",
      });
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Git credential lifecycle failed (token_mint_failed)");
    expect(message).not.toContain(secret);
  });

  test("durable reuse requires exact observed coverage and deactivates omitted providers", async () => {
    let rebinds = 0;
    const marked: Array<{
      providers: string[];
      reasonCode: string;
      expectedGenerations: unknown;
    }> = [];
    const azure = storedBinding({
      id: "00000000-0000-4000-8000-000000000005",
      provider: "azure_devops",
      repositoryRefs: [
        {
          provider: "azure_devops",
          uri: "https://dev.azure.com/Org/Project/_git/Repo",
          ref: "main",
          repositoryId: "Repo",
        },
      ],
    });
    const result = await resolveGitCredentialBindingForSession({
      db: {} as Database,
      settings: testSettings(),
      scope,
      session: {} as GitCredentialTokenWriterSession,
      resources: [],
      connectionCredentials: {
        rebindGitCredentials: async () => {
          rebinds += 1;
          throw new Error("exact durable binding should be reused");
        },
      },
      operations: {
        listBindings: async () => [storedBinding(), azure],
        markBindingsStatus: async (_db, input) => {
          marked.push({
            providers: [...input.providers],
            reasonCode: input.reasonCode,
            expectedGenerations: input.expectedGenerations,
          });
          return [];
        },
        detectRepositories: async () => ({
          repositories: observed,
          complete: true,
          degradedReason: null,
        }),
      },
    });
    expect(result.status).toBe("bound");
    expect(
      result.status === "bound" ? result.bindings.map((binding) => binding.provider) : [],
    ).toEqual(["github"]);
    expect(rebinds).toBe(0);
    expect(marked).toEqual([
      {
        providers: ["azure_devops"],
        reasonCode: "repository_not_observed",
        expectedGenerations: { azure_devops: 1 },
      },
    ]);
  });

  test("mints from durable refs with the existing legacy GitHub request shape", async () => {
    const requests: unknown[] = [];
    const minted = await mintRunGitCredentialsFromRepositoryRefs(
      testSettings(),
      [
        {
          provider: "github",
          uri: "https://github.com/Acme/Private.git",
          ref: "main",
          repositoryId: 7,
          installationId: 42,
        },
      ],
      {
        scope: {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
        },
        gitCredentials: async (request) => {
          requests.push(request);
          return { token: "minted", workspaceId: request.workspaceId };
        },
      },
    );
    expect(requests).toEqual([
      {
        accountId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        purpose: "token",
        installationId: 42,
        repositoryIds: [7],
        repositoryRefs: [
          {
            provider: "github",
            uri: "https://github.com/Acme/Private.git",
            ref: "main",
            repositoryId: 7,
            installationId: 42,
          },
        ],
      },
    ]);
    expect(minted?.gitTokens).toEqual({ github: "minted" });
  });
});
