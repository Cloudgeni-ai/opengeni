import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const revisionId = "00000000-0000-4000-8000-000000000002";
const previousRevisionId = "00000000-0000-4000-8000-000000000003";
const activationId = "00000000-0000-4000-8000-000000000004";

describe("workspace learning SDK", () => {
  test("maps sanitized history and every admin mutation to the canonical routes", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    await client.getWorkspaceLearningHistory(workspaceId, { limit: 25 });
    await client.createWorkspaceLearningPolicyRevision(workspaceId, {
      operationId: crypto.randomUUID(),
      workspaceMode: "automatic",
      sourceOverrides: [{ kind: "task-note", id: "note:1", mode: "suggest" }],
      supersedesRevisionId: previousRevisionId,
    });
    await client.activateWorkspaceLearningPolicyRevision(workspaceId, revisionId, {
      operationId: crypto.randomUUID(),
      expectedCurrentRevisionId: previousRevisionId,
      expectedActivationVersion: 2,
      reason: "Enable guarded automatic learning",
    });
    await client.rollbackWorkspaceLearningPolicyRevision(workspaceId, {
      operationId: crypto.randomUUID(),
      targetRevisionId: previousRevisionId,
      expectedCurrentRevisionId: revisionId,
      expectedActivationVersion: 3,
      reason: "Restore review-first learning",
    });
    await client.undoGovernedLearningActivation(workspaceId, activationId, {
      operationId: crypto.randomUUID(),
    });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `https://api.example.test/v1/workspaces/${workspaceId}/learning?limit=25`],
      ["POST", `https://api.example.test/v1/workspaces/${workspaceId}/learning/revisions`],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${workspaceId}/learning/revisions/${revisionId}/activate`,
      ],
      ["POST", `https://api.example.test/v1/workspaces/${workspaceId}/learning/rollback`],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${workspaceId}/learning/activations/${activationId}/undo`,
      ],
    ]);
    expect(await requests[1]!.json()).toMatchObject({
      workspaceMode: "automatic",
      supersedesRevisionId: previousRevisionId,
    });
    expect(await requests[2]!.json()).toMatchObject({
      expectedCurrentRevisionId: previousRevisionId,
      expectedActivationVersion: 2,
    });
  });
});
