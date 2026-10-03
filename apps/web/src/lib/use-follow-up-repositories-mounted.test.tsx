import { describe, expect, mock, test } from "bun:test";
import { act } from "react";

import { registerDom, renderHook } from "../../../../packages/react/test/render-hook";

registerDom();

const repository = {
  id: 101,
  installationId: 42,
  fullName: "acme/api",
  name: "api",
  private: true,
  htmlUrl: "https://github.com/acme/api",
  cloneUrl: "https://github.com/acme/api.git",
  defaultBranch: "main",
  accountLogin: "acme",
  accountType: "Organization",
};
const context = {
  accessContext: {
    mode: "local",
    subjectId: "user:a",
    accountGrants: [],
    defaultAccountId: null,
    defaultWorkspaceId: null,
    workspaceGrants: [
      {
        workspaceId: "workspace-1",
        accountId: "account-1",
        subjectId: "user:a",
        permissions: ["github:use", "sessions:control"],
      },
    ],
  },
  captureWorkspaceInvocation: () => ({ workspaceId: "workspace-1", revision: 1 }),
  refreshGitHub: async () => {},
  refreshPersonalGitHub: async () => {},
  repoBusy: false,
  personalGitHubBusy: false,
  githubRepos: [repository],
  personalGitHubRepositories: [],
  personalGitHubSelection: null,
  // Read only to build the picker's display props.
  githubStatus: null,
  clientConfig: { productAccessMode: "local" },
  personalGitHubStatus: null,
  repositoryGroups: [],
  githubAppOpen: false,
  githubOrg: "",
  busy: false,
  githubAppBusy: false,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
const { useFollowUpRepositories } = await import("./use-follow-up-repositories");

const session = (resources: unknown[]) =>
  ({ id: "session-1", workspaceId: "workspace-1", resources }) as never;

describe("follow-up repositories", () => {
  test("a pending pick mounted elsewhere on another branch neither resends nor blocks Send", async () => {
    const hook = await renderHook(
      (props: { resources: unknown[] }) =>
        useFollowUpRepositories(session(props.resources), () => {}),
      { resources: [] as unknown[] },
    );
    await act(async () => {
      hook.result.current.pickerProps(false).onToggleRepo(repository);
    });
    await act(async () => {
      hook.result.current.pickerProps(false).onRefChange(repository.id, "release");
    });
    expect(hook.result.current.pendingResources).toHaveLength(1);
    // A conversation card attached the same repository on its default branch.
    await hook.rerender({
      resources: [
        {
          kind: "repository",
          uri: "https://github.com/acme/api.git",
          ref: "main",
          provider: "github",
          mountPath: "repos/github.com/acme/api",
          githubRepositoryId: 101,
          githubInstallationId: 42,
        },
      ],
    });
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.pendingResources).toEqual([]);
    await hook.unmount();
  });
});
