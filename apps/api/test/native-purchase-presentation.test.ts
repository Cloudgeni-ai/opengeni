import { expect, test } from "bun:test";
import { purchaseRefusalMessage } from "../src/http/native-purchase-presentation";

test("purchase refusal copy changes only for iOS and known refusal codes", () => {
  const original = "Add credits to use live voice";
  expect(purchaseRefusalMessage("insufficient_credits", original, "live voice", true)).toBe(
    "No credits are available for live voice.",
  );
  expect(purchaseRefusalMessage("insufficient_credits", original, "live voice", false)).toBe(
    original,
  );
  expect(
    purchaseRefusalMessage("allowance_exhausted", "Usage limit reached", "live voice", true),
  ).toBe("Usage limit reached");
  expect(purchaseRefusalMessage("sandbox_card_required", "Add a card", "model", true)).toBe(
    "Sandboxes aren't available for this organization.",
  );
});
