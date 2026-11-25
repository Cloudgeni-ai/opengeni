import { expect, test } from "bun:test";
import type { McpPersonalConnectionDelegation, ResourceRef } from "@opengeni/contracts";
import { projectPersonalGitHubDelegationsOntoResources } from "../src/personal-github-delegation-projection";

const BINDING = "bbc6992f-3363-4bc3-87a5-2d2daa074318";

function delegation(
  selection: Partial<
    NonNullable<McpPersonalConnectionDelegation["personalGitHubRepositorySelection"]>
  >,
): McpPersonalConnectionDelegation {
  return {
    serverId: "github_personal",
    connectionId: "00000000-0000-4000-8000-000000000001",
    originWorkspaceId: "00000000-0000-4000-8000-000000000002",
    ownerSubjectId: "user:bendik",
    providerDomain: "github.com",
    kind: "oauth2",
    connectionType: "github_personal",
    personalGitHubRepositorySelection: {
      credentialBindingId: BINDING,
      connectionAuthorityGeneration: 1,
      selectionGeneration: 3,
      repositories: [],
      ...selection,
    },
  } as McpPersonalConnectionDelegation;
}

function repository(name: string, id: string, access: "read" | "write", ref = "main"): ResourceRef {
  return {
    kind: "repository",
    provider: "github",
    connectionType: "github_personal",
    uri: `https://github.com/Cloudgeni-ai/${name}`,
    ref,
    access,
    repositoryId: id,
    credentialBindingId: BINDING,
  } as ResourceRef;
}

const held = {
  repositoryId: "1",
  fullName: "Cloudgeni-ai/opengeni",
  canonicalUrl: "https://github.com/Cloudgeni-ai/opengeni",
  ref: "feature",
  access: "write" as const,
  selectionGeneration: 3,
};

test("a steer from a session with other repositories fits the receiver's (the a4ff9ccc failure)", () => {
  // The sender's accepted list names its own repositories; the receiver works
  // on opengeni@main. All my repositories (write) covers it.
  const sender = delegation({ allRepositoriesAccess: "write", repositories: [] });
  const [projected] = projectPersonalGitHubDelegationsOntoResources(
    [sender],
    [repository("opengeni", "1", "write")],
  );
  expect(projected?.personalGitHubRepositorySelection?.repositories).toEqual([
    { ...held, ref: "main" },
  ]);
});

test("a repository the sender held keeps its accepted entry, with the receiver's ref and access", () => {
  const [projected] = projectPersonalGitHubDelegationsOntoResources(
    [delegation({ repositories: [held] })],
    [repository("opengeni", "1", "read", "main")],
  );
  expect(projected?.personalGitHubRepositorySelection?.repositories).toEqual([
    { ...held, ref: "main", access: "read" },
  ]);
});

test("never beyond the sender's authority: the turn runs without Your GitHub instead", () => {
  const readOnly = { ...held, access: "read" as const };
  // Write on a repository the sender only read, with no All my repositories.
  expect(
    projectPersonalGitHubDelegationsOntoResources(
      [delegation({ repositories: [readOnly] })],
      [repository("opengeni", "1", "write")],
    ),
  ).toEqual([]);
  // A repository the sender never held.
  expect(
    projectPersonalGitHubDelegationsOntoResources(
      [delegation({ repositories: [held] })],
      [repository("cloudgeni", "2", "read")],
    ),
  ).toEqual([]);
  // All my repositories at read never grants write.
  expect(
    projectPersonalGitHubDelegationsOntoResources(
      [delegation({ allRepositoriesAccess: "read" })],
      [repository("cloudgeni", "2", "write")],
    ),
  ).toEqual([]);
});

test("other delegations pass through; no personal repositories keeps only All my repositories", () => {
  const social = { ...delegation({}), connectionType: "social" } as McpPersonalConnectionDelegation;
  expect(projectPersonalGitHubDelegationsOntoResources([social], [])).toEqual([social]);
  expect(
    projectPersonalGitHubDelegationsOntoResources([delegation({ repositories: [held] })], []),
  ).toEqual([]);
  const all = delegation({ allRepositoriesAccess: "read", repositories: [held] });
  expect(
    projectPersonalGitHubDelegationsOntoResources([all], [])[0]?.personalGitHubRepositorySelection
      ?.repositories,
  ).toEqual([]);
});
