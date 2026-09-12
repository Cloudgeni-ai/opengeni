import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const activationId = "00000000-0000-4000-8000-000000000004";

describe("workspace learning SDK", () => {
  test("preserves historical inspection and undo while retiring old settings writers", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    await client.getWorkspaceLearningHistory(workspaceId, { limit: 25 });
    await client.undoGovernedLearningActivation(workspaceId, activationId, {
      operationId: crypto.randomUUID(),
    });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `https://api.example.test/v1/workspaces/${workspaceId}/learning?limit=25`],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${workspaceId}/learning/activations/${activationId}/undo`,
      ],
    ]);
    expect("createWorkspaceLearningPolicyRevision" in client).toBe(false);
    expect("activateWorkspaceLearningPolicyRevision" in client).toBe(false);
    expect("rollbackWorkspaceLearningPolicyRevision" in client).toBe(false);
  });
});
