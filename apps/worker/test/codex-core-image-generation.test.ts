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

test("a core image operation that cannot take its own lease is a pre-dispatch rejection", async () => {
  const resets: unknown[] = [];
  const ports = {
    prepare: async () => ({ operation: { status: "prepared" } }),
    begin: async () => ({ started: true, operation: { status: "provider_started" } }),
    resetBeforeProviderDispatch: async (_db: unknown, input: unknown) => {
      resets.push(input);
    },
    markOutcomeUnknown: async () => {
      throw new Error("a refused lease must never be recorded as outcome-unknown");
    },
    retain: async () => {
      throw new Error("nothing was generated");
    },
    complete: async () => {
      throw new Error("nothing was generated");
    },
    markRetentionFailed: async () => undefined,
    recover: async () => null,
  } as never;
  const acquired: unknown[][] = [];
  const failure = await executeCoreCodexImageGeneration({
    db: {} as opengeniDb.Database,
    settings: testSettings(),
    objectStorage: null,
    core: { identity, connectionId: "55555555-5555-4555-8555-555555555555" },
    executionGeneration: 3,
    clientVersion: "test",
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    attemptId: "66666666-6666-4666-8666-666666666666",
    toolCallId: "call-1",
    prompt: "a lighthouse",
    deps: {
      acquire: async (...args) => {
        acquired.push(args);
        return { kind: "busy" };
      },
      renew: async () => {
        throw new Error("nothing may be renewed without a lease");
      },
      release: async () => true,
      ports,
      resolver: () => ({
        getToken: async () => {
          throw new Error("no credential may be read without a lease");
        },
        refresh: async () => {
          throw new Error("no credential may be refreshed without a lease");
        },
      }),
    },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CodexCredentialLeaseLostError);
  expect(resets).toHaveLength(1);
  expect(acquired).toHaveLength(1);
  expect(acquired[0]![1]).toEqual({ kind: "turn", identity });
  expect(acquired[0]![2]).toMatchObject({
    operationKind: "image",
    attemptId: "66666666-6666-4666-8666-666666666666",
    connectionId: "55555555-5555-4555-8555-555555555555",
    holderId: "image:66666666-6666-4666-8666-666666666666:call-1",
    generation: 3,
  });
  // The operation id is the ledger's turn/tool-call identity: stable across retries.
  expect((acquired[0]![2] as { operationId: string }).operationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});
