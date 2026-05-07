import { describe, expect, test } from "bun:test";
import { allowedCorsOrigin, normalizeResources, replaySessionEvents, validateGitHubRepositorySelection, workflowIdForSession } from "../src/app";
import type { SessionEvent } from "@infra-agents/contracts";

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

  test("matches CORS origins against the full origin string", () => {
    const pattern = String.raw`https?://(localhost|127\.0\.0\.1)(:\d+)?`;

    expect(allowedCorsOrigin(pattern, "http://localhost:3000")).toBe(true);
    expect(allowedCorsOrigin(pattern, "http://127.0.0.1:3000")).toBe(true);
    expect(allowedCorsOrigin(pattern, "http://localhost.evil.com")).toBe(false);
    expect(allowedCorsOrigin(pattern, "https://evil.com/http://localhost:3000")).toBe(false);
  });

  test("replays SSE history across all pages", async () => {
    const events = Array.from({ length: 1005 }, (_, index) => ({
      id: `event-${index + 1}`,
      sessionId: "session-1",
      sequence: index + 1,
      type: "agent.message.delta",
      payload: { text: String(index + 1) },
      occurredAt: "2026-05-07T00:00:00.000Z",
    } satisfies SessionEvent));
    const sent: number[] = [];
    const pageRequests: Array<{ after: number; limit: number }> = [];

    await replaySessionEvents(
      async (after, limit) => {
        pageRequests.push({ after, limit });
        return events.filter((event) => event.sequence > after).slice(0, limit);
      },
      async (event) => {
        sent.push(event.sequence);
      },
      0,
      1000,
    );

    expect(sent).toHaveLength(1005);
    expect(sent[0]).toBe(1);
    expect(sent.at(-1)).toBe(1005);
    expect(pageRequests).toEqual([
      { after: 0, limit: 1000 },
      { after: 1000, limit: 1000 },
    ]);
  });
});
