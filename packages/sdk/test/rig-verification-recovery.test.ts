import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const rigId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";

describe("Rig verification recovery SDK", () => {
  test("keeps manager exact selection separate from use-authorized deferred recovery", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ ok: true, versionId }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await expect(client.verifyRigVersion(workspaceId, rigId, versionId)).resolves.toEqual({
      ok: true,
      versionId,
    });
    await expect(client.recoverDeferredRigVerification(workspaceId, rigId)).resolves.toEqual({
      ok: true,
      versionId,
    });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "POST",
        `https://api.example.test/v1/workspaces/${workspaceId}/rigs/${rigId}/versions/${versionId}/verify`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${workspaceId}/rigs/${rigId}/versions/recover`,
      ],
    ]);
    expect(await requests[1]!.text()).toBe("");
  });

  test("preserves truthful ambiguity details from the recovery endpoint", async () => {
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            error: {
              status: 409,
              code: "conflict",
              message:
                "More than one inactive Rig version has a pending verification attempt; a manager must choose the exact version.",
              retryable: false,
              outcomeUnknown: false,
              details: {
                code: "RIG_DEFERRED_VERIFICATION_AMBIGUOUS",
                candidateCount: 2,
              },
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });

    await expect(client.recoverDeferredRigVerification(workspaceId, rigId)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      retryable: false,
      outcomeUnknown: false,
      details: {
        code: "RIG_DEFERRED_VERIFICATION_AMBIGUOUS",
        candidateCount: 2,
      },
    });
  });
});
