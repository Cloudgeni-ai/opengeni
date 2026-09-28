// Unit coverage for the turn-time access check that drops automatically
// attached (optional) GitHub App repositories which lost access after the
// session started. The Postgres-backed end-to-end turn lives in
// optional-repository-access-loss.test.ts.

import { describe, expect, test } from "bun:test";
import type { ResourceRef } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  dropUnavailableOptionalRepositories,
  type DropUnavailableOptionalRepositoriesInput,
} from "../src/activities/agent-turn/optional-repositories";

const repository = (name: string, repositoryId: number, optional = true): ResourceRef =>
  ({
    kind: "repository",
    uri: `https://github.com/example-org/${name}.git`,
    ref: "main",
    mountPath: `repos/github.com/example-org/${name}`,
    provider: "github",
    githubInstallationId: 77,
    githubRepositoryId: repositoryId,
    ...(optional ? { optional: true } : {}),
  }) as ResourceRef;

const file: ResourceRef = { kind: "file", fileId: "11111111-1111-4111-8111-111111111111" };

function harness(overrides: Partial<DropUnavailableOptionalRepositoriesInput> = {}) {
  const published: unknown[] = [];
  const warnings: Array<Record<string, string>> = [];
  const resources = [repository("a", 1), repository("b", 2), repository("explicit", 3, false)];
  const input: DropUnavailableOptionalRepositoriesInput = {
    db: {} as Database,
    settings: testSettings(),
    workspaceId: "ws",
    activeSandboxBackend: "docker",
    hostMintsGitCredentials: false,
    turnResources: resources,
    runtimeResources: [...resources, file],
    publish: async (events) => {
      published.push(...events.map((event) => event.payload));
    },
    warn: (_message, fields) => warnings.push(fields),
    isAllowlisted: async () => true,
    findInaccessible: async () => [],
    ...overrides,
  };
  return { input, published, warnings };
}

const names = (resources: ResourceRef[]) =>
  resources.map((resource) =>
    resource.kind === "repository" ? resource.uri.split("/").pop() : resource.kind,
  );

describe("dropUnavailableOptionalRepositories", () => {
  test("keeps every repository and stays silent when all are reachable", async () => {
    const { input, published, warnings } = harness();
    const result = await dropUnavailableOptionalRepositories(input);
    expect(names(result.turnResources)).toEqual(["a.git", "b.git", "explicit.git"]);
    expect(published).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("never checks or drops an explicitly attached repository", async () => {
    const checked: number[] = [];
    const { input } = harness({
      isAllowlisted: async (_installationId, repositoryId) => {
        checked.push(repositoryId);
        return false;
      },
    });
    const result = await dropUnavailableOptionalRepositories(input);
    expect(checked.sort()).toEqual([1, 2]);
    expect(names(result.turnResources)).toEqual(["explicit.git"]);
    expect(names(result.runtimeResources)).toEqual(["explicit.git", "file"]);
  });

  test("drops a repository GitHub no longer lets the installation reach", async () => {
    const asked: Array<{ installationId: number; repositoryIds: number[] }> = [];
    const { input, published, warnings } = harness({
      findInaccessible: async (installationId, repositoryIds) => {
        asked.push({ installationId, repositoryIds });
        return [2];
      },
    });
    const result = await dropUnavailableOptionalRepositories(input);
    expect(asked).toEqual([{ installationId: 77, repositoryIds: [1, 2] }]);
    expect(names(result.turnResources)).toEqual(["a.git", "explicit.git"]);
    expect(names(result.runtimeResources)).toEqual(["a.git", "explicit.git", "file"]);
    expect(published).toEqual([
      {
        name: "optional-repository-access",
        repositoryCount: 3,
        skippedOptionalRepositories: ["repos/github.com/example-org/b"],
      },
    ]);
    expect(warnings).toEqual([
      {
        droppedCount: "1",
        notAllowlistedCount: "0",
        inaccessibleCount: "1",
        unverifiedCount: "0",
        origin: "worker",
      },
    ]);
  });

  test("only asks GitHub about repositories the allowlist still admits", async () => {
    const asked: number[][] = [];
    const { input } = harness({
      isAllowlisted: async (_installationId, repositoryId) => repositoryId !== 1,
      findInaccessible: async (_installationId, repositoryIds) => {
        asked.push(repositoryIds);
        return [];
      },
    });
    const result = await dropUnavailableOptionalRepositories(input);
    expect(asked).toEqual([[2]]);
    expect(names(result.turnResources)).toEqual(["b.git", "explicit.git"]);
  });

  test("a GitHub outage sits the optional repositories out instead of failing the turn", async () => {
    const { input, warnings } = harness({
      findInaccessible: async () => {
        throw new Error("GitHub unavailable");
      },
    });
    const result = await dropUnavailableOptionalRepositories(input);
    expect(names(result.turnResources)).toEqual(["explicit.git"]);
    expect(warnings[0]?.unverifiedCount).toBe("2");
  });

  test("does not ask this deployment's App when a host mints the Git tokens", async () => {
    const { input } = harness({ hostMintsGitCredentials: true, findInaccessible: undefined });
    const result = await dropUnavailableOptionalRepositories(input);
    expect(names(result.turnResources)).toEqual(["a.git", "b.git", "explicit.git"]);
  });

  test("a Connected Machine turn keeps its stored resources untouched", async () => {
    const { input, published } = harness({
      activeSandboxBackend: "selfhosted",
      isAllowlisted: async () => false,
    });
    const result = await dropUnavailableOptionalRepositories(input);
    expect(names(result.turnResources)).toEqual(["a.git", "b.git", "explicit.git"]);
    expect(published).toEqual([]);
  });

  test("leaves optional repositories without GitHub App ids alone", async () => {
    const bare = {
      kind: "repository",
      uri: "https://github.com/example-org/public.git",
      ref: "main",
      optional: true,
    } as ResourceRef;
    const { input } = harness({
      turnResources: [bare],
      runtimeResources: [bare],
      isAllowlisted: async () => {
        throw new Error("must not be checked");
      },
    });
    const result = await dropUnavailableOptionalRepositories(input);
    expect(result.turnResources).toEqual([bare]);
  });
});
