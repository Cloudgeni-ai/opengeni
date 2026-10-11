/**
 * SuperGrok video on the shared subscription core (design 5.3, X2a):
 * the funding lease references the canonical connection without token
 * material (EP-N13), and reconciliation runs only under a `video` operation
 * lease on that connection, waits while it is unavailable and ends at the
 * recovery deadline (EP-N14, decision 6). The core runtime is scripted; its
 * SQL authority is covered by the db package's real-PostgreSQL suite.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { videoGenerationRequestDigest, type CanonicalVideoGenerationRequest } from "@opengeni/core";

const KEY = Buffer.alloc(32, 9);
const settings = testSettings({ environmentsEncryptionKey: KEY.toString("base64") });
const CONNECTION = "55555555-5555-4555-8555-555555555555";
const OPERATION = "77777777-7777-4777-8777-777777777777";

type Operation = realDb.VideoGenerationOperationWithReferences;
let operation: Operation;
let calls: string[];
let candidates: string[];
let owner: { ownerSubjectId: string | null } | undefined;
let lease: "granted" | "refused" | "relogin";
let provider: (url: string, init?: RequestInit) => Promise<Response>;

const transition = (status: string, extra: Partial<Operation> = {}) => {
  operation = { ...operation, status, ...extra } as Operation;
  return operation;
};

mock.module("@opengeni/db", () => ({
  ...realDb,
  getVideoGenerationOperation: async () => operation,
  readSubscriptionCoreSessionOwner: async () => owner,
  subscriptionCoreOperationConnections: () => ({
    listSubscriptionCoreOperationCandidates: async (_db: unknown, scope: { kind: string }) => {
      calls.push(`candidates:${scope.kind}`);
      return candidates.map((connectionId) => ({ connectionId }));
    },
    runSubscriptionCoreOperation: async (
      _db: unknown,
      _settings: unknown,
      scope: { kind: string; sessionOwnerSubjectId: string | null },
      input: { candidates: string[]; operationKind: string; holderId: string },
      run: (operation: unknown) => Promise<unknown>,
    ) => {
      calls.push(
        `lease:${input.operationKind}:${input.candidates.join(",")}:${scope.kind}:${scope.sessionOwnerSubjectId}`,
      );
      if (lease === "refused") return { kind: "unavailable" };
      const token = { credential: { accessToken: "core-access" }, providerAccountId: "xai-user" };
      return {
        kind: "ran",
        value: await run({
          connectionId: input.candidates[0],
          resolver: {
            getToken: async () => {
              if (lease === "relogin") throw new Error("relogin required");
              return token;
            },
            refresh: async () => {
              calls.push("refresh:core");
              return token;
            },
          },
          fetch: async (url: string, init?: RequestInit) => {
            calls.push(`fetch:${new Headers(init?.headers).get("authorization")}`);
            return await provider(url, init);
          },
          fence: async () => true,
        }),
      };
    },
  }),
  rescheduleVideoGenerationOperation: async () => {
    calls.push("reschedule");
    return true;
  },
  cancelVideoGenerationBeforeSubmit: async () => {
    calls.push("cancelled_before_submit");
    return transition("cancelled_before_submit", { terminalUpdateState: "suppressed" });
  },
  settleVideoGenerationFailure: async (_db: unknown, input: { status: string }) => {
    calls.push(input.status);
    return transition(input.status, { terminalUpdateState: "suppressed" });
  },
  markVideoGenerationSubmissionIntent: async (
    _db: unknown,
    input: { encryptedProviderRequest: string; providerRequestExpiresAt: Date },
  ) => {
    calls.push("intent");
    return transition("submission_uncertain", {
      providerRequestEncrypted: input.encryptedProviderRequest,
      providerRequestExpiresAt: input.providerRequestExpiresAt,
    });
  },
  markVideoGenerationSubmissionUncertain: async () => {
    calls.push("uncertain");
    return true;
  },
  markVideoGenerationProviderStarted: async (_db: unknown, input: { providerJobId: string }) => {
    calls.push(`started:${input.providerJobId}`);
    return transition("provider_started", { providerJobId: input.providerJobId });
  },
  refreshXaiSubscriptionCredentialSerialized: async () => {
    throw new Error("the legacy refresh must not run on the core path");
  },
  materializeXaiCredentialForRun: async () => {
    throw new Error("the legacy credential must not be read on the core path");
  },
}));

const { encryptEnvironmentValue } = realDb;
const { reconcileVideoGenerationOperation } =
  await import("../src/activities/video-generation-reconciliation");
const { subscriptionCoreVideoGenerationCredentialLease } =
  await import("../src/activities/video-generation-subscription-core");
const { decryptVideoGenerationCredential, encryptVideoGenerationConnectionReference } =
  await import("../src/activities/video-generation-credential");
const { SUBSCRIPTION_CORE_XAI } = realDb;

function service() {
  return { db: {}, settings, objectStorage: {}, bus: {} } as never;
}

const canonical: CanonicalVideoGenerationRequest = {
  schemaVersion: 1,
  modelId: "xai/grok-imagine-video-1.5",
  prompt: "A quiet fjord at dawn",
  sourceMode: "text",
  references: [],
  durationSeconds: 6,
  aspectRatio: "16:9",
  resolution: "480p",
  generateAudio: true,
} as CanonicalVideoGenerationRequest;

function admitted(status: string, patch: Partial<Operation> = {}): Operation {
  return {
    id: OPERATION,
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    status,
    fundingSource: "supergrok_subscription",
    connectionId: null,
    credentialEncrypted: encryptVideoGenerationConnectionReference(KEY, {
      provider: "xai",
      connectionId: CONNECTION,
    }),
    requestDigest: videoGenerationRequestDigest(canonical),
    requestEncrypted: encryptEnvironmentValue(KEY, JSON.stringify(canonical)),
    references: [],
    recoveryDeadlineAt: new Date(Date.now() + 3_600_000),
    terminalUpdateState: "pending",
    providerJobId: null,
    providerRequestExpiresAt: null,
    ...patch,
  } as unknown as Operation;
}

const reconcile = () =>
  reconcileVideoGenerationOperation(service(), {
    accountId: operation.accountId,
    workspaceId: operation.workspaceId,
    operationId: operation.id,
  });

beforeEach(() => {
  calls = [];
  candidates = [CONNECTION];
  owner = { ownerSubjectId: "user:owner" };
  lease = "granted";
  provider = async () => Response.json({ request_id: "xai-job-1" });
});

describe("SuperGrok video on the shared core", () => {
  test("the funding lease references the first shared candidate and carries no token", async () => {
    const funded = await subscriptionCoreVideoGenerationCredentialLease(
      {} as never,
      settings,
      SUBSCRIPTION_CORE_XAI as never,
      { accountId: "a", workspaceId: "w", sessionId: "s" },
    );
    expect(funded).toMatchObject({ fundingSource: "supergrok_subscription", connectionId: null });
    expect(decryptVideoGenerationCredential(KEY, funded!.credentialEncrypted)).toEqual({
      kind: "subscription-connection",
      provider: "xai",
      connectionId: CONNECTION,
    });
    expect(calls).toEqual(["candidates:session"]);
    candidates = [];
    expect(
      await subscriptionCoreVideoGenerationCredentialLease(
        {} as never,
        settings,
        SUBSCRIPTION_CORE_XAI as never,
        { accountId: "a", workspaceId: "w", sessionId: "s" },
      ),
    ).toBeNull();
    owner = undefined;
    candidates = [CONNECTION];
    expect(
      await subscriptionCoreVideoGenerationCredentialLease(
        {} as never,
        settings,
        SUBSCRIPTION_CORE_XAI as never,
        { accountId: "a", workspaceId: "w", sessionId: "s" },
      ),
    ).toBeNull();
  });

  test("a malformed connection reference is refused without echoing it", () => {
    const bad = encryptEnvironmentValue(
      KEY,
      JSON.stringify({ kind: "subscription-connection", provider: "xai", connectionId: "nope" }),
    );
    expect(() => decryptVideoGenerationCredential(KEY, bad)).toThrow(
      "Video provider credential lease is malformed",
    );
  });

  test("submission runs under a video lease on the recorded connection with the core bearer", async () => {
    operation = admitted("accepted");
    expect(await reconcile()).toMatchObject({ action: "waiting" });
    expect(calls).toEqual([
      `lease:video:${CONNECTION}:session:user:owner`,
      "intent",
      "fetch:Bearer core-access",
      "started:xai-job-1",
    ]);
  });

  test("an ownerless session reconciles under its ownerless session scope", async () => {
    owner = { ownerSubjectId: null };
    operation = admitted("accepted");
    await reconcile();
    expect(calls[0]).toBe(`lease:video:${CONNECTION}:session:null`);
  });

  test("an unavailable connection waits, touching neither the provider nor the operation state", async () => {
    for (const unavailable of ["refused", "relogin"] as const) {
      calls = [];
      lease = unavailable;
      operation = admitted("accepted");
      expect(await reconcile()).toMatchObject({ action: "waiting" });
      expect(calls).toEqual([`lease:video:${CONNECTION}:session:user:owner`, "reschedule"]);
      expect(operation.status).toBe("accepted");
    }
    calls = [];
    operation = admitted("accepted", { sessionId: null } as Partial<Operation>);
    expect(await reconcile()).toMatchObject({ action: "waiting" });
    expect(calls).toEqual(["reschedule"]);
  });

  test("at the recovery deadline an unavailable connection ends the operation (decision 6)", async () => {
    lease = "refused";
    const past = { recoveryDeadlineAt: new Date(Date.now() - 1_000) } as Partial<Operation>;
    operation = admitted("accepted", past);
    expect(await reconcile()).toEqual({ action: "terminal", status: "cancelled_before_submit" });
    calls = [];
    operation = admitted("provider_started", { ...past, providerJobId: "xai-job-1" });
    expect(await reconcile()).toEqual({ action: "terminal", status: "outcome_unknown" });
    expect(calls).toEqual([`lease:video:${CONNECTION}:session:user:owner`, "outcome_unknown"]);
  });

  test("a crash after the submission intent is never replayed on the core path", async () => {
    operation = admitted("accepted");
    provider = async () => {
      throw new TypeError("connection reset");
    };
    expect(await reconcile()).toMatchObject({ action: "waiting" });
    expect(calls.slice(-2)).toEqual(["fetch:Bearer core-access", "uncertain"]);
    calls = [];
    provider = async () => Response.json({ request_id: "must-not-start" });
    expect(await reconcile()).toEqual({ action: "terminal", status: "outcome_unknown" });
    expect(calls).toEqual([`lease:video:${CONNECTION}:session:user:owner`, "outcome_unknown"]);
  });

  test("a provider 401 refreshes through the core seam, never the legacy refresh", async () => {
    operation = admitted("accepted");
    let first = true;
    provider = async () => {
      if (first) {
        first = false;
        return new Response("{}", { status: 401 });
      }
      return Response.json({ request_id: "xai-job-2" });
    };
    await reconcile();
    expect(calls).toContain("refresh:core");
    expect(calls.at(-1)).toBe("started:xai-job-2");
  });
});
