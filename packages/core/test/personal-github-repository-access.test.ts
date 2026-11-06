import { afterEach, describe, expect, test } from "bun:test";
import type { PersonalGitHubRepositorySelectionState } from "@opengeni/db";

import {
  clearPersonalGitHubRepositoryAccessCache,
  livePersonalGitHubRepository,
  personalGitHubAcceptedSelectionCovers,
  personalGitHubRepositoryAuthority,
  type PersonalGitHubAcceptedRepositorySelection,
} from "../src/domain/personal-github-repository-access";

const bindingId = "11111111-1111-4111-8111-111111111111";
const metadata = { credentialBindingId: bindingId, providerPrincipalId: "9", githubUserId: "9" };
const listed = {
  repositoryId: "42",
  fullName: "acme/listed",
  canonicalUrl: "https://github.com/acme/listed",
  defaultBranch: "main",
  visibility: "private" as const,
  private: true,
  archived: false,
  disabled: false,
  permissions: { pull: true, push: true, admin: false, maintain: false, triage: false },
  selectedAccess: "write" as const,
  selectionGeneration: 3,
  selectedAt: "2026-11-01T00:00:00.000Z",
  lastVerifiedAt: "2026-11-01T00:00:00.000Z",
};

function current(
  overrides: Partial<PersonalGitHubRepositorySelectionState> = {},
): PersonalGitHubRepositorySelectionState {
  return {
    connectionAuthorityGeneration: 2,
    credentialBindingId: bindingId,
    providerPrincipalId: "9",
    selectionGeneration: 3,
    allRepositoriesAccess: null,
    repositories: [listed],
    ...overrides,
  };
}

function accepted(
  overrides: Partial<PersonalGitHubAcceptedRepositorySelection> = {},
): PersonalGitHubAcceptedRepositorySelection {
  return {
    credentialBindingId: bindingId,
    connectionAuthorityGeneration: 2,
    selectionGeneration: 3,
    repositories: [
      {
        repositoryId: "42",
        fullName: "acme/listed",
        canonicalUrl: "https://github.com/acme/listed",
        ref: "main",
        access: "write",
        selectionGeneration: 3,
      },
    ],
    ...overrides,
  };
}

afterEach(() => clearPersonalGitHubRepositoryAccessCache());

describe("personalGitHubRepositoryAuthority", () => {
  test("only these repositories: the listed one at its access", () => {
    const decision = personalGitHubRepositoryAuthority({
      current: current(),
      metadata,
      repository: { repositoryId: "42" },
      access: "write",
    });
    expect(decision).toMatchObject({ allowed: true, mode: "selected" });
    expect(
      personalGitHubRepositoryAuthority({
        current: current(),
        metadata,
        repository: { fullName: "acme/other" },
        access: "read",
      }),
    ).toEqual({ allowed: false, reason: "not_selected" });
  });

  test("All my repositories: any repository up to the chosen access", () => {
    const all = current({ allRepositoriesAccess: "read" });
    expect(
      personalGitHubRepositoryAuthority({
        current: all,
        metadata,
        repository: { fullName: "acme/other" },
        access: "read",
      }),
    ).toEqual({ allowed: true, mode: "all", allRepositoriesAccess: "read" });
    expect(
      personalGitHubRepositoryAuthority({
        current: all,
        metadata,
        repository: { fullName: "acme/other" },
        access: "write",
      }),
    ).toEqual({ allowed: false, reason: "write_denied" });
  });

  test("accepted All my repositories work keeps working while the mode stays on", () => {
    const snapshot = accepted({ allRepositoriesAccess: "write", repositories: [] });
    // A later save bumps the generation; the mode is still on.
    const later = current({ allRepositoriesAccess: "write", selectionGeneration: 9 });
    expect(
      personalGitHubRepositoryAuthority({
        current: later,
        metadata,
        accepted: snapshot,
        repository: { fullName: "acme/other" },
        access: "write",
      }).allowed,
    ).toBe(true);
    // Turned off: the repository is not on the list, so it stops.
    expect(
      personalGitHubRepositoryAuthority({
        current: current({ selectionGeneration: 10 }),
        metadata,
        accepted: snapshot,
        repository: { fullName: "acme/other" },
        access: "read",
      }),
    ).toEqual({ allowed: false, reason: "selection_changed" });
    // Narrowed to read: writes stop.
    expect(
      personalGitHubRepositoryAuthority({
        current: current({ allRepositoriesAccess: "read", selectionGeneration: 10 }),
        metadata,
        accepted: snapshot,
        repository: { fullName: "acme/other" },
        access: "write",
      }),
    ).toEqual({ allowed: false, reason: "write_denied" });
  });

  test("per-repository work keeps working after All my repositories is turned on", () => {
    expect(
      personalGitHubRepositoryAuthority({
        current: current({ allRepositoriesAccess: "write", selectionGeneration: 4 }),
        metadata,
        accepted: accepted(),
        repository: { repositoryId: "42", fullName: "acme/listed" },
        access: "write",
      }).allowed,
    ).toBe(true);
  });

  test("accepted work never reaches past its snapshot or a changed connection", () => {
    expect(
      personalGitHubRepositoryAuthority({
        current: current({ allRepositoriesAccess: "write" }),
        metadata,
        accepted: accepted(),
        repository: { fullName: "acme/other" },
        access: "read",
      }),
    ).toEqual({ allowed: false, reason: "outside_accepted_work" });
    expect(
      personalGitHubRepositoryAuthority({
        current: current({ connectionAuthorityGeneration: 5 }),
        metadata,
        accepted: accepted(),
        repository: { repositoryId: "42" },
        access: "read",
      }),
    ).toEqual({ allowed: false, reason: "connection_changed" });
    expect(
      personalGitHubAcceptedSelectionCovers(
        accepted({ allRepositoriesAccess: "read" }),
        { fullName: "x/y" },
        "write",
      ),
    ).toBe(false);
  });
});

describe("livePersonalGitHubRepository", () => {
  const payload = {
    id: 77,
    full_name: "acme/widgets",
    default_branch: "trunk",
    visibility: "private",
    private: true,
    archived: false,
    disabled: false,
    permissions: { pull: true, push: false, admin: false, maintain: false, triage: false },
  };

  test("asks GitHub once per minute per repository and caches not found", async () => {
    let calls = 0;
    let now = 1_000;
    const githubGet = async (url: URL) => {
      calls += 1;
      return url.pathname.toLowerCase() === "/repos/acme/widgets"
        ? new Response(JSON.stringify(payload))
        : new Response("{}", { status: 404 });
    };
    const read = () =>
      livePersonalGitHubRepository({
        cacheScope: "c",
        repository: { fullName: "Acme/Widgets" },
        githubGet,
        now: () => now,
      });
    expect((await read())?.repositoryId).toBe("77");
    expect(await read()).not.toBeNull();
    // The id lookup shares the entry.
    expect(
      await livePersonalGitHubRepository({
        cacheScope: "c",
        repository: { repositoryId: "77" },
        githubGet,
        now: () => now,
      }),
    ).not.toBeNull();
    expect(calls).toBe(1);
    now += 61_000;
    await read();
    expect(calls).toBe(2);
    const missing = { cacheScope: "c", repository: { fullName: "acme/gone" }, githubGet };
    expect(await livePersonalGitHubRepository(missing)).toBeNull();
    expect(await livePersonalGitHubRepository(missing)).toBeNull();
    expect(calls).toBe(3);
  });

  test("a GitHub failure throws and is not cached", async () => {
    let calls = 0;
    const githubGet = async () => {
      calls += 1;
      return new Response("{}", { status: 502 });
    };
    const input = { cacheScope: "c", repository: { fullName: "acme/widgets" }, githubGet };
    await expect(livePersonalGitHubRepository(input)).rejects.toThrow();
    await expect(livePersonalGitHubRepository(input)).rejects.toThrow();
    expect(calls).toBe(2);
  });

  test("rejects names GitHub could not have", async () => {
    const githubGet = async () => {
      throw new Error("must not be called");
    };
    expect(
      await livePersonalGitHubRepository({
        cacheScope: "c",
        repository: { fullName: "../../user" },
        githubGet,
      }),
    ).toBeNull();
  });
});
