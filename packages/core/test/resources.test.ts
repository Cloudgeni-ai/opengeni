import { describe, expect, test } from "bun:test";
import {
  normalizeResources,
  personalGitHubRepositoryResources,
  validateGitHubRepositorySelectionShapes,
} from "../src/domain/resources";

describe("repository resource normalization", () => {
  test("preserves Azure DevOps clone paths without appending a GitHub-style suffix", () => {
    expect(
      normalizeResources([
        {
          kind: "repository",
          uri: "https://cloudgeni@dev.azure.com/cloudgeni/cloudgeni-bicep-demo/_git/cloudgeni-bicep-demo",
          ref: "main",
          provider: "azure_devops",
          connectionId: "azure-devops-cloudgeni",
        },
      ])[0],
    ).toEqual({
      kind: "repository",
      uri: "https://dev.azure.com/cloudgeni/cloudgeni-bicep-demo/_git/cloudgeni-bicep-demo",
      ref: "main",
      provider: "azure_devops",
      connectionId: "azure-devops-cloudgeni",
      mountPath: "repos/dev.azure.com/cloudgeni/cloudgeni-bicep-demo/_git/cloudgeni-bicep-demo",
    });
  });

  test("preserves a trailing .git when it is part of an Azure DevOps repository path", () => {
    expect(
      normalizeResources([
        {
          kind: "repository",
          uri: "https://acme.visualstudio.com/platform/_git/infrastructure.git",
          ref: "main",
          provider: "azure_devops",
        },
      ])[0],
    ).toMatchObject({
      uri: "https://acme.visualstudio.com/platform/_git/infrastructure.git",
      mountPath: "repos/acme.visualstudio.com/platform/_git/infrastructure.git",
    });
  });

  test("preserves provider-defined paths instead of manufacturing suffixes", () => {
    expect(
      normalizeResources([
        {
          kind: "repository",
          uri: "https://github.com/acme/platform",
          ref: "main",
          provider: "github",
        },
      ])[0]?.uri,
    ).toBe("https://github.com/acme/platform");
  });

  test("uses exact paths for provider-neutral repositories", () => {
    expect(
      normalizeResources([
        {
          kind: "repository",
          uri: "https://dev.azure.com/acme/project/_git/public",
          ref: "main",
        },
      ])[0]?.uri,
    ).toBe("https://dev.azure.com/acme/project/_git/public");
  });

  test("keeps exact-path repositories that differ only by .git distinct", () => {
    expect(
      normalizeResources([
        {
          kind: "repository",
          uri: "https://dev.azure.com/acme/project/_git/infrastructure",
          ref: "main",
          provider: "azure_devops",
          credentialBindingId: "azure-one",
        },
        {
          kind: "repository",
          uri: "https://dev.azure.com/acme/project/_git/infrastructure.git",
          ref: "main",
          provider: "azure_devops",
          credentialBindingId: "azure-two",
        },
      ]).map(({ uri, mountPath }) => ({ uri, mountPath })),
    ).toEqual([
      {
        uri: "https://dev.azure.com/acme/project/_git/infrastructure",
        mountPath: "repos/dev.azure.com/acme/project/_git/infrastructure",
      },
      {
        uri: "https://dev.azure.com/acme/project/_git/infrastructure.git",
        mountPath: "repos/dev.azure.com/acme/project/_git/infrastructure.git",
      },
    ]);
  });

  test("separates personal GitHub bindings from GitHub App aliases", () => {
    const resource = {
      kind: "repository" as const,
      uri: "https://github.com/octocat/private-repository",
      ref: "main",
      provider: "github" as const,
      connectionType: "github_personal" as const,
      credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      repositoryId: "9007199254740993123",
      access: "write" as const,
    };
    expect(personalGitHubRepositoryResources([resource])).toEqual([resource]);
    const appResource = {
      ...resource,
      connectionType: undefined,
      credentialBindingId: "github-primary",
      repositoryId: 456,
      installationId: 123,
    };
    expect(personalGitHubRepositoryResources([appResource])).toEqual([]);
    expect(validateGitHubRepositorySelectionShapes([appResource])).toEqual([123]);
    const establishedHostBinding = {
      kind: "repository" as const,
      uri: "https://github.com/Cloudgeni-ai/opengeni",
      ref: "main",
      provider: "github" as const,
      credentialBindingId: "github-installation:123",
      access: "read" as const,
    };
    expect(personalGitHubRepositoryResources([establishedHostBinding])).toEqual([]);
    expect(validateGitHubRepositorySelectionShapes([establishedHostBinding])).toEqual([]);
    const opaqueUuidHostBinding = {
      ...establishedHostBinding,
      credentialBindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    expect(personalGitHubRepositoryResources([opaqueUuidHostBinding])).toEqual([]);
    expect(validateGitHubRepositorySelectionShapes([opaqueUuidHostBinding])).toEqual([]);
    expect(() =>
      personalGitHubRepositoryResources([
        {
          ...resource,
          repositoryId: undefined,
        },
      ]),
    ).toThrow();
    expect(() =>
      personalGitHubRepositoryResources([
        { ...resource, uri: "https://github.com/octocat/private-repository.git" },
      ]),
    ).toThrow();
    expect(() => personalGitHubRepositoryResources([resource, resource])).toThrow();
  });
});
