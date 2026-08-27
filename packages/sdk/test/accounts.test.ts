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

  test("double-confirms a rotated authority and fences a delayed old-authority GET", async () => {
    const before = {
      ...projection,
      generation: "7",
      actorEpoch: "5",
      csrfToken: "b".repeat(43),
      selectedSlotId: "22222222-2222-4222-8222-222222222222",
      slots: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          displayName: "Person 1",
          verifiedClaim: { kind: "email" as const, value: "person-1@example.test" },
          state: "active" as const,
        },
      ],
    };
    const resetFirst = { ...projection, csrfToken: "r".repeat(43) };
    const resetSecond = {
      ...projection,
      generation: "2",
      csrfToken: "s".repeat(43),
    };
    const afterMutation = { ...resetSecond, generation: "3", csrfToken: "t".repeat(43) };
    const requests: Request[] = [];
    let getCount = 0;
    let releaseDelayed!: (response: Response) => void;
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method !== "GET") return Response.json(afterMutation);
        getCount += 1;
        if (getCount === 1) return Response.json(before);
        if (getCount === 2) {
          return await new Promise<Response>((resolve) => {
            releaseDelayed = resolve;
          });
        }
        return Response.json(getCount === 3 ? resetFirst : resetSecond);
      },
    });

    expect(await client.getSessionSet()).toEqual(before);
    const delayed = client.getSessionSet();
    expect(await client.reconcileSessionSetAuthority()).toEqual(resetSecond);
    releaseDelayed(Response.json(before));
    expect(await delayed).toEqual(resetSecond);

    expect(
      await client.selectLoginSlot({
        operationId: "11111111-1111-4111-8111-111111111111",
        expectedGeneration: "2",
        slotId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toEqual(afterMutation);
    const mutation = requests.find((request) => request.method === "POST");
    expect(mutation?.headers.get("x-opengeni-session-csrf")).toBe(resetSecond.csrfToken);
    expect(mutation?.headers.get("x-opengeni-actor-epoch")).toBe(resetSecond.actorEpoch);
  });

  test("drops retained mutation admissions when explicit reconciliation rotates an equal clock", async () => {
    const before = { ...projection, csrfToken: "b".repeat(43) };
    const rotated = { ...projection, csrfToken: "r".repeat(43) };
    const requests: Request[] = [];
    let reads = 0;
    let mutations = 0;
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") {
          reads += 1;
          return Response.json(reads === 1 ? before : rotated);
        }
        mutations += 1;
        if (mutations === 1) throw new TypeError("connection closed after request write");
        return Response.json(rotated);
      },
    });
    const command = {
      operationId: "11111111-1111-4111-8111-111111111111",
      expectedGeneration: "1",
      slotId: "22222222-2222-4222-8222-222222222222",
    };

    expect(await client.getSessionSet()).toEqual(before);
    await expect(client.selectLoginSlot(command)).rejects.toMatchObject({
      code: "operation_outcome_unknown",
    });
    expect(await client.reconcileSessionSetAuthority()).toEqual(rotated);
    expect(await client.selectLoginSlot(command)).toEqual(rotated);

    const mutationRequests = requests.filter((request) => request.method === "POST");
    expect(mutationRequests).toHaveLength(2);
    expect(mutationRequests[0]?.headers.get("x-opengeni-session-csrf")).toBe(before.csrfToken);
    expect(mutationRequests[1]?.headers.get("x-opengeni-session-csrf")).toBe(rotated.csrfToken);
    expect(mutationRequests[1]?.headers.get("x-opengeni-actor-epoch")).toBe(rotated.actorEpoch);
  });

  test("keeps mutations closed after either reconciliation probe fails and retries both reads", async () => {
    for (const failedProbe of [1, 2] as const) {
      const before = {
        ...projection,
        generation: "7",
        actorEpoch: "5",
        csrfToken: "b".repeat(43),
      };
      const reset = { ...projection, csrfToken: "r".repeat(43) };
      const requests: Request[] = [];
      let initialRead = true;
      let recovery = false;
      let reconciliationProbe = 0;
      const client = new BrowserAccountsClient({
        baseUrl: "https://api.example.test",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          if (request.method !== "GET") return Response.json(reset);
          if (initialRead) {
            initialRead = false;
            return Response.json(before);
          }
          if (!recovery) {
            reconciliationProbe += 1;
            if (reconciliationProbe === failedProbe) {
              throw new TypeError(`reconciliation probe ${failedProbe} failed`);
            }
          }
          return Response.json(reset);
        },
      });

      expect(await client.getSessionSet()).toEqual(before);
      await expect(client.reconcileSessionSetAuthority()).rejects.toThrow(
        `reconciliation probe ${failedProbe} failed`,
      );
      const mutationCountBeforeBlockedAttempt = requests.filter(
        (request) => request.method !== "GET",
      ).length;
      await expect(
        client.selectLoginSlot({
          operationId: `11111111-1111-4111-8111-11111111111${failedProbe}`,
          expectedGeneration: before.generation,
          slotId: "22222222-2222-4222-8222-222222222222",
        }),
      ).rejects.toMatchObject({ status: 409, code: "actor_change_required" });
      expect(requests.filter((request) => request.method !== "GET")).toHaveLength(
        mutationCountBeforeBlockedAttempt,
      );

      recovery = true;
      const readsBeforeRecovery = requests.filter((request) => request.method === "GET").length;
      expect(await client.getSessionSet()).toEqual(reset);
      expect(requests.filter((request) => request.method === "GET")).toHaveLength(
        readsBeforeRecovery + 2,
      );
      await client.selectLoginSlot({
        operationId: `22222222-2222-4222-8222-22222222222${failedProbe}`,
        expectedGeneration: reset.generation,
        slotId: "22222222-2222-4222-8222-222222222222",
      });
      expect(requests.at(-1)?.headers.get("x-opengeni-session-csrf")).toBe(reset.csrfToken);
    }
  });

  test("keeps the current actor when a reconciliation probe catches back up", async () => {
    const before = { ...projection, generation: "7", actorEpoch: "5" };
    const stale = { ...projection, generation: "6", actorEpoch: "4" };
    const responses = [before, stale, before];
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test",
      fetch: async () => Response.json(responses.shift()),
    });

    expect(await client.getSessionSet()).toEqual(before);
    expect(await client.reconcileSessionSetAuthority()).toEqual(before);
    expect(responses).toHaveLength(0);
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

  test("pins exact admission headers across outcome-unknown reconciliation", async () => {
    const requests: Request[] = [];
    const newer = { ...projection, generation: "2", actorEpoch: "2", csrfToken: "d".repeat(43) };
    let reads = 0;
    let mutations = 0;
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") {
          reads += 1;
          return Response.json(reads === 1 ? projection : newer);
        }
        mutations += 1;
        if (mutations === 1) throw new TypeError("connection closed after request write");
        return Response.json(newer);
      },
    });
    await client.getSessionSet();
    const command = {
      operationId: "11111111-1111-4111-8111-111111111111",
      expectedGeneration: "1",
      slotId: "22222222-2222-4222-8222-222222222222",
    };
    await expect(client.selectLoginSlot(command)).rejects.toMatchObject({
      name: "BrowserAccountsApiError",
      status: 503,
      code: "operation_outcome_unknown",
    });
    await client.getSessionSet();
    expect(await client.selectLoginSlot(command)).toEqual(newer);

    const mutationRequests = requests.filter((request) => request.method === "POST");
    expect(mutationRequests).toHaveLength(2);
    expect(await mutationRequests[1]?.text()).toBe(await mutationRequests[0]?.text());
    expect(mutationRequests[0]?.headers.get("x-opengeni-session-csrf")).toBe(projection.csrfToken);
    expect(mutationRequests[1]?.headers.get("x-opengeni-session-csrf")).toBe(projection.csrfToken);
    expect(mutationRequests[1]?.headers.get("x-opengeni-actor-epoch")).toBe(projection.actorEpoch);

    await expect(
      client.selectLoginSlot({ ...command, slotId: "33333333-3333-4333-8333-333333333333" }),
    ).rejects.toMatchObject({ status: 409, code: "operation_reused" });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  test("classifies a malformed successful mutation receipt as outcome unknown", async () => {
    let calls = 0;
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? Response.json(projection)
          : new Response("{", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.getSessionSet();
    await expect(
      client.selectLoginSlot({
        operationId: "11111111-1111-4111-8111-111111111111",
        expectedGeneration: "1",
        slotId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toMatchObject({ status: 503, code: "operation_outcome_unknown" });
  });

  test("re-reads the cookie-backed authority after logout-all", async () => {
    const before = {
      ...projection,
      selectedSlotId: "22222222-2222-4222-8222-222222222222",
      slots: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          displayName: "Person 1",
          verifiedClaim: { kind: "email" as const, value: "person-1@example.test" },
          state: "active" as const,
        },
      ],
    };
    const after = { ...projection, csrfToken: "d".repeat(43) };
    const requests: Request[] = [];
    const responses = [before, { generation: "2", actorEpoch: "2", state: "logged_out" }, after];
    const client = new BrowserAccountsClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(responses.shift());
      },
    });

    await client.getSessionSet();
    await client.logoutSessionSet({
      operationId: "11111111-1111-4111-8111-111111111111",
      expectedGeneration: "1",
    });
    expect(await client.getSessionSet()).toEqual(after);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "GET /v1/auth/session-set",
        "POST /v1/auth/session-set/logout-all",
        "GET /v1/auth/session-set",
      ],
    );
    expect(requests.every((request) => request.credentials === "include")).toBe(true);
    expect(requests[1]?.headers.get("x-opengeni-session-csrf")).toBe(before.csrfToken);
    expect(requests[2]?.headers.get("x-opengeni-session-csrf")).toBeNull();
  });
});
