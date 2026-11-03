import { afterEach, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { assertSubscriptionTranscriptionAllowed } from "../src/transcription-service/providers/subscription-core";
import {
  createSpeechToTextDeployment,
  meetingModelFor,
  createTranscriptionService,
} from "../src/transcription-service";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});
const settings = testSettings({
  billingMode: "stripe",
  subscriptionPlansEnabled: true,
  byokPlatformFeeBps: 0,
});
const input = { db: {} as db.Database, settings, accountId: crypto.randomUUID() };

function deployment() {
  const s = {
    ...settings,
    codexSubscriptionEnabled: true,
    voiceInputProviderOrder: "codex-subscription,openai",
    recordingWordAlignment: true,
  };
  const speech = createSpeechToTextDeployment(
    { settings: s, db: input.db },
    {
      isEuOnly: async () => false,
      probeCodex: async () => true,
    },
  );
  return {
    settings: s,
    speech,
    service: createTranscriptionService({ settings: s, db: input.db, deployment: speech }),
  };
}
const scope = { accountId: input.accountId, workspaceId: crypto.randomUUID() };
const codex = { providerId: "codex-subscription", model: "chatgpt-dictation" };

test("API meeting defaults skip a saved subscription while explicit requests refuse it", async () => {
  const { speech } = deployment();
  await db.withBillingOriginOverride("api", async () => {
    expect((await meetingModelFor(speech, codex, scope, true)).providerId).toBe("openai");
    await expect(meetingModelFor(speech, codex, scope)).rejects.toMatchObject({
      status: 403,
      subscriptionCode: "subscription_api_unavailable",
    });
  });
});

test("API dictation uses a credit fallback but preserves an explicit subscription refusal", async () => {
  const { service } = deployment();
  await db.withBillingOriginOverride("api", async () => {
    expect(
      await service.selectProvider!({ ...scope, preferredProvider: "codex-subscription" }),
    ).toBe("openai");
    await expect(
      service.transcribe({
        ...scope,
        ...codex,
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
        requestId: "refused",
      }),
    ).rejects.toMatchObject({
      status: 403,
      subscriptionCode: "subscription_api_unavailable",
    });
  });
});

test("Free dictation without fallback retains the upgrade refusal instead of unavailable", async () => {
  const standing = spyOn(db, "getOrganizationPlanStanding").mockResolvedValue({
    plan: { key: "free", status: "active" } as never,
    monthlyPriceMicros: 0,
  });
  restores.push(() => standing.mockRestore());
  const { service } = deployment();
  await expect(
    service.selectProvider!({
      ...scope,
      preferredProvider: "codex-subscription",
      fallbackEnabled: false,
    }),
  ).rejects.toMatchObject({
    status: 402,
    subscriptionCode: "subscription_plan_required",
    message: "Upgrade to Pro to use your own subscription.",
  });
});

test("API voice operations cannot use a subscription, even when fees are paused", async () => {
  await expect(
    db.withBillingOriginOverride("api", () => assertSubscriptionTranscriptionAllowed(input)),
  ).rejects.toMatchObject({ status: 403, code: "permission_denied", fallbackSafe: false });
});

test("subscription transcription needs a qualifying app plan, never fee credit", async () => {
  const standing = spyOn(db, "getOrganizationPlanStanding").mockResolvedValue({
    plan: { key: "free", status: "active" } as never,
    monthlyPriceMicros: 0,
  });
  restores.push(() => standing.mockRestore());
  await expect(assertSubscriptionTranscriptionAllowed(input)).rejects.toMatchObject({
    status: 402,
    message: "Upgrade to Pro to use your own subscription.",
  });
  standing.mockResolvedValue({
    plan: { key: "pro", status: "active" } as never,
    monthlyPriceMicros: 20_000_000,
  });
  await expect(assertSubscriptionTranscriptionAllowed(input)).resolves.toBeUndefined();
});
