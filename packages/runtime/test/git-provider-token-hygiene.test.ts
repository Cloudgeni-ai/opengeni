// Shared-box hygiene for the legacy provider alias token files. A turn that
// carries no binding and no seed for a provider must not inherit the
// `$HOME/.opengeni/git-token` / `git-credentials/github-token` alias a sibling
// turn on the same box wrote; that stale token would authenticate this turn's
// clone, push, and `gh` calls until it expired mid-turn. Renewal commands must
// keep their narrower scope and never remove another provider's current alias.

import { describe, expect, test } from "bun:test";
import {
  gitCredentialBindingTokenRefreshCommand,
  gitProviderTokenRefreshCommand,
  repositoryCloneCommand,
} from "../src";

const publicRepo = {
  kind: "repository" as const,
  uri: "https://github.com/acme/public.git",
  ref: "main",
};

const githubBinding = {
  credentialBindingId: "github-installation:123",
  provider: "github" as const,
  token: "ghs_turn",
  expiresAt: "2026-07-14T11:00:00Z",
};

describe("stale provider token hygiene at setup", () => {
  test("a turn without a GitHub binding removes an inherited GitHub alias unless a seed is present", () => {
    const command = repositoryCloneCommand([publicRepo]);
    expect(command).toContain(
      '[ -n "${OPENGENI_GIT_GITHUB_TOKEN_SEED:-${OPENGENI_GIT_TOKEN_SEED:-}}" ] || remove_git_provider_token github',
    );
    expect(command).toContain(
      '[ -n "${OPENGENI_GIT_GITLAB_TOKEN_SEED:-}" ] || remove_git_provider_token gitlab',
    );
    expect(command).toContain(
      '[ -n "${OPENGENI_GIT_AZURE_DEVOPS_TOKEN_SEED:-}" ] || remove_git_provider_token azure_devops',
    );
    // The removal runs after the writer functions are defined and before the
    // helper/clone phase that would otherwise read the stale alias.
    expect(command.indexOf("remove_git_provider_token() {")).toBeLessThan(
      command.indexOf("|| remove_git_provider_token github"),
    );
    expect(command.indexOf("|| remove_git_provider_token github")).toBeLessThan(
      command.indexOf('git -C "$tmp" fetch'),
    );
  });

  test("a turn with a GitHub binding keeps its own alias and only removes unbound providers", () => {
    const command = repositoryCloneCommand(
      [{ ...publicRepo, githubInstallationId: 123, githubRepositoryId: 456 }],
      [githubBinding],
    );
    expect(command).not.toContain("|| remove_git_provider_token github");
    expect(command).toContain("|| remove_git_provider_token gitlab");
    expect(command).toContain("|| remove_git_provider_token azure_devops");
  });

  test("renewal commands never remove a sibling provider alias", () => {
    expect(gitCredentialBindingTokenRefreshCommand([githubBinding])).not.toContain(
      "|| remove_git_provider_token",
    );
    expect(gitProviderTokenRefreshCommand({ github: "ghs_renewed" })).not.toContain(
      "|| remove_git_provider_token",
    );
  });
});
