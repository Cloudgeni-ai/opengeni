import { expect, test } from "bun:test";
import type { SuperGrokAccount } from "@opengeni/sdk";

import { formatCreditBalance } from "./codex-account-usage";
import { planOf } from "./supergrok-models";

test("the Codex credit balance reads as a number, not the raw decimal string", () => {
  expect(formatCreditBalance("61686.5843250000")).toBe(
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(61686.58),
  );
  expect(formatCreditBalance("0")).toBe("0");
  expect(formatCreditBalance(null)).toBe("Not reported");
  expect(formatCreditBalance(undefined)).toBe("Not reported");
  expect(formatCreditBalance("unknown")).toBe("unknown");
});

test("a SuperGrok plan never repeats the product name", () => {
  const account = (plan: string | null, tier: string | null = null) =>
    ({ plan, quota: tier === null ? null : { subscriptionTier: tier } }) as SuperGrokAccount;
  expect(planOf(account(null, "SuperGrok"))).toBe("SuperGrok");
  expect(planOf(account(null, "SuperGrok Heavy"))).toBe("SuperGrok Heavy");
  expect(planOf(account("heavy"))).toBe("SuperGrok Heavy");
  expect(planOf(account(null))).toBe("SuperGrok plan");
});
