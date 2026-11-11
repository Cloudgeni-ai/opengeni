import { describe, expect, test } from "bun:test";
import type {
  AccessGrant,
  McpPersonalConnectionDelegation,
  ResourceRef,
} from "@opengeni/contracts";
import {
  personalGitHubAllRepositoriesEffectiveAccess,
  personalGitHubAccessCovers,
  type PersonalGitHubRepository,
} from "@opengeni/contracts/personal-github";
import type {
  PersonalGitHubRepositorySelectionState,
  SessionRepositoryMembership,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

import {
  isUnresolvedPersonalGitHubRepositoryResource,
  personalGitHubRepositoryFullNameFromUri,
  resolveAgentPersonalGitHubRepositoryResources,
  type ResolveAgentPersonalGitHubRepositoryServices,
} from "../src/domain/agent-personal-github-resources";
import { personalConnectionDelegationsFromParent } from "../src/domain/personal-connection-delegations";
import {
  personalGitHubRepositoryAuthority,
  personalGitHubRepositoryDenialMessage,
  type PersonalGitHubRepositoryAccessResult,
} from "../src/domain/personal-github-repository-access";
import { normalizeResources, personalGitHubRepositoryResources } from "../src/domain/resources";

const bindingId = "11111111-1111-4111-8111-111111111111";
const otherBindingId = "22222222-2222-4222-8222-222222222222";
const metadata = { credentialBindingId: bindingId, providerPrincipalId: "9", githubUserId: "9" };
const parentSessionId = "33333333-3333-4333-8333-333333333333";
const parentTurnId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "55555555-5555-4555-8555-555555555555";

const permissions = { pull: true, push: true, admin: false, maintain: false, triage: false };
const listed = {
  repositoryId: "42",
  fullName: "Acme/Listed",
  canonicalUrl: "https://github.com/Acme/Listed",
  defaultBranch: "main",
  visibility: "private" as const,
  private: true,
  archived: false,
  disabled: false,
  permissions,
  selectedAccess: "write" as const,
  selectionGeneration: 3,
  selectedAt: "2026-11-01T00:00:00.000Z",
  lastVerifiedAt: "2026-11-01T00:00:00.000Z",
};
const unlisted: PersonalGitHubRepository = {
  repositoryId: "77",
  fullName: "acme/elsewhere",
  canonicalUrl: "https://github.com/acme/elsewhere",
  defaultBranch: "main",
  visibility: "private",
  private: true,
  archived: false,
  disabled: false,
  permissions,
};

function agentGrant(): AccessGrant {
  return {
    accountId: "66666666-6666-4666-8666-666666666666",
    workspaceId,
    subjectId: "agent:attempt",
    principalKind: "agent_attempt",
    permissions: ["sessions:create"],
    metadata: { sessionId: parentSessionId, turnId: parentTurnId },
  } as unknown as AccessGrant;
}

function delegation(
  selection: NonNullable<McpPersonalConnectionDelegation["personalGitHubRepositorySelection"]>,
): McpPersonalConnectionDelegation {
  return {
    serverId: "github:personal",
    connectionId: "connection-1",
    originWorkspaceId: workspaceId,
    ownerSubjectId: "user:person",
    providerDomain: "github.com",
    kind: "oauth2",
    connectionType: "github_personal",
    personalGitHubRepositorySelection: selection,
  };
}

/** The chosen list holds Acme/Listed (write) and this chat attached it as the person. */
const listedTurn = delegation({
  credentialBindingId: bindingId,
  connectionAuthorityGeneration: 2,
  selectionGeneration: 3,
  repositories: [
    {
      repositoryId: listed.repositoryId,
      fullName: listed.fullName,
      canonicalUrl: listed.canonicalUrl,
      ref: "main",
      access: "write",
      selectionGeneration: 3,
    },
  ],
});

/** All my repositories with the given access, no repository attached to the chat. */
function allTurn(access: "read" | "write"): McpPersonalConnectionDelegation {
  return delegation({
    credentialBindingId: bindingId,
    connectionAuthorityGeneration: 2,
    selectionGeneration: 5,
    allRepositoriesAccess: access,
    repositories: [],
  });
}

function currentState(
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

/**
 * The shared allowlist decision over a fixed current state, with GitHub's
 * live answer for All my repositories (as checkPersonalGitHubRepositoryAccess
 * does with the database and GitHub).
 */
function services(input: {
  turn: McpPersonalConnectionDelegation[];
  current: PersonalGitHubRepositorySelectionState;
  github?: PersonalGitHubRepository[];
  membership?: SessionRepositoryMembership;
}): ResolveAgentPersonalGitHubRepositoryServices & { checked: string[] } {
  const checked: string[] = [];
  const deny = (
    reason: Extract<PersonalGitHubRepositoryAccessResult, { allowed: false }>["reason"],
  ): PersonalGitHubRepositoryAccessResult => ({
    allowed: false,
    reason,
    message: personalGitHubRepositoryDenialMessage(reason),
  });
  return {
    checked,
    loadTurnDelegations: async (request) => {
      expect(request).toEqual({ workspaceId, sessionId: parentSessionId, turnId: parentTurnId });
      return input.turn;
    },
    loadSessionMembership: async () =>
      input.membership ?? { resources: [], removedRepositories: [] },
    checkAccess: async ({ delegation: used, accepted, repository, access }) => {
      expect(used.connectionId).toBe("connection-1");
      checked.push(`${repository.fullName}:${access}`);
      const decision = personalGitHubRepositoryAuthority({
        current: input.current,
        metadata,
        accepted,
        repository,
        access,
      });
      if (!decision.allowed) return deny(decision.reason);
      if (decision.mode === "selected") {
        return {
          allowed: true,
          mode: "selected",
          access: decision.selected.selectedAccess,
          repository: decision.selected,
          githubLogin: "octocat",
        };
      }
      const live = (input.github ?? []).find(
        (candidate) => candidate.fullName.toLowerCase() === repository.fullName?.toLowerCase(),
      );
      if (!live) return deny("not_found");
      const effective = personalGitHubAllRepositoriesEffectiveAccess(
        decision.allRepositoriesAccess,
        live,
      );
      if (!effective) return deny("read_denied");
      if (!personalGitHubAccessCovers(effective, access)) return deny("write_denied");
      return {
        allowed: true,
        mode: "all",
        access: effective,
        repository: live,
        githubLogin: "octocat",
      };
    },
  };
}

async function resolve(
  resources: ResourceRef[],
  deps: ResolveAgentPersonalGitHubRepositoryServices,
  grant: AccessGrant = agentGrant(),
) {
  return await resolveAgentPersonalGitHubRepositoryResources({
    grant,
    workspaceId,
    settings: { githubPersonalOauthEnabled: true },
    resources,
    services: deps,
  });
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).status).toBe(422);
    return (error as HTTPException).message;
  }
  throw new Error("expected a rejection");
}

function simple(uri: string, extra: Partial<ResourceRef> = {}): ResourceRef {
  return {
    kind: "repository",
    uri,
    ref: "main",
    connectionType: "github_personal",
    ...extra,
  } as ResourceRef;
}

describe("agent-named personal GitHub repositories", () => {
  test("recognizes the simple shape and GitHub repository names", () => {
    expect(isUnresolvedPersonalGitHubRepositoryResource(simple("https://github.com/a/b"))).toBe(
      true,
    );
    expect(
      isUnresolvedPersonalGitHubRepositoryResource({
        ...simple("https://github.com/a/b"),
        provider: "github",
        credentialBindingId: bindingId,
        repositoryId: "1",
        access: "read",
      } as ResourceRef),
    ).toBe(false);
    expect(
      isUnresolvedPersonalGitHubRepositoryResource({
        kind: "repository",
        uri: "https://github.com/a/b",
        ref: "main",
      }),
    ).toBe(false);
    for (const uri of [
      "https://github.com/Acme/Listed.git",
      "https://github.com/Acme/Listed/",
      "https://www.github.com/Acme/Listed",
      "git@github.com:Acme/Listed.git",
      "Acme/Listed",
    ]) {
      expect(personalGitHubRepositoryFullNameFromUri(uri)).toBe("Acme/Listed");
    }
    for (const uri of [
      "https://gitlab.com/acme/listed",
      "https://github.com/acme",
      "https://github.com/acme/listed/tree/main",
      "https://user:pw@github.com/acme/listed",
    ]) {
      expect(personalGitHubRepositoryFullNameFromUri(uri)).toBeNull();
    }
  });

  test("a repository in the turn's chosen list resolves to the turn's binding, id and access", async () => {
    const deps = services({ turn: [listedTurn], current: currentState() });
    const resolved = await resolve(
      [
        simple("https://github.com/acme/listed.git", { ref: "feature/x" }),
        { kind: "file", fileId: "file-1" } as ResourceRef,
      ],
      deps,
    );
    expect(resolved).toEqual([
      {
        kind: "repository",
        uri: "https://github.com/Acme/Listed",
        ref: "feature/x",
        provider: "github",
        connectionType: "github_personal",
        credentialBindingId: bindingId,
        repositoryId: "42",
        access: "write",
      },
      { kind: "file", fileId: "file-1" },
    ]);
    // The child admission accepts it and inherits the person's delegation for
    // that repository, on the requested branch.
    const repositories = normalizeResources(
      resolved.filter((resource) => resource.kind === "repository"),
    );
    expect(personalGitHubRepositoryResources(repositories)).toHaveLength(1);
    const [child] = personalConnectionDelegationsFromParent({
      servers: [],
      parentDelegations: [listedTurn],
      personalGitHubResources: repositories,
    });
    expect(child).toMatchObject({
      connectionId: "connection-1",
      ownerSubjectId: "user:person",
      connectionType: "github_personal",
    });
    expect(child?.personalGitHubRepositorySelection?.repositories).toEqual([
      expect.objectContaining({ repositoryId: "42", ref: "feature/x", access: "write" }),
    ]);
  });

  test("the turn's own access is the ceiling: read when the chat holds read", async () => {
    const readTurn = delegation({
      ...listedTurn.personalGitHubRepositorySelection!,
      repositories: [
        { ...listedTurn.personalGitHubRepositorySelection!.repositories[0]!, access: "read" },
      ],
    });
    const deps = services({ turn: [readTurn], current: currentState() });
    expect(await resolve([simple("https://github.com/Acme/Listed")], deps)).toEqual([
      expect.objectContaining({ repositoryId: "42", access: "read" }),
    ]);
    // Asking for write is refused, with what fixes it; nothing is widened.
    const message = await rejection(
      resolve([simple("https://github.com/Acme/Listed", { access: "write" })], deps),
    );
    expect(message).toContain("Acme/Listed");
    expect(message).toContain('access "read"');
  });

  test("All my repositories resolves any repository the person can reach, capped at the mode", async () => {
    const readOnly = services({
      turn: [allTurn("read")],
      current: currentState({
        selectionGeneration: 5,
        allRepositoriesAccess: "read",
        allRepositoriesGeneration: 5,
      }),
      github: [unlisted],
    });
    const [resolved] = await resolve([simple("https://github.com/acme/elsewhere")], readOnly);
    // GitHub would let the person push, but the mode is read only.
    expect(resolved).toEqual({
      kind: "repository",
      uri: "https://github.com/acme/elsewhere",
      ref: "main",
      provider: "github",
      connectionType: "github_personal",
      credentialBindingId: bindingId,
      repositoryId: "77",
      access: "read",
    });
    expect(
      personalConnectionDelegationsFromParent({
        servers: [],
        parentDelegations: [allTurn("read")],
        personalGitHubResources: [resolved!],
      })[0]?.personalGitHubRepositorySelection?.repositories,
    ).toEqual([expect.objectContaining({ repositoryId: "77", access: "read" })]);
    await rejection(
      resolve([simple("https://github.com/acme/elsewhere", { access: "write" })], readOnly),
    );

    const readWrite = services({
      turn: [allTurn("write")],
      current: currentState({
        selectionGeneration: 5,
        allRepositoriesAccess: "write",
        allRepositoriesGeneration: 5,
      }),
      github: [
        unlisted,
        {
          ...unlisted,
          repositoryId: "78",
          fullName: "acme/readonly",
          permissions: { ...permissions, push: false },
        },
      ],
    });
    expect(await resolve([simple("https://github.com/acme/elsewhere")], readWrite)).toEqual([
      expect.objectContaining({ repositoryId: "77", access: "write" }),
    ]);
    // GitHub's own permission still lowers it.
    expect(await resolve([simple("https://github.com/acme/readonly")], readWrite)).toEqual([
      expect.objectContaining({ repositoryId: "78", access: "read" }),
    ]);
    expect(
      await rejection(resolve([simple("https://github.com/acme/missing")], readWrite)),
    ).toContain("GitHub has no repository acme/missing");
  });

  test("a repository outside the turn's delegation is refused with what fixes it", async () => {
    const deps = services({ turn: [listedTurn], current: currentState() });
    const message = await rejection(resolve([simple("https://github.com/acme/elsewhere")], deps));
    expect(message).toBe(
      "acme/elsewhere is not part of this turn's Your GitHub access. The person can attach it to this chat as themselves or turn on All my repositories, then send a new message.",
    );
    // The person's own list now holding the repository does not widen this turn.
    const widened = services({
      turn: [listedTurn],
      current: currentState({
        repositories: [
          listed,
          { ...listed, ...unlisted, selectedAccess: "write" as const, selectionGeneration: 3 },
        ],
      }),
    });
    await rejection(resolve([simple("https://github.com/acme/elsewhere")], widened));
    // All my repositories turned on after the turn was accepted does not either.
    const turnedOnLater = services({
      turn: [listedTurn],
      current: currentState({
        selectionGeneration: 4,
        allRepositoriesAccess: "write",
        allRepositoriesGeneration: 4,
      }),
      github: [unlisted],
    });
    await rejection(resolve([simple("https://github.com/acme/elsewhere")], turnedOnLater));
  });

  test("a turn without Your GitHub gets a clear, actionable refusal", async () => {
    const deps = services({ turn: [], current: currentState() });
    const message = await rejection(resolve([simple("https://github.com/Acme/Listed")], deps));
    expect(message).toContain("no Your GitHub access to pass on");
    expect(message).toContain("All my repositories");
    expect(message).toContain("Omit connectionType");
    expect(deps.checked).toEqual([]);
    expect(await rejection(resolve([simple("https://gitlab.com/acme/listed")], deps))).toContain(
      "https://github.com/<owner>/<repo>",
    );
    expect(
      await rejection(
        resolveAgentPersonalGitHubRepositoryResources({
          grant: agentGrant(),
          workspaceId,
          settings: { githubPersonalOauthEnabled: false },
          resources: [simple("https://github.com/Acme/Listed")],
          services: deps,
        }),
      ),
    ).toContain("not enabled");
  });

  test("a repository a person removed from the calling chat stays refused", async () => {
    const deps = services({
      turn: [allTurn("write")],
      current: currentState({
        selectionGeneration: 5,
        allRepositoriesAccess: "write",
        allRepositoriesGeneration: 5,
      }),
      github: [unlisted],
      membership: {
        resources: [],
        removedRepositories: [
          {
            resource: { kind: "repository", uri: "https://github.com/acme/elsewhere", ref: "main" },
            removedAt: "2026-11-01T00:00:00.000Z",
          } as SessionRepositoryMembership["removedRepositories"][number],
        ],
      },
    });
    expect(await rejection(resolve([simple("https://github.com/acme/elsewhere")], deps))).toContain(
      "removed acme/elsewhere from this chat",
    );
  });

  test("other callers and fully specified resources pass through unchanged", async () => {
    const deps = services({ turn: [listedTurn], current: currentState() });
    const resources = [simple("https://github.com/Acme/Listed")];
    const human = {
      ...agentGrant(),
      principalKind: "human_session",
      subjectId: "user:person",
      metadata: {},
    } as unknown as AccessGrant;
    expect(await resolve(resources, deps, human)).toBe(resources);
    // Another person's binding is not filled in or swapped: the parent check refuses it.
    const foreign = {
      ...simple("https://github.com/Acme/Listed"),
      provider: "github",
      credentialBindingId: otherBindingId,
      repositoryId: "42",
      access: "write",
    } as ResourceRef;
    expect(await resolve([foreign], deps)).toEqual([foreign]);
    expect(deps.checked).toEqual([]);
    expect(() =>
      personalConnectionDelegationsFromParent({
        servers: [],
        parentDelegations: [listedTurn],
        personalGitHubResources: [{ ...foreign, uri: "https://github.com/Acme/Listed" }],
      }),
    ).toThrow("exceeds parent authority");
    // A person or API caller sending the simple shape gets the strict check,
    // whose message names both shapes.
    expect(() =>
      personalGitHubRepositoryResources(
        normalizeResources([simple("https://github.com/Acme/Listed")]),
      ),
    ).toThrow("can name just uri, ref and connectionType");
  });

  test("partly specified resources are completed and what was given is checked", async () => {
    const deps = services({ turn: [listedTurn], current: currentState() });
    // Copied from a parent without access, or with stray App fields.
    expect(
      await resolve(
        [
          simple("https://github.com/Acme/Listed", {
            provider: "github",
            credentialBindingId: bindingId,
            repositoryId: "42",
          }),
          simple("https://github.com/Acme/Listed", { connectionId: "app-connection" }),
        ],
        deps,
      ),
    ).toEqual([
      expect.objectContaining({ repositoryId: "42", access: "write" }),
      expect.not.objectContaining({ connectionId: expect.anything() }),
    ]);
    expect(
      await rejection(
        resolve(
          [simple("https://github.com/Acme/Listed", { credentialBindingId: otherBindingId })],
          deps,
        ),
      ),
    ).toContain("is not this turn's Your GitHub account");
    expect(
      await rejection(
        resolve([simple("https://github.com/Acme/Listed", { repositoryId: "43" })], deps),
      ),
    ).toContain("repositoryId given does not match Acme/Listed");
  });

  test("without a requested level, write only when the person can push now", async () => {
    const archived = services({
      turn: [listedTurn],
      current: currentState({ repositories: [{ ...listed, archived: true }] }),
    });
    expect(await resolve([simple("https://github.com/Acme/Listed")], archived)).toEqual([
      expect.objectContaining({ repositoryId: "42", access: "read" }),
    ]);
  });

  test("a mode narrowed after the turn started refuses, and says a new message fixes it", async () => {
    const narrowed = services({
      turn: [allTurn("write")],
      current: currentState({
        selectionGeneration: 6,
        allRepositoriesAccess: "read",
        allRepositoriesGeneration: 6,
      }),
      github: [unlisted],
    });
    const message = await rejection(
      resolve([simple("https://github.com/acme/elsewhere", { access: "read" })], narrowed),
    );
    expect(message).toContain("changed since this turn started");
    expect(message).toContain("The person needs to send a new message");
  });

  test("ambiguous accounts and a missing chat get their own messages", async () => {
    const twoAccounts = services({
      turn: [listedTurn, { ...listedTurn, connectionId: "connection-1" }],
      current: currentState(),
    });
    expect(
      await rejection(resolve([simple("https://github.com/Acme/Listed")], twoAccounts)),
    ).toContain("more than one Your GitHub account");
    const noChat = {
      ...services({ turn: [listedTurn], current: currentState() }),
      loadSessionMembership: async () => null,
    };
    expect(await rejection(resolve([simple("https://github.com/Acme/Listed")], noChat))).toContain(
      "This chat could not be found",
    );
  });
});
