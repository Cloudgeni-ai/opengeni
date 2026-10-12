// The SDK's hand-written model-account choice and preference types mirror
// the `@opengeni/contracts` schemas in both directions.
import { expect, test } from "bun:test";
import {
  ModelAccountPreferences as ContractPreferences,
  SessionModelAccountChoiceResponse as ContractChoice,
  SetSessionModelAccountChoiceRequest as ContractSetChoice,
  SetSessionModelAccountChoiceResponse as ContractSetChoiceResult,
  UpdateModelAccountPreferencesRequest as ContractUpdatePreferences,
} from "@opengeni/contracts";
import type { z } from "zod";
import type {
  ModelAccountPreferences,
  SessionModelAccountChoice,
  SetSessionModelAccountChoiceRequest,
  SetSessionModelAccountChoiceResult,
  UpdateModelAccountPreferencesRequest,
} from "../src/types";

test("model-account choice and preference shapes are parity-pinned", () => {
  // Server -> client: what the API returns is what the SDK declares.
  const choice = (v: z.infer<typeof ContractChoice>): SessionModelAccountChoice => v;
  const setResult = (
    v: z.infer<typeof ContractSetChoiceResult>,
  ): SetSessionModelAccountChoiceResult => v;
  const preferences = (v: z.infer<typeof ContractPreferences>): ModelAccountPreferences => v;
  // Client -> server: every SDK request is a valid contract input.
  const setChoice = (v: SetSessionModelAccountChoiceRequest): z.input<typeof ContractSetChoice> =>
    v;
  const updatePreferences = (
    v: UpdateModelAccountPreferencesRequest,
  ): z.input<typeof ContractUpdatePreferences> => v;

  const connectionId = "00000000-0000-4000-8000-000000000001";
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
      },
    ],
    personal: { connectionsAllowed: true, fallbackAllowed: false, fallbackOptIn: false },
  });
  expect(choice(response).accounts[0]?.refusal).toBe("personal_not_owner_work");
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
