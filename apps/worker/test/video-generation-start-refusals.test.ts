/**
 * A video whose start the provider refuses says which side refused and that
 * nothing was charged, so nobody is invited to pay for a retry that would
 * fail the same way. The start runs through the real reconciliation and
 * gateway client against a scripted gateway; the database is scripted.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { videoGenerationRequestDigest, type CanonicalVideoGenerationRequest } from "@opengeni/core";
import { XaiSubscriptionError } from "@opengeni/xai-subscription";

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const KEY = Buffer.alloc(32, 9);
const settings = testSettings({ environmentsEncryptionKey: KEY.toString("base64") });
const OPERATION = "77777777-7777-4777-8777-777777777777";

type Operation = realDb.VideoGenerationOperationWithReferences;
let operation: Operation;
let settled: Array<{ status: string; publicReason: string; privateError?: string }>;
let gateway: () => Promise<Response>;

const transition = (status: string, extra: Partial<Operation> = {}) => {
  operation = { ...operation, status, ...extra } as Operation;
  return operation;
};

mock.module("@opengeni/db", () => ({
  ...realDb,
  getVideoGenerationOperation: async () => operation,
  settleVideoGenerationFailure: async (
    _db: unknown,
    input: { status: string; publicReason: string; privateError?: string },
  ) => {
    settled.push({
      status: input.status,
      publicReason: input.publicReason,
      ...(input.privateError ? { privateError: input.privateError } : {}),
    });
    return transition(input.status, { terminalUpdateState: "suppressed" });
  },
  markVideoGenerationSubmissionIntent: async (
    _db: unknown,
    input: { encryptedProviderRequest: string; providerRequestExpiresAt: Date },
  ) =>
    transition("submission_uncertain", {
      providerRequestEncrypted: input.encryptedProviderRequest,
      providerRequestExpiresAt: input.providerRequestExpiresAt,
    }),
  markVideoGenerationSubmissionUncertain: async () => true,
  markVideoGenerationProviderStarted: async () => transition("provider_started"),
}));

const { encryptEnvironmentValue } = realDb;
const { reconcileVideoGenerationOperation, refusedVideoStartReason } =
  await import("../src/activities/video-generation-reconciliation");
const { GatewayVideoApiError } = await import("../src/activities/gateway-video-generation");

const canonical: CanonicalVideoGenerationRequest = {
  schemaVersion: 1,
  modelId: "bytedance/seedance-2.5",
  prompt: "A golden retriever running on a beach at sunset",
  sourceMode: "text",
  references: [],
  durationSeconds: 5,
  aspectRatio: "16:9",
  resolution: "480p",
  generateAudio: false,
} as CanonicalVideoGenerationRequest;

function accepted(fundingSource: string): Operation {
  return {
    id: OPERATION,
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    status: "accepted",
    fundingSource,
    modelId: canonical.modelId,
    connectionId: null,
    credentialEncrypted: encryptEnvironmentValue(
      KEY,
      JSON.stringify({ kind: "api-key", apiKey: "gateway-key" }),
    ),
    requestDigest: videoGenerationRequestDigest(canonical),
    requestEncrypted: encryptEnvironmentValue(KEY, JSON.stringify(canonical)),
    providerIdempotencyKey: `ogvid_${"a".repeat(48)}`,
    references: [],
    recoveryDeadlineAt: new Date(Date.now() + 3_600_000),
    terminalUpdateState: "pending",
    providerJobId: null,
    providerRequestExpiresAt: null,
  } as unknown as Operation;
}

const reconcile = () =>
  reconcileVideoGenerationOperation({ db: {}, settings, objectStorage: {}, bus: {} } as never, {
    accountId: operation.accountId,
    workspaceId: operation.workspaceId,
    operationId: OPERATION,
  });

const OUT_OF_CREDIT = () =>
  Response.json(
    { error: { message: "A positive credit balance is required for all requests." } },
    { status: 402 },
  );

beforeEach(() => {
  settled = [];
  globalThis.fetch = (async () => await gateway()) as unknown as typeof fetch;
});

describe("a refused video start", () => {
  test("the service's own gateway out of credit: not the person's fault, nothing charged, no retry", async () => {
    operation = accepted("opengeni_credits");
    gateway = async () => OUT_OF_CREDIT();
    expect(await reconcile()).toEqual({ action: "terminal", status: "provider_failed" });
    expect(settled).toHaveLength(1);
    expect(settled[0]!.publicReason).toBe(
      "Video isn't working on this service right now, so no video was made. Nothing was charged. Trying again won't help until the service is fixed.",
    );
    // The real cause stays in the operation's private error for the deployment's owner.
    expect(settled[0]!.privateError).toContain("(402)");
  });

  test("a refused description: rewording may help, nothing charged", async () => {
    operation = accepted("opengeni_credits");
    gateway = async () =>
      Response.json({ error: { message: "The prompt was rejected" } }, { status: 400 });
    await reconcile();
    expect(settled[0]!.publicReason).toBe(
      "The video service refused this description, so no video was made. Nothing was charged. Rewording it may help.",
    );
  });

  test("the workspace's own gateway: a workspace admin can fix it", async () => {
    operation = accepted("workspace_gateway");
    gateway = async () => new Response("forbidden", { status: 403 });
    await reconcile();
    expect(settled[0]!.publicReason).toBe(
      "The workspace's own Vercel AI Gateway refused this video, so none was made. Nothing was charged. A workspace admin can check its key and credit in Settings; trying again won't help until then.",
    );
  });

  test("every refusal kind and funding source says nothing was charged", () => {
    const refusals = [
      new GatewayVideoApiError(401, false, "unauthorized"),
      new GatewayVideoApiError(402, false, "no credit"),
      new GatewayVideoApiError(403, false, "forbidden"),
      new GatewayVideoApiError(404, false, "no such model"),
      new GatewayVideoApiError(400, false, "bad prompt"),
      new GatewayVideoApiError(422, false, "moderated"),
      new XaiSubscriptionError("relogin_required", "sign in again"),
      new XaiSubscriptionError("provider_rejected", "refused", 403),
      new XaiSubscriptionError("provider_rejected", "moderated", 400),
    ];
    for (const funding of ["opengeni_credits", "workspace_gateway", "supergrok_subscription"]) {
      for (const error of refusals) {
        const reason = refusedVideoStartReason(error, funding);
        expect(reason).toContain("Nothing was charged.");
        expect(reason).not.toContain("provider rejected");
      }
    }
    expect(
      refusedVideoStartReason(
        new XaiSubscriptionError("relogin_required", "sign in again"),
        "supergrok_subscription",
      ),
    ).toBe(
      "The connected SuperGrok account refused this video, so none was made. Nothing was charged. It may need to be connected again in Settings; trying again won't help until then.",
    );
  });
});
