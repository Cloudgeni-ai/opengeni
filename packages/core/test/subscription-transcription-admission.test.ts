import { afterEach, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { assertSubscriptionTranscriptionAllowed } from "../src/transcription-service/providers/subscription-core";

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
