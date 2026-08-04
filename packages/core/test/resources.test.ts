import { describe, expect, test } from "bun:test";
import { normalizeResources } from "../src/domain/resources";

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
      ])[0]?.uri,
    ).toBe("https://acme.visualstudio.com/platform/_git/infrastructure.git");
  });

  test("retains canonical .git suffixes for other HTTPS Git providers", () => {
    expect(
      normalizeResources([
        {
          kind: "repository",
          uri: "https://github.com/acme/platform",
          ref: "main",
          provider: "github",
        },
      ])[0]?.uri,
    ).toBe("https://github.com/acme/platform.git");
  });
});
