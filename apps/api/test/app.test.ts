import { describe, expect, test } from "bun:test";
import { normalizeResources, validateGitHubRepositorySelection, workflowIdForSession } from "../src/app";

describe("API helpers", () => {
  test("normalizes repository resources into sandbox mount metadata", () => {
    const [resource] = normalizeResources([{
      kind: "repository",
      uri: "https://github.com/OpenAI/example.git",
      metadata: { ref: "main", subpath: "/infra/" },
    }]);

    expect(resource).toEqual({
      kind: "repository",
      uri: "https://github.com/OpenAI/example.git",
      metadata: {
        ref: "main",
        subpath: "infra",
        host: "github.com",
        repo: "OpenAI/example",
        mount_path: "repos/OpenAI/example",
      },
    });
  });

  test("rejects repository resources without refs", () => {
    expect(() => normalizeResources([{
      kind: "repository",
      uri: "https://github.com/openai/example.git",
      metadata: {},
    }])).toThrow("repository resources require metadata.ref");
  });

  test("uses stable workflow ids for sessions", () => {
    expect(workflowIdForSession("abc")).toBe("session-abc");
  });

  test("rejects selected GitHub App repos from multiple installations", () => {
    expect(() => validateGitHubRepositorySelection([
      {
        kind: "repository",
        uri: "https://github.com/a/one.git",
        metadata: { github_installation_id: 1, github_repository_id: 11 },
      },
      {
        kind: "repository",
        uri: "https://github.com/b/two.git",
        metadata: { github_installation_id: 2, github_repository_id: 22 },
      },
    ])).toThrow("one installation");
  });

  test("rejects incomplete GitHub App repository metadata", () => {
    expect(() => validateGitHubRepositorySelection([
      {
        kind: "repository",
        uri: "https://github.com/a/one.git",
        metadata: { github_installation_id: 1 },
      },
    ])).toThrow("positive github_installation_id");
  });
});
