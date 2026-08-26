import { describe, expect, test } from "bun:test";
import { BrowserAccountsClient, BrowserAccountsApiError } from "../src/accounts";

const projection = {
  mode: "dual" as const,
  generation: "1",
  actorEpoch: "1",
  csrfToken: "c".repeat(43),
  selectedSlotId: null,
  state: "ready" as const,
  slots: [],
};

describe("BrowserAccountsClient", () => {
  test("stays on the optional accounts graph and sends cookie, contract, CSRF, and actor fences", async () => {
    const requests: Request[] = [];
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test/",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(projection);
      },
    });
    await client.getSessionSet();
    await client.bootstrapSessionSet({
      operationId: "11111111-1111-4111-8111-111111111111",
      expectedGeneration: "1",
    });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["GET /v1/auth/session-set", "POST /v1/auth/session-set/bootstrap"],
    );
    expect(requests[1]!.credentials).toBe("include");
    expect(requests[1]!.headers.get("x-opengeni-session-csrf")).toBe(projection.csrfToken);
    expect(requests[1]!.headers.get("x-opengeni-actor-epoch")).toBe("1");
    expect(requests[1]!.headers.get("x-opengeni-api-contract")).toBeTruthy();
  });

  test("requires a safe projection before mutations", async () => {
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test",
      fetch: async () => Response.json({}),
    });
    await expect(
      client.selectLoginSlot({
        operationId: "11111111-1111-4111-8111-111111111111",
        expectedGeneration: "1",
        slotId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toBeInstanceOf(BrowserAccountsApiError);
  });

  test("never regresses its actor clock when a delayed GET arrives", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test",
      fetch: async () => await new Promise<Response>((resolve) => resolvers.push(resolve)),
    });
    const older = client.getSessionSet();
    const newer = client.getSessionSet();
    resolvers[1]!(Response.json({ ...projection, generation: "4", actorEpoch: "3" }));
    expect((await newer).actorEpoch).toBe("3");
    resolvers[0]!(Response.json({ ...projection, generation: "99", actorEpoch: "2" }));
    expect(await older).toMatchObject({ actorEpoch: "3", generation: "4" });
  });

  test("reconciles an older exact mutation receipt instead of adopting it as current", async () => {
    const responses = [
      { ...projection, generation: "5", actorEpoch: "3" },
      { ...projection, generation: "4", actorEpoch: "2" },
      { ...projection, generation: "6", actorEpoch: "3" },
    ];
    const paths: string[] = [];
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test",
      fetch: async (input) => {
        paths.push(new URL(input instanceof Request ? input.url : input).pathname);
        return Response.json(responses.shift());
      },
    });
    await client.getSessionSet();
    const current = await client.selectLoginSlot({
      operationId: "11111111-1111-4111-8111-111111111111",
      expectedGeneration: "5",
      slotId: "22222222-2222-4222-8222-222222222222",
    });
    expect(current).toMatchObject({ actorEpoch: "3", generation: "6" });
    expect(paths).toEqual([
      "/v1/auth/session-set",
      "/v1/auth/session-set/select",
      "/v1/auth/session-set",
    ]);
  });
});
