import { describe, expect, test } from "bun:test";

import type { GitHubRepository, ResourceRef } from "@/types";
import {
  gitHubRepositoryChatState,
  matchesRepositorySearch,
  orderRepositoriesForChat,
  repositoryUseMessage,
  revokedGitHubRepositoryResources,
  usingRepositoriesLabel,
} from "./session-github-repositories";

const repo = (id: number, fullName: string, installationId = 42): GitHubRepository => ({
  id,
  installationId,
  fullName,
  name: fullName.split("/")[1]!,
  private: true,
  htmlUrl: `https://github.com/${fullName}`,
  cloneUrl: `https://github.com/${fullName}.git`,
  defaultBranch: "main",
  accountLogin: fullName.split("/")[0]!,
  accountType: "Organization",
});
const mounted = (repository: GitHubRepository, ref = "main"): ResourceRef => ({
  kind: "repository",
  uri: repository.cloneUrl,
  ref,
  provider: "github",
  mountPath: `repos/github.com/${repository.fullName}`,
  githubRepositoryId: repository.id,
  githubInstallationId: repository.installationId,
});
const account = (installationId: number) => (installationId === 42 ? "acme" : "northwind");

describe("GitHub card repository rules", () => {
  test("an available repository yields exactly the composer picker's resource", () => {
    const api = repo(101, "acme/api");
    expect(gitHubRepositoryChatState(api, [], account, [api])).toEqual({
      kind: "available",
      resource: {
        kind: "repository",
        uri: "https://github.com/acme/api.git",
        ref: "main",
        provider: "github",
        mountPath: "repos/github.com/acme/api",
        githubRepositoryId: 101,
        githubInstallationId: 42,
      },
    });
  });

  test("a mounted repository is attached even on another branch", () => {
    const api = repo(101, "acme/api");
    expect(gitHubRepositoryChatState(api, [mounted(api, "release")], account, [api])).toEqual({
      kind: "attached",
    });
  });

  test("one App token per chat: another account's repository is blocked with its reason", () => {
    const api = repo(101, "acme/api");
    const notes = repo(201, "northwind/notes", 77);
    const state = gitHubRepositoryChatState(notes, [mounted(api)], account, [api, notes]);
    expect(state).toMatchObject({ kind: "blocked", cause: "other_account", usingAccount: "acme" });
    // A mount GitHub no longer shares holds no token, so it blocks nothing.
    expect(gitHubRepositoryChatState(notes, [mounted(api)], account, [notes]).kind).toBe(
      "available",
    );
  });

  test("a mount-path collision with a manual repository is refused before Send", () => {
    const manual: ResourceRef = {
      kind: "repository",
      uri: "https://gitlab.example.com/acme/api.git",
      ref: "main",
      mountPath: "repos/github.com/acme/api",
    };
    expect(gitHubRepositoryChatState(repo(101, "acme/api"), [manual], account, [])).toMatchObject({
      kind: "blocked",
      cause: "mount_conflict",
    });
  });

  test("files and other resources never block a repository", () => {
    const file = { kind: "file", fileId: "00000000-0000-4000-8000-000000000001" } as ResourceRef;
    expect(gitHubRepositoryChatState(repo(101, "acme/api"), [file], account, []).kind).toBe(
      "available",
    );
  });

  test("revocation needs a loaded catalog and App identity", () => {
    const api = repo(101, "acme/api");
    const bare: ResourceRef = {
      kind: "repository",
      uri: "https://github.com/x/y.git",
      ref: "main",
    };
    expect(revokedGitHubRepositoryResources([mounted(api), bare], [], true)).toEqual([
      mounted(api) as Extract<ResourceRef, { kind: "repository" }>,
    ]);
    expect(revokedGitHubRepositoryResources([mounted(api)], [], false)).toEqual([]);
    expect(revokedGitHubRepositoryResources([mounted(api)], [api], true)).toEqual([]);
  });

  test("copy, ordering and search", () => {
    expect(repositoryUseMessage(repo(101, "acme/api"))).toBe("Use acme/api");
    expect(usingRepositoriesLabel([])).toBeNull();
    expect(usingRepositoriesLabel(["acme/api"])).toBe("Using acme/api in this chat");
    expect(usingRepositoriesLabel(["acme/api", "acme/web", "acme/cli"])).toBe(
      "Using acme/api and 2 more in this chat",
    );
    const ordered = orderRepositoriesForChat(
      [repo(1, "acme/zeta"), repo(2, "Acme/alpha"), repo(3, "acme/mid")],
      (repository) => repository.id === 1,
    );
    expect(ordered.map((repository) => repository.fullName)).toEqual([
      "acme/zeta",
      "Acme/alpha",
      "acme/mid",
    ]);
    expect(matchesRepositorySearch(repo(1, "acme/Billing"), " bill ")).toBe(true);
    expect(matchesRepositorySearch(repo(1, "acme/api"), "web")).toBe(false);
  });
});
