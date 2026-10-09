import { expect, test } from "bun:test";
import type * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { CodexCredentialLeaseLostError } from "../src/activities/agent-turn/credential-leases";
import { executeCoreCodexImageGeneration } from "../src/activities/codex-image-generation";

const identity = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  sessionOwnerSubjectId: "user:owner",
  sessionOwnerMembershipId: null,
  initiatingHumanSubjectId: "user:owner",
  acceptedAuthorityV2: { version: 2 as const, personal: [] },
};
const ATTEMPT = "66666666-6666-4666-8666-666666666666";
const CONNECTION = "55555555-5555-4555-8555-555555555555";

type Harness = {
  calls: string[];
  resets: unknown[];
  unknowns: unknown[];
  acquired: unknown[][];
};

function run(
  options: {
    acquire?: () => Promise<{ kind: string }>;
    renew?: () => Promise<Date | null>;
    chatLease?: () => Promise<void>;
    creditAdmission?: () => Promise<void>;
    generate?: (context: { beforeProviderDispatch?: () => Promise<void> }) => Promise<unknown>;
    toolCallId?: string;
  } = {},
) {
  const harness: Harness = { calls: [], resets: [], unknowns: [], acquired: [] };
  const ports = {
    prepare: async () => ({ operation: { status: "prepared" } }),
    begin: async () => ({ started: true, operation: { status: "provider_started" } }),
    resetBeforeProviderDispatch: async (_db: unknown, input: unknown) => {
      harness.resets.push(input);
    },
    markOutcomeUnknown: async (_db: unknown, input: unknown) => {
      harness.unknowns.push(input);
    },
    retain: async () => {
      harness.calls.push("retain");
      throw new Error("retention is outside this test");
    },
    complete: async () => undefined,
    markRetentionFailed: async () => undefined,
    recover: async () => null,
  } as never;
  const promise = executeCoreCodexImageGeneration({
    db: {} as opengeniDb.Database,
    settings: testSettings(),
    objectStorage: null,
    core: { identity, connectionId: CONNECTION },
    executionGeneration: 3,
    clientVersion: "test",
    assertCreditAdmission: async () => {
      await options.creditAdmission?.();
    },
    assertChatLease: async () => {
      harness.calls.push("chat_lease");
      await options.chatLease?.();
    },
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    attemptId: ATTEMPT,
    toolCallId: options.toolCallId ?? "call-1",
    prompt: "a lighthouse",
    deps: {
      acquire: async (...args) => {
        harness.calls.push("acquire");
        harness.acquired.push(args);
        return (await (options.acquire?.() ?? Promise.resolve({ kind: "acquired" }))) as never;
      },
      renew: async () => {
        harness.calls.push("renew");
        return options.renew ? await options.renew() : new Date(Date.now() + 60_000);
      },
      release: async () => {
        harness.calls.push("release");
        return true;
      },
      resolver: () => ({
        getToken: async () => ({
          accessToken: "token",
          chatgptAccountId: null,
          isFedramp: false,
          credentialVersion: 1,
          planType: "pro",
        }),
        refresh: async () => {
          throw new Error("no refresh expected");
        },
      }),
      ports,
      generateImage: (async (input: {
        context: { beforeProviderDispatch?: () => Promise<void> };
      }) => {
        harness.calls.push("generate");
        if (options.generate) return await options.generate(input.context);
        await input.context.beforeProviderDispatch?.();
        harness.calls.push("dispatched");
        return { bytes: new Uint8Array([1, 2, 3]), declaredMediaType: "image/png" };
      }) as never,
    },
  }).catch((error: unknown) => error);
  return { harness, promise };
}

test("a successful operation checks the chat lease, renews before dispatch and releases its lease", async () => {
  const { harness, promise } = run();
  await promise;
  expect(harness.calls).toEqual([
    "chat_lease",
    "acquire",
    "generate",
    "chat_lease",
    "renew",
    "dispatched",
    "release",
    "retain",
  ]);
  expect(harness.acquired[0]![1]).toEqual({ kind: "turn", identity });
  expect(harness.acquired[0]![2]).toMatchObject({
    operationKind: "image",
    attemptId: ATTEMPT,
    connectionId: CONNECTION,
    generation: 3,
  });
});

test("an error after dispatch still releases the lease and records outcome unknown", async () => {
  const { harness, promise } = run({
    generate: async (context) => {
      await context.beforeProviderDispatch?.();
      throw new Error("provider failed after dispatch");
    },
  });
  expect(((await promise) as Error).message).toBe("provider failed after dispatch");
  expect(harness.calls.at(-1)).toBe("release");
  expect(harness.unknowns).toHaveLength(1);
  expect(harness.resets).toHaveLength(0);
});

test("an abort releases the lease", async () => {
  const { harness, promise } = run({
    generate: async () => {
      throw new DOMException("aborted", "AbortError");
    },
  });
  await promise;
  expect(harness.calls).toContain("release");
});

test("a lost chat lease before dispatch is a pre-dispatch rejection and the lease is released", async () => {
  let checks = 0;
  const { harness, promise } = run({
    chatLease: async () => {
      if (++checks === 2) throw new CodexCredentialLeaseLostError("not_found");
    },
  });
  expect(await promise).toBeInstanceOf(CodexCredentialLeaseLostError);
  expect(harness.calls).not.toContain("dispatched");
  expect(harness.calls).toContain("release");
  expect(harness.resets).toHaveLength(1);
  expect(harness.unknowns).toHaveLength(0);
});

test("a chat lease lost before acquisition takes no operation lease", async () => {
  const { harness, promise } = run({
    chatLease: async () => {
      throw new CodexCredentialLeaseLostError("not_found");
    },
  });
  expect(await promise).toBeInstanceOf(CodexCredentialLeaseLostError);
  expect(harness.calls).toEqual(["chat_lease"]);
  expect(harness.resets).toHaveLength(1);
});

test("a thrown or refused acquisition is a pre-dispatch rejection, never outcome unknown", async () => {
  for (const acquire of [
    async () => {
      throw Object.assign(new Error("transient"), { code: "40001" });
    },
    async () => ({ kind: "busy" }),
    async () => ({ kind: "refused" }),
  ]) {
    const { harness, promise } = run({ acquire });
    expect(await promise).toBeInstanceOf(CodexCredentialLeaseLostError);
    expect(harness.calls).not.toContain("generate");
    expect(harness.resets).toHaveLength(1);
    expect(harness.unknowns).toHaveLength(0);
  }
});

test("a failing renewal before dispatch is a pre-dispatch rejection", async () => {
  const { harness, promise } = run({
    renew: async () => {
      throw new Error("transient");
    },
  });
  expect(await promise).toBeInstanceOf(CodexCredentialLeaseLostError);
  expect(harness.calls).not.toContain("dispatched");
  expect(harness.resets).toHaveLength(1);
});

test("a transient credit admission error leaves an undispatched image retryable", async () => {
  const { harness, promise } = run({
    creditAdmission: async () => {
      throw new Error("temporary database failure");
    },
  });
  expect(await promise).toBeInstanceOf(CodexCredentialLeaseLostError);
  expect(harness.calls).not.toContain("dispatched");
  expect(harness.resets).toHaveLength(1);
  expect(harness.unknowns).toHaveLength(0);
});

test("the holder id is bounded however long the tool call id is", async () => {
  const { harness, promise } = run({ toolCallId: "x".repeat(10_000) });
  await promise;
  const holder = (harness.acquired[0]![2] as { holderId: string }).holderId;
  expect(holder).toMatch(/^image:[0-9a-f]{64}$/);
  expect(holder.length).toBeLessThanOrEqual(256);
});
