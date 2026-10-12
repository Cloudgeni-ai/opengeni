// The SDK's hand-written model-account choice and preference types mirror
// the `@opengeni/contracts` schemas in both directions.
import { expect, test } from "bun:test";
import {
  ModelAccountPreferences as ContractPreferences,
  ModelAccountUsageSnapshot as ContractUsage,
  SessionModelAccountChoiceResponse as ContractChoice,
  SetSessionModelAccountChoiceRequest as ContractSetChoice,
  SetSessionModelAccountChoiceResponse as ContractSetChoiceResult,
  UpdateModelAccountPreferencesRequest as ContractUpdatePreferences,
} from "@opengeni/contracts";
import type { z } from "zod";
// Import the consumer-facing barrel, not the internal types file: this compile-time
// regression must fail if a public response type is missing from the package entry.
import type {
  ModelAccountPreferences,
  ModelAccountUsageSnapshot,
  SessionModelAccountChoiceResponse,
  SetSessionModelAccountChoiceRequest,
  SetSessionModelAccountChoiceResponse,
  UpdateModelAccountPreferencesRequest,
} from "@opengeni/sdk";

test("model-account choice and preference shapes are parity-pinned", () => {
  // Server -> client: what the API returns is what the SDK declares.
  const choice = (v: z.infer<typeof ContractChoice>): SessionModelAccountChoiceResponse => v;
  const setResult = (
    v: z.infer<typeof ContractSetChoiceResult>,
  ): SetSessionModelAccountChoiceResponse => v;
  const preferences = (v: z.infer<typeof ContractPreferences>): ModelAccountPreferences => v;
  // Client -> server: every SDK request is a valid contract input.
  const setChoice = (v: SetSessionModelAccountChoiceRequest): z.input<typeof ContractSetChoice> =>
    v;
  const updatePreferences = (
    v: UpdateModelAccountPreferencesRequest,
  ): z.input<typeof ContractUpdatePreferences> => v;

  const connectionId = "00000000-0000-4000-8000-000000000001";
  const usage: ModelAccountUsageSnapshot = {
    observedAt: "2020-01-01T00:00:00.000Z",
    source: "response_headers",
    windows: [
      { id: "primary", usedPercent: null, resetsAt: null, status: "unknown" },
      { id: "overage", usedPercent: 125, resetsAt: null, status: "unknown" },
    ],
    exhaustedUntil: null,
    exhaustedKind: null,
  };
  const usageToContract = (v: ModelAccountUsageSnapshot): z.infer<typeof ContractUsage> => v;
  const usageToSdk = (v: z.infer<typeof ContractUsage>): ModelAccountUsageSnapshot => v;
  expect(usageToSdk(ContractUsage.parse(usageToContract(usage)))).toEqual(usage);
  const response = ContractChoice.parse({
    binding: { provider: "acme", connectionId, choice: "explicit" },
    accounts: [
      {
        provider: "acme",
        connectionId,
        label: "Mine",
        accountEmail: null,
        planType: null,
        status: "active",
        personal: true,
        source: "personal",
        allowedModelIds: null,
        choosable: false,
        refusal: "personal_not_owner_work",
        usage,
      },
    ],
    personal: { connectionsAllowed: true, fallbackAllowed: false, fallbackOptIn: false },
  });
  expect(choice(response).accounts[0]?.refusal).toBe("personal_not_owner_work");
  expect(choice(response).accounts[0]?.usage).toEqual(usage);
  for (const compatibleUsage of [null, undefined]) {
    const older = structuredClone(response);
    if (compatibleUsage === undefined) delete older.accounts[0]!.usage;
    else older.accounts[0]!.usage = null;
    expect(ContractChoice.parse(older).accounts[0]?.usage).toBe(compatibleUsage);
  }
  expect(
    ContractUsage.safeParse({ ...usage, windows: [{ ...usage.windows[0], usedPercent: -1 }] })
      .success,
  ).toBe(false);
  expect(
    setResult(
      ContractSetChoiceResult.parse({
        changed: true,
        appliedTo: "next_turn",
        provider: "acme",
        connectionId,
        choice: "explicit",
      }),
    ).changed,
  ).toBe(true);
  expect(
    preferences(ContractPreferences.parse({ personalFallbackOptIn: true, version: 2 })),
  ).toEqual({ personalFallbackOptIn: true, version: 2 });
  expect(ContractSetChoice.parse(setChoice({ connectionId: null }))).toEqual({
    connectionId: null,
  });
  expect(
    ContractUpdatePreferences.parse(
      updatePreferences({ personalFallbackOptIn: false, expectedVersion: 0 }),
    ),
  ).toEqual({ personalFallbackOptIn: false, expectedVersion: 0 });
  // Unknown request fields are refused rather than silently dropped.
  expect(ContractSetChoice.safeParse({ connectionId: null, provider: "acme" }).success).toBe(false);
});
