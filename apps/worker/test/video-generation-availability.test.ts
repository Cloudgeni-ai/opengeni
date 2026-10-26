import { describe, expect, test } from "bun:test";
import {
  SEEDANCE_2_5_MODEL_ID,
  type GenerateVideoToolInput,
  type VideoGenerationPolicy,
} from "@opengeni/contracts";
import { VideoGenerationCapacityError, VideoGenerationCreditError } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import {
  createVideoGenerationToolAdapter,
  videoGenerationOffResult,
} from "../src/activities/video-generation-availability";
import type { VideoGenerationCredentialLease } from "../src/activities/video-generation-admission";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

// A workspace that saved a policy before and turned video off again.
const offPolicy: VideoGenerationPolicy = {
  schemaVersion: 1,
  revision: 7,
  fundingSource: "workspace_gateway",
  enabledModelIds: [],
  defaultModelId: null,
};

type Actor = { canChangeSettings: boolean; external: boolean };
const ADMIN: Actor = { canChangeSettings: true, external: false };
const MEMBER: Actor = { canChangeSettings: false, external: false };
const EXTERNAL: Actor = { canChangeSettings: false, external: true };
const EXTERNAL_ADMIN: Actor = { canChangeSettings: true, external: true };

const managedSettings = (overrides: Parameters<typeof testSettings>[0] = {}) =>
  testSettings({
    environmentsEncryptionKey: ENCRYPTION_KEY,
    vercelAiGatewayApiKey: "gateway-key",
    billingMode: "stripe",
    ...overrides,
  });

describe("video generation while it is off", () => {
  test("credits can pay: the live price and the exact call that turns it on", () => {
    const result = videoGenerationOffResult({
      settings: managedSettings(),
      workspaceId: WORKSPACE_ID,
      policy: offPolicy,
      creditModelsAllowed: true,
      actor: ADMIN,
    });
    expect(result).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      code: "video_generation_off",
      message:
        "Video generation is off in this workspace. Opengeni credits can pay for it: a 5-second 480p clip costs $0.78 (720p: $1.75). Ask the person whether to turn it on for every chat in this workspace; if they agree, run the app action in turnOn, then call this tool again. If you can't run it, they can turn it on in Settings.",
      operationCreated: false,
      turnOn: {
        id: "updateVideoGenerationPolicy",
        pathParameters: { workspaceId: WORKSPACE_ID },
        body: {
          expectedRevision: 7,
          fundingSource: "opengeni_credits",
          enabledModelIds: [SEEDANCE_2_5_MODEL_ID],
          defaultModelId: SEEDANCE_2_5_MODEL_ID,
        },
      },
    });
  });

  test("the price follows the deployment's configured credit rates", () => {
    const result = videoGenerationOffResult({
      settings: managedSettings({
        videoGenerationCredit480pMicrosPerSecond: 200_000,
        videoGenerationCredit720pMicrosPerSecond: 401_000,
      }),
      workspaceId: WORKSPACE_ID,
      policy: { ...offPolicy, revision: 0 },
      creditModelsAllowed: true,
      actor: ADMIN,
    });
    expect(result.message).toContain("a 5-second 480p clip costs $1.00 (720p: $2.01).");
    expect(result.turnOn?.body.expectedRevision).toBe(0);
  });

  test("a deployment that doesn't charge credits says so instead of a price", () => {
    const result = videoGenerationOffResult({
      settings: managedSettings({ billingMode: "disabled", usageLimitsMode: "none" }),
      workspaceId: WORKSPACE_ID,
      policy: offPolicy,
      creditModelsAllowed: true,
      actor: ADMIN,
    });
    expect(result.message).toBe(
      "Video generation is off in this workspace. It can run on this deployment's video gateway, at no charge to this workspace. Ask the person whether to turn it on for every chat in this workspace; if they agree, run the app action in turnOn, then call this tool again. If you can't run it, they can turn it on in Settings.",
    );
    expect(result.turnOn?.body.fundingSource).toBe("opengeni_credits");
  });

  test("credits can't pay here: the workspace's own ways, and no call to make", () => {
    for (const [settings, creditModelsAllowed] of [
      [managedSettings({ vercelAiGatewayApiKey: undefined }), true],
      [managedSettings(), false],
    ] as const) {
      expect(
        videoGenerationOffResult({
          settings,
          workspaceId: WORKSPACE_ID,
          policy: offPolicy,
          creditModelsAllowed,
          actor: ADMIN,
        }),
      ).toEqual({
        schemaVersion: 1,
        status: "unavailable",
        code: "video_generation_off",
        message:
          "Video generation is off in this workspace, and Opengeni credits can't pay for it here. A workspace admin can turn it on in Settings with the workspace's own Vercel AI Gateway key. Tell the person plainly; offer an image instead if that helps.",
        operationCreated: false,
      });
    }
    expect(
      videoGenerationOffResult({
        settings: managedSettings({
          vercelAiGatewayApiKey: undefined,
          supergrokSubscriptionEnabled: true,
        }),
        workspaceId: WORKSPACE_ID,
        policy: offPolicy,
        creditModelsAllowed: true,
        actor: ADMIN,
      }).message,
    ).toBe(
      "Video generation is off in this workspace, and Opengeni credits can't pay for it here. A workspace admin can turn it on in Settings with the workspace's own Vercel AI Gateway key or a connected SuperGrok account. Tell the person plainly; offer an image instead if that helps.",
    );
  });

  test("not possible on this deployment", () => {
    expect(
      videoGenerationOffResult({
        settings: managedSettings({ environmentsEncryptionKey: undefined }),
        workspaceId: WORKSPACE_ID,
        policy: offPolicy,
        creditModelsAllowed: true,
        actor: ADMIN,
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      code: "video_generation_unsupported",
      message:
        "Video generation is not available on this deployment. Tell the person plainly; offer an image instead if that helps.",
      operationCreated: false,
    });
  });

  test("on, but its way of paying can't be used", () => {
    expect(
      videoGenerationOffResult({
        settings: managedSettings(),
        workspaceId: WORKSPACE_ID,
        policy: {
          ...offPolicy,
          enabledModelIds: [SEEDANCE_2_5_MODEL_ID],
          defaultModelId: SEEDANCE_2_5_MODEL_ID,
        },
        creditModelsAllowed: true,
        actor: ADMIN,
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      code: "video_generation_unfunded",
      message:
        "Video generation is on in this workspace, but its payment method can't be used right now. A workspace admin can fix it in Settings. Tell the person plainly; offer an image instead if that helps.",
      operationCreated: false,
    });
  });

  test("only someone who can change the workspace's settings is offered the switch", () => {
    const answer = (
      actor: Actor,
      overrides: {
        settings?: ReturnType<typeof managedSettings>;
        policy?: VideoGenerationPolicy;
      } = {},
    ) =>
      videoGenerationOffResult({
        settings: overrides.settings ?? managedSettings(),
        workspaceId: WORKSPACE_ID,
        policy: overrides.policy ?? offPolicy,
        creditModelsAllowed: true,
        actor,
      });
    expect(answer(ADMIN).turnOn?.body.expectedRevision).toBe(7);

    // A member who isn't an admin hears the price and who can turn it on.
    expect(answer(MEMBER)).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      code: "video_generation_off",
      message:
        "Video generation is off in this workspace. Opengeni credits can pay for it: a 5-second 480p clip costs $0.78 (720p: $1.75). A workspace admin can turn it on in Settings. Tell the person plainly; offer an image instead if that helps.",
      operationCreated: false,
    });

    // Someone using Opengeni through another product has no Settings page,
    // no Opengeni credits and no gateway key of their own.
    const external =
      "Video generation is off in this workspace. A workspace admin can turn it on. Tell the person plainly; offer an image instead if that helps.";
    for (const settings of [
      managedSettings(),
      managedSettings({ vercelAiGatewayApiKey: undefined }),
    ]) {
      expect(answer(EXTERNAL, { settings })).toEqual({
        schemaVersion: 1,
        status: "unavailable",
        code: "video_generation_off",
        message: external,
        operationCreated: false,
      });
    }
    expect(
      answer(EXTERNAL, {
        policy: {
          ...offPolicy,
          enabledModelIds: [SEEDANCE_2_5_MODEL_ID],
          defaultModelId: SEEDANCE_2_5_MODEL_ID,
        },
      }).message,
    ).toBe(
      "Video generation is on in this workspace, but its payment method can't be used right now. A workspace admin can fix it. Tell the person plainly; offer an image instead if that helps.",
    );
    for (const actor of [MEMBER, EXTERNAL]) {
      expect(answer(actor).message).not.toContain("Ask the person");
      expect(
        answer(actor, { settings: managedSettings({ vercelAiGatewayApiKey: undefined }) }),
      ).not.toHaveProperty("turnOn");
    }
  });

  test("someone using another product who can change settings is offered it, with no Settings pointer", () => {
    const result = videoGenerationOffResult({
      settings: managedSettings(),
      workspaceId: WORKSPACE_ID,
      policy: offPolicy,
      creditModelsAllowed: true,
      actor: EXTERNAL_ADMIN,
    });
    expect(result.message).toBe(
      "Video generation is off in this workspace. Opengeni credits can pay for it: a 5-second 480p clip costs $0.78 (720p: $1.75). Ask the person whether to turn it on for every chat in this workspace; if they agree, run the app action in turnOn, then call this tool again. If you can't run it, they can turn it on.",
    );
    expect(result.turnOn?.body.expectedRevision).toBe(7);
    // Where credits can't pay, the same plain line as anyone using another product.
    expect(
      videoGenerationOffResult({
        settings: managedSettings({ vercelAiGatewayApiKey: undefined }),
        workspaceId: WORKSPACE_ID,
        policy: offPolicy,
        creditModelsAllowed: true,
        actor: EXTERNAL_ADMIN,
      }).message,
    ).toBe(
      "Video generation is off in this workspace. A workspace admin can turn it on. Tell the person plainly; offer an image instead if that helps.",
    );
  });
});

const credential: VideoGenerationCredentialLease = {
  fundingSource: "opengeni_credits",
  connectionId: null,
  version: 1,
  credentialEncrypted: "sealed",
};
const prompt: GenerateVideoToolInput = { prompt: "a golden retriever on a beach at sunset" };

function adapterFor(
  readPolicy: () => Promise<VideoGenerationPolicy>,
  admit: Parameters<typeof createVideoGenerationToolAdapter>[0]["admit"],
  canChangeSettings: () => Promise<boolean> = async () => true,
  options: { external?: boolean; settings?: ReturnType<typeof managedSettings> } = {},
) {
  const credentialReads: string[] = [];
  const adapter = createVideoGenerationToolAdapter({
    settings: options.settings ?? managedSettings(),
    workspaceId: WORKSPACE_ID,
    creditModelsAllowed: true,
    external: options.external ?? false,
    canChangeSettings,
    readPolicy,
    resolveCredential: async (policy) => {
      credentialReads.push(policy.fundingSource);
      return policy.fundingSource === "opengeni_credits" ? credential : null;
    },
    admit,
  });
  return { adapter, credentialReads };
}

describe("video generation tools read live state on every call", () => {
  test("turning video on mid-turn lets the same turn generate", async () => {
    let policy = offPolicy;
    const admitted: Array<{ revision: number; toolCallId: string }> = [];
    const { adapter, credentialReads } = adapterFor(
      async () => policy,
      async (input) => {
        admitted.push({ revision: input.policy.revision, toolCallId: input.toolCallId });
        return {
          schemaVersion: 1,
          status: "accepted",
          operationId: "77777777-7777-4777-8777-777777777777",
        };
      },
    );

    const off = await adapter.capabilities();
    expect(off).toMatchObject({ status: "unavailable", code: "video_generation_off" });
    if (!("turnOn" in off) || !off.turnOn) throw new Error("expected a turn-on call");
    expect(credentialReads).toEqual([]);

    // The person agrees and the app action saves exactly the offered body.
    const body = off.turnOn.body;
    policy = {
      schemaVersion: 1,
      revision: body.expectedRevision + 1,
      fundingSource: body.fundingSource,
      enabledModelIds: body.enabledModelIds,
      defaultModelId: body.defaultModelId,
    };

    await expect(adapter.capabilities()).resolves.toMatchObject({
      schemaVersion: 1,
      defaultModelId: SEEDANCE_2_5_MODEL_ID,
      models: [{ modelId: SEEDANCE_2_5_MODEL_ID }],
    });
    await expect(adapter.execute(prompt, { toolCallId: "call-video" })).resolves.toEqual({
      schemaVersion: 1,
      status: "accepted",
      operationId: "77777777-7777-4777-8777-777777777777",
    });
    expect(admitted).toEqual([{ revision: 8, toolCallId: "call-video" }]);
    expect(credentialReads).toEqual(["opengeni_credits", "opengeni_credits"]);
  });

  test("generate_video gives the same plain answer while video is off, and admits nothing", async () => {
    let admissions = 0;
    const { adapter } = adapterFor(
      async () => offPolicy,
      async () => {
        admissions += 1;
        throw new Error("must not admit");
      },
    );
    const off = await adapter.capabilities();
    await expect(adapter.execute(prompt, { toolCallId: "call-video" })).resolves.toEqual(off);
    expect(admissions).toBe(0);
  });

  test("who can turn video on is read live, and only while video is off", async () => {
    let policy = offPolicy;
    let actorReads = 0;
    let canChange = false;
    const { adapter } = adapterFor(
      async () => policy,
      async () => ({
        schemaVersion: 1,
        status: "accepted",
        operationId: "77777777-7777-4777-8777-777777777777",
      }),
      async () => {
        actorReads += 1;
        return canChange;
      },
    );
    await expect(adapter.capabilities()).resolves.not.toHaveProperty("turnOn");
    canChange = true;
    const off = await adapter.execute(prompt, { toolCallId: "call-video" });
    if (!("turnOn" in off) || !off.turnOn) throw new Error("expected a turn-on call");
    expect(actorReads).toBe(2);
    policy = {
      schemaVersion: 1,
      revision: 8,
      fundingSource: off.turnOn.body.fundingSource,
      enabledModelIds: off.turnOn.body.enabledModelIds,
      defaultModelId: off.turnOn.body.defaultModelId,
    };
    await adapter.capabilities();
    expect(actorReads).toBe(2);
  });

  test("a failed permission read answers by who sent the message instead of failing", async () => {
    const failing = async () => {
      throw new Error("database unavailable");
    };
    const notAdmitted = async () => {
      throw new Error("must not admit");
    };
    const member = adapterFor(async () => offPolicy, notAdmitted, failing).adapter;
    const memberOff = await member.capabilities();
    expect(memberOff).toMatchObject({ code: "video_generation_off" });
    expect(memberOff).not.toHaveProperty("turnOn");
    expect((memberOff as { message: string }).message).toContain(
      "A workspace admin can turn it on in Settings.",
    );
    await expect(member.execute(prompt, { toolCallId: "call-video" })).resolves.toEqual(memberOff);
    const external = adapterFor(async () => offPolicy, notAdmitted, failing, {
      external: true,
    }).adapter;
    await expect(external.capabilities()).resolves.toMatchObject({
      message:
        "Video generation is off in this workspace. A workspace admin can turn it on. Tell the person plainly; offer an image instead if that helps.",
    });
  });

  test("a deployment that can't make video never checks who can turn it on", async () => {
    let reads = 0;
    const { adapter } = adapterFor(
      async () => offPolicy,
      async () => {
        throw new Error("must not admit");
      },
      async () => {
        reads += 1;
        return true;
      },
      { settings: managedSettings({ environmentsEncryptionKey: undefined }) },
    );
    await expect(adapter.capabilities()).resolves.toMatchObject({
      code: "video_generation_unsupported",
    });
    expect(reads).toBe(0);
  });

  test("a credit refusal at admission is a plain result, not a tool error", async () => {
    const onPolicy: VideoGenerationPolicy = {
      schemaVersion: 1,
      revision: 8,
      fundingSource: "opengeni_credits",
      enabledModelIds: [SEEDANCE_2_5_MODEL_ID],
      defaultModelId: SEEDANCE_2_5_MODEL_ID,
    };
    const refusals = [
      [
        new VideoGenerationCreditError("The workspace usage allowance is exhausted."),
        {
          code: "insufficient_credits",
          message:
            "This video can't be paid for: The workspace usage allowance is exhausted. Nothing was generated or charged.",
        },
      ],
      [
        new VideoGenerationCreditError(),
        {
          code: "insufficient_credits",
          message:
            "This video can't be paid for: insufficient workspace credits. Nothing was generated or charged.",
        },
      ],
      [
        new VideoGenerationCapacityError("Workspace video generation limit reached", "concurrency"),
        {
          code: "generation_limit_reached",
          message:
            "Video generation can't start: this workspace is already making as many videos as it can at once. Try again when one finishes. Nothing was generated or charged.",
        },
      ],
      [
        new VideoGenerationCapacityError("Workspace video storage quota reached", "storage"),
        {
          code: "video_storage_full",
          message:
            "Video generation can't start: this workspace's video storage is full. Deleting videos it no longer needs frees space. Nothing was generated or charged.",
        },
      ],
    ] as const;
    for (const [error, expected] of refusals) {
      const { adapter } = adapterFor(
        async () => onPolicy,
        async () => {
          throw error;
        },
      );
      await expect(adapter.execute(prompt, { toolCallId: "call-video" })).resolves.toEqual({
        schemaVersion: 1,
        status: "unavailable",
        operationCreated: false,
        ...expected,
      });
    }
    const { adapter } = adapterFor(
      async () => onPolicy,
      async () => {
        throw new Error("database unavailable");
      },
    );
    await expect(adapter.execute(prompt, { toolCallId: "call-video" })).rejects.toThrow(
      "database unavailable",
    );
  });
});
