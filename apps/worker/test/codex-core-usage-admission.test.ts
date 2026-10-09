import { afterEach, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { codexRequestStorage, codexSubscriptionFetch } from "@opengeni/codex";
import {
  buildCoreCodexUsageReader,
  createCoreCodexRequests,
} from "../src/activities/agent-turn/codex-core-requests";
import { createCodexCreditGuard } from "../src/activities/agent-turn/codex-credit-policy";

const identity = {
  accountId: "account",
  workspaceId: "workspace",
  sessionId: "session",
  turnId: "turn",
  sessionOwnerSubjectId: "user:owner",
  sessionOwnerMembershipId: null,
  initiatingHumanSubjectId: "user:owner",
  acceptedAuthorityV2: { version: 2 as const, personal: [] },
};
const ref = { connectionId: "connection", holderId: "holder", generation: 3 };
const execution = { attemptId: "attempt", executionGeneration: 3 };
const auth = {
  accessToken: "fixture-old",
  chatgptAccountId: null,
  isFedramp: false,
  clientVersion: "fixture",
};
const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (restores.length) restores.pop()!.mockRestore();
});
function native(disconnected: () => boolean = () => false) {
  const reserve = spyOn(db, "reserveSubscriptionCoreCodexTurnCredentialRequest").mockImplementation(
    async () => {
      if (disconnected()) throw new db.SubscriptionCoreCodexSourceDisconnectedError();
      return { operationId: `operation-${reserve.mock.calls.length}` };
    },
  );
  const settle = spyOn(db, "settleSubscriptionCoreCodexTurnCredentialRequest").mockResolvedValue(
    undefined,
  );
  restores.push(reserve, settle);
  return { reserve, settle };
}

test("worker usage owns a complete body after disconnect and fences the next physical probe", async () => {
  let disconnected = false;
  const { reserve, settle } = native(() => disconnected);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let dispatched!: () => void;
  const started = new Promise<void>((yes) => {
    dispatched = yes;
  });
  let fetches = 0;
  const read = buildCoreCodexUsageReader({} as db.Database, identity, ref, execution, async () => {
    fetches++;
    const response = new Response(
      new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
    );
    dispatched();
    return response;
  });
  const pending = read(auth);
  await started;
  disconnected = true;
  controller.enqueue(new TextEncoder().encode('{"fixture":"usage"}'));
  await Bun.sleep(1);
  expect(settle).not.toHaveBeenCalled();
  controller.close();
  expect(await pending).toEqual({ status: 200, payload: { fixture: "usage" } });
  expect(reserve.mock.calls[0]).toEqual([
    {},
    identity,
    ref,
    expect.objectContaining({ ...execution, transportAttempt: 1 }),
  ]);
  expect(settle).toHaveBeenCalledWith({}, identity, ref, {
    ...execution,
    operationId: "operation-1",
    outcome: "response_received",
  });
  await expect(read(auth)).rejects.toThrow();
  expect(fetches).toBe(1);
});

test("worker usage 401 refresh gets a separate native reservation and bearer", async () => {
  const { reserve } = native();
  const tokens: string[] = [];
  const read = buildCoreCodexUsageReader(
    {} as db.Database,
    identity,
    ref,
    execution,
    async (_url, init) => {
      tokens.push(new Headers(init?.headers).get("authorization")!);
      if (tokens.length === 1) return Response.json({}, { status: 401 });
      return Response.json({
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18000,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      });
    },
  );
  const guard = createCodexCreditGuard({
    fetchUsage: read,
    refreshToken: async () => ({ ...auth, accessToken: "fixture-new" }),
  });
  guard.setToken(auth);
  await guard.assertCanDispatch();
  expect(tokens).toEqual(["Bearer fixture-old", "Bearer fixture-new"]);
  expect(reserve.mock.calls.map((call) => call[3].transportAttempt)).toEqual([1, 2]);
});

test("worker usage timeout stays unknown after an ignored-abort response arrives", async () => {
  const { reserve, settle } = native();
  let resolve!: (value: Response) => void;
  const read = buildCoreCodexUsageReader(
    {} as db.Database,
    identity,
    ref,
    execution,
    async () =>
      await new Promise<Response>((yes) => {
        resolve = yes;
      }),
  );
  await expect(read(auth, undefined, 10)).rejects.toThrow();
  resolve(Response.json({ fixture: "late" }));
  await Bun.sleep(1);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls[0]?.[3].outcome).toBe("unknown");
});

test("an unknown usage body uses only credential custody and does not poison the next model request", async () => {
  const { reserve, settle } = native();
  const modelReserve = spyOn(db, "reserveSubscriptionCoreCodexRequest").mockResolvedValue({
    operationId: "model-operation",
  });
  const modelSettle = spyOn(db, "settleSubscriptionCoreCodexRequest").mockResolvedValue(undefined);
  restores.push(modelReserve, modelSettle);
  let usageFetches = 0;
  const read = buildCoreCodexUsageReader({} as db.Database, identity, ref, execution, async () => {
    usageFetches++;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"unfinished":'));
        },
      }),
    );
  });
  const usageError = await read(auth, undefined, 10).catch((error: unknown) => error);
  expect(usageError).toBeInstanceOf(Error);
  expect(usageError).not.toBeInstanceOf(db.SubscriptionCoreCodexRequestOutcomeUnknownError);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls.map((call) => call[3].outcome)).toEqual(["unknown"]);
  expect(modelReserve).not.toHaveBeenCalled();
  expect(modelSettle).not.toHaveBeenCalled();

  const modelRequests = createCoreCodexRequests({
    reserve: (request) =>
      db.reserveSubscriptionCoreCodexRequest({} as db.Database, identity, ref, {
        ...request,
        ...execution,
      }),
    settle: (request) =>
      db.settleSubscriptionCoreCodexRequest({} as db.Database, identity, ref, {
        ...request,
        ...execution,
      }),
  });
  let modelFetches = 0;
  const transport = codexSubscriptionFetch(async () => {
    modelFetches++;
    return new Response(
      'data: {"type":"response.completed","response":{"id":"model-response","status":"completed","output":[]}}\n\n',
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  });
  await codexRequestStorage.run(
    {
      clientVersion: "fixture",
      getToken: async () => auth,
      refresh: async () => auth,
      resolveModel: (model) => model,
      nextRequestId: () => "model-after-usage",
      beforeProviderDispatch: (request) => modelRequests.reserve(request!),
      onProviderRequestSettled: modelRequests.observe,
    },
    async () => {
      const response = await transport("https://fixture.invalid/responses", {
        method: "POST",
        body: JSON.stringify({ model: "fixture", input: [], stream: true }),
      });
      await response.text();
    },
  );
  await modelRequests.checkpoint();
  expect(modelReserve).toHaveBeenCalledTimes(1);
  expect(modelSettle.mock.calls.map((call) => call[3].outcome)).toEqual(["response_received"]);
  expect(modelRequests.canRecover()).toBe(true);
  expect(usageFetches).toBe(1);
  expect(modelFetches).toBe(1);
  expect(settle.mock.calls.map((call) => call[3].outcome)).toEqual(["unknown"]);
});

test.each([false, true])(
  "credit usage preserves the native unresolved-outcome fence (after401=%s)",
  async (after401) => {
    const { reserve } = native();
    const unresolved = new db.SubscriptionCoreCodexRequestOutcomeUnknownError();
    reserve.mockImplementation(async () => {
      if (after401 && reserve.mock.calls.length === 1) return { operationId: "refused" };
      throw unresolved;
    });
    let fetches = 0;
    const read = buildCoreCodexUsageReader(
      {} as db.Database,
      identity,
      ref,
      execution,
      async () => {
        fetches++;
        return Response.json({}, { status: 401 });
      },
    );
    const guard = createCodexCreditGuard({ fetchUsage: read, refreshToken: async () => auth });
    guard.setToken(auth);
    await expect(guard.assertCanDispatch()).rejects.toBe(unresolved);
    expect(fetches).toBe(after401 ? 1 : 0);
    expect(reserve).toHaveBeenCalledTimes(after401 ? 2 : 1);
  },
);
