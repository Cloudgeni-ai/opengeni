import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

describe("workspace artifacts SDK", () => {
  test("maps bounded list options to the public artifact route", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          artifacts: [],
          nextCursor: null,
          truncated: false,
        });
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

  test("keeps all detail, content, create, publish, and rollback routes on the root client", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    const artifactId = "artifact/with space";
    const encodedArtifactId = "artifact%2Fwith%20space";

    await client.getWorkspaceArtifact(WORKSPACE_ID, artifactId);
    await client.getWorkspaceArtifactContent(WORKSPACE_ID, artifactId, "version/with space");
    await client.createWorkspaceArtifact(WORKSPACE_ID, {
      title: "Status board",
      html: "<main>Status</main>",
      idempotencyKey: "create-key",
    });
    await client.publishWorkspaceArtifactVersion(WORKSPACE_ID, artifactId, {
      html: "<main>Updated</main>",
      expectedCurrentVersionId: "version-1",
      idempotencyKey: "publish-key",
    });
    await client.rollbackWorkspaceArtifact(WORKSPACE_ID, artifactId, {
      versionId: "version-1",
      expectedCurrentVersionId: "version-2",
      reason: "Restore known-good version",
      idempotencyKey: "rollback-key",
    });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${encodedArtifactId}`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${encodedArtifactId}/content?versionId=version%2Fwith%20space`,
      ],
      ["POST", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/published-artifacts`],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${encodedArtifactId}/versions`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${encodedArtifactId}/rollback`,
      ],
    ]);
    expect(await requests[2]!.json()).toEqual({
      title: "Status board",
      html: "<main>Status</main>",
      idempotencyKey: "create-key",
    });
    expect(await requests[3]!.json()).toEqual({
      html: "<main>Updated</main>",
      expectedCurrentVersionId: "version-1",
      idempotencyKey: "publish-key",
    });
    expect(await requests[4]!.json()).toEqual({
      versionId: "version-1",
      expectedCurrentVersionId: "version-2",
      reason: "Restore known-good version",
      idempotencyKey: "rollback-key",
    });
  });
});
