/**
 * SuperGrok image generation on the shared core (design 5.3, EP-N09/N10):
 * an `image` operation lease on the turn's placed connection, keyed by the
 * ledger's operation id; the core bearer and custody fetch; a refused lease
 * or fence before dispatch is a verified pre-dispatch rejection (the ledger
 * row returns to `prepared`), anything after dispatch is not.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as realDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { XAI_IMAGE_MODEL } from "@opengeni/xai-subscription";

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const CONNECTION = "55555555-5555-4555-8555-555555555555";
const identity = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
} as unknown as realDb.SubscriptionCoreTurnIdentity;

let calls: string[];
let lease: "granted" | "refused";
let fenceLive: boolean;
let leases: Array<{ scope: unknown; input: Record<string, unknown> }>;
let status: number;
let providerAccountId: string | null;
let refreshRefused: boolean;
let reservationRefused: boolean;
let acquireFails: boolean;

mock.module("@opengeni/db", () => ({
  ...realDb,
  subscriptionCoreOperationConnections: () => ({
    runSubscriptionCoreOperation: async (
      _db: unknown,
      _settings: unknown,
      scope: unknown,
      input: Record<string, unknown>,
      operate: (operation: unknown) => Promise<unknown>,
    ) => {
      leases.push({ scope, input });
      if (acquireFails) throw new Error("connection reset while taking the lease");
      if (lease === "refused") return { kind: "unavailable" };
      const transport = input.fetchImpl as (url: string, init?: RequestInit) => Promise<Response>;
      const token = { credential: { accessToken: "core-access" }, providerAccountId };
      return {
        kind: "ran",
        value: await operate({
          resolver: {
            getToken: async () => token,
            refresh: async () => {
              calls.push("refresh:core");
              if (refreshRefused) throw new Error("relogin required");
              return token;
            },
          },
          // The core's custody: reserve, then the operation's transport.
          fetch: async (url: string, init?: RequestInit) => {
            if (reservationRefused) throw new Error("request reservation refused");
            calls.push(`fetch:${new Headers(init?.headers).get("authorization")}`);
            return await transport(url, init);
          },
          fence: async () => fenceLive,
        }),
      };
    },
  }),
}));

const { executeCoreXaiImageGeneration } = await import("../src/activities/xai-image-generation");
const { imageGenerationOperationIdentity, imageProviderBindingHash } =
  await import("../src/activities/image-generation-operation");

type Outcome = { receipt?: unknown; rejected?: boolean; error?: unknown };

function run(
  generate: (input: {
    getToken: () => Promise<{ accessToken: string }>;
    refresh: () => Promise<{ accessToken: string }>;
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
  }) => Promise<unknown>,
  chatLease: () => Promise<void> = async () => undefined,
): Promise<Outcome> {
  return executeCoreXaiImageGeneration(
    {
      db: {} as never,
      objectStorage: null,
      settings: testSettings(),
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      attemptId: "66666666-6666-4666-8666-666666666666",
      toolCallId: "call-1",
      prompt: "a lighthouse",
      core: { identity, connectionId: CONNECTION },
      executionGeneration: 3,
      assertChatLease: chatLease,
    },
    {
      execute: (async (operation: {
        generate: () => Promise<unknown>;
        isProviderDispatchRejected?: (error: unknown) => boolean;
      }) => {
        try {
          return { receipt: await operation.generate() };
        } catch (error) {
          return { rejected: operation.isProviderDispatchRejected?.(error) === true, error };
        }
      }) as never,
      generate: (async (input: never) => {
        await generate(input);
        return { bytes: new Uint8Array([1]), declaredMediaType: "image/png" };
      }) as never,
    },
  ) as Promise<Outcome>;
}

const send = async (input: {
  getToken: () => Promise<{ accessToken: string }>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}) => {
  const token = await input.getToken();
  await input.fetch("https://api.x.ai/v1/images/generations", {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
};

beforeEach(() => {
  calls = [];
  lease = "granted";
  fenceLive = true;
  leases = [];
  status = 200;
  providerAccountId = "xai-user";
  refreshRefused = false;
  reservationRefused = false;
  acquireFails = false;
  globalThis.fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch;
});

test("runs under an image lease keyed by the ledger operation on the turn's connection", async () => {
  expect(await run(send)).toMatchObject({ receipt: { toolCallId: "call-1" } });
  expect(calls).toEqual(["fetch:Bearer core-access"]);
  const { operationId } = imageGenerationOperationIdentity({
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    toolCallId: "call-1",
    providerId: "xai-subscription",
    providerBindingHash: imageProviderBindingHash("xai-subscription", CONNECTION),
    modelId: XAI_IMAGE_MODEL,
    prompt: "a lighthouse",
  });
  expect(leases).toHaveLength(1);
  expect(leases[0]!.scope).toEqual({ kind: "turn", identity });
  expect(leases[0]!.input).toMatchObject({
    candidates: [CONNECTION],
    operationKind: "image",
    attemptId: "66666666-6666-4666-8666-666666666666",
    generation: 3,
  });
  expect(leases[0]!.input.operationId).toBe(operationId);
  expect(String(leases[0]!.input.holderId)).toMatch(/^image:[0-9a-f]{64}$/);
});

test("a refused operation lease, a lost chat lease or a lost fence before dispatch is rejected", async () => {
  lease = "refused";
  expect(await run(send)).toMatchObject({ rejected: true });
  lease = "granted";
  expect(
    await run(send, async () => {
      throw new Error("chat lease lost");
    }),
  ).toMatchObject({ rejected: true });
  expect(leases).toHaveLength(1);
  fenceLive = false;
  expect(await run(send)).toMatchObject({ rejected: true });
  expect(calls).toEqual([]);
});

test("a failure after the request may have reached the provider is not a rejection", async () => {
  expect(
    await run(async (input) => {
      await send(input);
      fenceLive = false;
      await send(input);
    }),
  ).toMatchObject({ rejected: false });
  fenceLive = true;
  expect(
    await run(async (input) => {
      await send(input);
      throw new TypeError("connection reset after send");
    }),
  ).toMatchObject({ rejected: false });
});

test("a 401 generated nothing: a refused renewal after it is still a pre-dispatch rejection", async () => {
  status = 401;
  refreshRefused = true;
  const retry = async (
    input: Parameters<typeof send>[0] & {
      refresh: () => Promise<{ accessToken: string }>;
    },
  ) => {
    await send(input);
    await input.refresh();
  };
  expect(await run(retry)).toMatchObject({ rejected: true });
  expect(calls).toEqual(["fetch:Bearer core-access", "refresh:core"]);
  // After a non-401 response the request may have done work: not a rejection.
  calls = [];
  status = 500;
  expect(await run(retry)).toMatchObject({ rejected: false });
});

test("a connection without a usable SuperGrok bearer is rejected before dispatch", async () => {
  providerAccountId = null;
  expect(await run(send)).toMatchObject({ rejected: true });
  expect(calls).toEqual([]);
});

test("a refused request reservation or a failed lease acquisition is rejected before dispatch", async () => {
  reservationRefused = true;
  expect(await run(send)).toMatchObject({ rejected: true });
  reservationRefused = false;
  acquireFails = true;
  expect(await run(send)).toMatchObject({ rejected: true });
  expect(calls).toEqual([]);
});
