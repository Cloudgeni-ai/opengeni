import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

describe("workspace artifacts SDK", () => {
  test("maps bounded list options to the public artifact route", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ artifacts: [], nextCursor: null, truncated: false });
      }) as typeof fetch,
    });

    expect(
      await client.listWorkspaceArtifacts(WORKSPACE_ID, {
        limit: 25,
        cursor: "opaque-cursor",
      }),
    ).toEqual({ artifacts: [], nextCursor: null, truncated: false });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/published-artifacts?limit=25&cursor=opaque-cursor`,
      ],
    ]);
  });
});
