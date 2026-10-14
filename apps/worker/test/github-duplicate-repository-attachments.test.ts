// Regression coverage for OPE-804: a session that already persisted the same
// GitHub repository twice (a catalog-bound row plus a bare manual row for the
// same remote, at a different mount path) must still start. Turn-time binding
// resolution stamps the bare row with the same installation/repository ids, so
// one credential binding sees the repository twice. The mint allowlist must be
// the unique repository set of that exact binding, while every resource/ref
// remains attached and the strict GitHub token boundary keeps rejecting
// duplicate allowlists from any other caller.

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GitCredentialsRequest, ResourceRef } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { createGitHubAppInstallationTokenWithSigningSettings } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import {
  createGitHubRepositoryLookupCache,
  resolveTurnGitHubRepositoryBindings,
} from "../src/activities/agent-turn/github-repository-bindings";
import { assertGitHubResourcesRemainAuthorized } from "../src/activities/agent-turn/file-resources";
import {
  gitHubTokenAuthorizationSelections,
  gitHubTokenMintSelections,
  mintRunGitCredentials,
} from "../src/activities/environment";

const INSTALLATION_ID = 143685771;
const BENCHMARKS_REPOSITORY_ID = 1419642237;
const OPENGENI_REPOSITORY_ID = 1212552738;

const scope = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

const authority = {
  sessionId: "00000000-0000-4000-8000-000000000003",
  rootSessionId: "00000000-0000-4000-8000-000000000003",
  turnId: "00000000-0000-4000-8000-000000000005",
  attemptId: "00000000-0000-4000-8000-000000000006",
  executionGeneration: 1,
  initiator: { kind: "subject" as const, subjectId: "user:1", label: "Operator" },
  initiatorContext: { source: "web" },
};

/** The exact saved resource shape of the failed incident session. */
function persistedIncidentResources(): ResourceRef[] {
  return [
    {
      kind: "repository",
      uri: "https://github.com/Cloudgeni-ai/agent-benchmarks.git",
      ref: "main",
      mountPath: "repos/github.com/Cloudgeni-ai/agent-benchmarks",
      provider: "github",
      githubInstallationId: INSTALLATION_ID,
      githubRepositoryId: BENCHMARKS_REPOSITORY_ID,
    },
    {
      kind: "repository",
      uri: "https://github.com/Cloudgeni-ai/opengeni.git",
      ref: "main",
      mountPath: "repos/github.com/Cloudgeni-ai/opengeni",
      provider: "github",
      githubInstallationId: INSTALLATION_ID,
      githubRepositoryId: OPENGENI_REPOSITORY_ID,
    },
    {
      kind: "repository",
      uri: "https://github.com/Cloudgeni-ai/opengeni.git",
      ref: "main",
      mountPath: "repos/github.com/Cloudgeni-ai/opengeni.git",
    },
  ] as ResourceRef[];
}

async function resolveIncidentResources(): Promise<ResourceRef[]> {
  const resolved = await resolveTurnGitHubRepositoryBindings({
    db: {} as Database,
    settings: testSettings(),
    workspaceId: scope.workspaceId,
    resources: persistedIncidentResources(),
    listCandidates: async () => [
      {
        installationId: INSTALLATION_ID,
        accountLogin: "Cloudgeni-ai",
        repositoryIds: [BENCHMARKS_REPOSITORY_ID, OPENGENI_REPOSITORY_ID],
      },
    ],
    lookup: async ({ name }) => ({
      id: name === "opengeni" ? OPENGENI_REPOSITORY_ID : BENCHMARKS_REPOSITORY_ID,
    }),
    lookupCache: createGitHubRepositoryLookupCache(),
  });
  expect(resolved.warnings).toEqual([]);
  return resolved.resources;
}

function signingSettings() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return testSettings({
    sandboxBackend: "docker",
    githubAppId: "12345",
    githubClientId: "client",
    githubClientSecret: "secret",
    githubAppSlug: "opengeni",
    githubAppPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
}

describe("persisted duplicate GitHub repository attachments (OPE-804)", () => {
  const originalFetch = globalThis.fetch;
  let mintBodies: unknown[] = [];

  beforeEach(() => {
    mintBodies = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        mintBodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
        return Response.json(
          { token: "ghs_incident", expires_at: "2026-10-14T20:00:00Z" },
          { status: 201 },
        );
      }
      return Response.json({ message: `unexpected request ${url}` }, { status: 500 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("turn-time binding resolution stamps the bare duplicate with the same identity", async () => {
    const resources = await resolveIncidentResources();
    expect(resources[2]).toMatchObject({
      uri: "https://github.com/Cloudgeni-ai/opengeni.git",
      mountPath: "repos/github.com/Cloudgeni-ai/opengeni.git",
      provider: "github",
      githubInstallationId: INSTALLATION_ID,
      githubRepositoryId: OPENGENI_REPOSITORY_ID,
    });
  });

  test("the mint selection is the unique repository allowlist of the one binding", async () => {
    const resources = await resolveIncidentResources();
    expect(gitHubTokenMintSelections(resources)).toEqual([
      {
        installationId: INSTALLATION_ID,
        repositoryIds: [BENCHMARKS_REPOSITORY_ID, OPENGENI_REPOSITORY_ID],
      },
    ]);
    const [selection] = gitHubTokenAuthorizationSelections(resources);
    expect(selection?.repositoryIds).toEqual([BENCHMARKS_REPOSITORY_ID, OPENGENI_REPOSITORY_ID]);
    // Every attached resource keeps its own ref; nothing is dropped.
    expect(selection?.repositoryRefs.map((ref) => ref.uri)).toEqual([
      "https://github.com/Cloudgeni-ai/agent-benchmarks.git",
      "https://github.com/Cloudgeni-ai/opengeni.git",
      "https://github.com/Cloudgeni-ai/opengeni.git",
    ]);
  });

  test("an already persisted duplicate session mints through the real token boundary", async () => {
    const resources = await resolveIncidentResources();
    const authorized: unknown[] = [];
    const minted = await mintRunGitCredentials(signingSettings(), resources, {
      scope,
      authority,
      authorizeGitHubTokenMint: async (selection) => {
        authorized.push(selection.repositoryIds);
      },
    });
    expect(authorized).toEqual([[BENCHMARKS_REPOSITORY_ID, OPENGENI_REPOSITORY_ID]]);
    expect(mintBodies).toEqual([
      { repository_ids: [BENCHMARKS_REPOSITORY_ID, OPENGENI_REPOSITORY_ID] },
    ]);
    expect(minted?.gitTokens).toEqual({ github: "ghs_incident" });
    expect(minted?.bindings).toHaveLength(1);
  });

  test("the live workspace authorization recheck still runs and still fails closed", async () => {
    const resources = await resolveIncidentResources();
    const checked: number[][] = [];
    await assertGitHubResourcesRemainAuthorized(
      {} as Database,
      scope.workspaceId,
      resources,
      async (selection) => {
        checked.push(selection.repositoryIds);
      },
    );
    expect(checked).toEqual([[BENCHMARKS_REPOSITORY_ID, OPENGENI_REPOSITORY_ID]]);

    await expect(
      mintRunGitCredentials(signingSettings(), resources, {
        scope,
        authority,
        authorizeGitHubTokenMint: async () => {
          throw new Error("workspace binding revoked");
        },
      }),
    ).rejects.toThrow("workspace binding revoked");
    expect(mintBodies).toEqual([]);
  });

  test("a host credential broker receives unique ids and every resource ref", async () => {
    const resources = await resolveIncidentResources();
    const requests: GitCredentialsRequest[] = [];
    await mintRunGitCredentials(testSettings({ sandboxBackend: "docker" }), resources, {
      scope,
      authority,
      gitCredentials: async (request) => {
        requests.push(request);
        return { token: "ghs_host", workspaceId: request.workspaceId };
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.repositoryIds).toEqual([BENCHMARKS_REPOSITORY_ID, OPENGENI_REPOSITORY_ID]);
    expect(requests[0]?.repositoryRefs).toHaveLength(3);
    expect(mintBodies).toEqual([]);
  });

  test("different refs of one repository keep both attachments with one allowlist entry", () => {
    const resources = [
      {
        kind: "repository",
        uri: "https://github.com/acme/app.git",
        ref: "main",
        mountPath: "repos/github.com/acme/app",
        provider: "github",
        githubInstallationId: 1,
        githubRepositoryId: 2,
      },
      {
        kind: "repository",
        uri: "https://github.com/acme/app.git",
        ref: "release",
        mountPath: "repos/github.com/acme/app-release",
        provider: "github",
        githubInstallationId: 1,
        githubRepositoryId: 2,
      },
    ] as ResourceRef[];
    const [selection] = gitHubTokenAuthorizationSelections(resources);
    expect(selection?.repositoryIds).toEqual([2]);
    expect(selection?.repositoryRefs.map((ref) => ref.ref)).toEqual(["main", "release"]);
  });

  test("one remote claimed by two installations still fails closed", () => {
    const resources = [
      {
        kind: "repository",
        uri: "https://github.com/acme/app.git",
        ref: "main",
        mountPath: "repos/github.com/acme/app",
        provider: "github",
        githubInstallationId: 1,
        githubRepositoryId: 2,
      },
      {
        kind: "repository",
        uri: "https://github.com/acme/app.git",
        ref: "main",
        mountPath: "repos/github.com/acme/app-copy",
        provider: "github",
        githubInstallationId: 3,
        githubRepositoryId: 2,
      },
    ] as ResourceRef[];
    expect(() => gitHubTokenMintSelections(resources)).toThrow(
      "claimed by multiple credential bindings",
    );
  });

  test("the GitHub token boundary itself still rejects a duplicate allowlist", async () => {
    await expect(
      createGitHubAppInstallationTokenWithSigningSettings(signingSettings(), {
        installationId: INSTALLATION_ID,
        repositoryIds: [BENCHMARKS_REPOSITORY_ID, OPENGENI_REPOSITORY_ID, OPENGENI_REPOSITORY_ID],
      }),
    ).rejects.toThrow("explicit, unique repository allowlist");
    expect(mintBodies).toEqual([]);
  });
});
