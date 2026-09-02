import { describe, expect, mock, test } from "bun:test";

import {
  ANONYMOUS_REPOSITORY_WARNING,
  attachManualRepository,
  attachedManualRepositoryCount,
  classifyManualRepository,
} from "@/lib/manual-repositories";
import type { GitHubRepository, PersonalGitHubRepositoryCatalogItem } from "@/types";

const workspaceRepository: GitHubRepository = {
  id: 1,
  installationId: 2,
  fullName: "acme/private",
  name: "private",
  private: true,
  htmlUrl: "https://github.com/acme/private",
  cloneUrl: "https://github.com/acme/private.git",
  defaultBranch: "main",
  accountLogin: "acme",
  accountType: "Organization",
};

const personalRepository = {
  repositoryId: "3",
  fullName: "acme/personal",
  canonicalUrl: "https://github.com/acme/personal",
  defaultBranch: "trunk",
  visibility: "private",
  private: true,
  archived: false,
  disabled: false,
  permissions: { pull: true, push: false, admin: false, maintain: false, triage: false },
  selectedAccess: "read",
} satisfies PersonalGitHubRepositoryCatalogItem;

describe("manual repository attachment", () => {
  test("counts only attached manual rows", () => {
    expect(
      attachedManualRepositoryCount([
        { id: 1, url: "https://example.com/a.git", ref: "main", attached: true },
        { id: 2, url: "https://example.com/b.git", ref: "main", attached: false },
      ]),
    ).toBe(1);
  });

  test("routes authorized GitHub URLs to their authenticated source", () => {
    expect(
      classifyManualRepository({
        repository: { id: 1, url: "https://github.com/acme/private", ref: "release" },
        workspaceRepositories: [workspaceRepository],
        personalRepositories: [personalRepository],
      }),
    ).toMatchObject({ kind: "workspace_github", repository: workspaceRepository, ref: "release" });
    expect(
      classifyManualRepository({
        repository: { id: 1, url: "https://github.com/acme/personal.git", ref: "v1" },
        workspaceRepositories: [],
        personalRepositories: [personalRepository],
      }),
    ).toMatchObject({ kind: "personal_github", repository: personalRepository, ref: "v1" });
  });

  test("rejects non-canonical GitHub URLs instead of treating them as generic HTTPS", () => {
    for (const url of [
      "https://github.com/acme/private/issues",
      "https://github.com./acme/private",
    ]) {
      expect(() =>
        classifyManualRepository({
          repository: { id: 1, url, ref: "main" },
          workspaceRepositories: [],
          personalRepositories: [],
        }),
      ).toThrow("canonical GitHub URL");
    }
  });

  test("verifies public GitHub refs before attaching", async () => {
    const attach = mock(() => {});
    const verify = mock(async () => ({
      owner: "acme",
      name: "public",
      fullName: "acme/public",
      canonicalUrl: "https://github.com/acme/public",
      cloneUrl: "https://github.com/acme/public.git",
      defaultBranch: "main",
      ref: "refs/tags/v1",
      commitSha: "a".repeat(40),
    }));
    await attachManualRepository({
      repository: {
        id: 1,
        url: "https://github.com/acme/public",
        ref: "refs/tags/v1",
      },
      workspaceRepositories: [],
      personalRepositories: [],
      selectWorkspaceRepository: () => {},
      selectPersonalRepository: () => {},
      verifyPublicGitHubRepository: verify,
      attach,
      remove: () => {},
    });
    expect(verify).toHaveBeenCalledWith({
      url: "https://github.com/acme/public",
      ref: "refs/tags/v1",
    });
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://github.com/acme/public.git",
        ref: "refs/tags/v1",
        expectedCommitSha: "a".repeat(40),
        attached: true,
      }),
    );
  });

  test("attaches other HTTPS hosts with an anonymous-clone warning", async () => {
    const attach = mock(() => {});
    const result = await attachManualRepository({
      repository: {
        id: 1,
        url: "https://git.example.com/acme/app.git",
        ref: "main",
        expectedCommitSha: "b".repeat(40),
      },
      workspaceRepositories: [],
      personalRepositories: [],
      selectWorkspaceRepository: () => {},
      selectPersonalRepository: () => {},
      verifyPublicGitHubRepository: async () => {
        throw new Error("not used");
      },
      attach,
      remove: () => {},
    });
    expect(result).toEqual({ warning: ANONYMOUS_REPOSITORY_WARNING });
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({ attached: true, expectedCommitSha: undefined }),
    );
  });
});
