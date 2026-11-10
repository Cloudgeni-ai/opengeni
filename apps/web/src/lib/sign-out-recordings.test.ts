import { expect, test } from "bun:test";
import type { ManagedAuthSessionSetProjection } from "@opengeni/sdk/accounts";

import { recordingOwnerForSignOut } from "./sign-out-recordings";

const slot = (id: string, email: string) => ({
  id,
  displayName: email,
  verifiedClaim: { kind: "email" as const, value: email },
  state: "active" as const,
});

const projection = (...slots: ReturnType<typeof slot>[]): ManagedAuthSessionSetProjection => ({
  mode: "broker",
  generation: "1",
  actorEpoch: "1",
  csrfToken: "x".repeat(32),
  selectedSlotId: slots[0]?.id ?? null,
  state: "ready",
  slots,
});

test("one account signing out removes its own recordings; the last one, or all, removes every one", () => {
  const two = projection(slot("a", "Ola@Example.com"), slot("b", "kari@example.com"));
  expect(recordingOwnerForSignOut(two, "a")).toBe("ola@example.com");
  expect(recordingOwnerForSignOut(two, "all")).toBeNull();
  expect(recordingOwnerForSignOut(projection(slot("a", "ola@example.com")), "a")).toBeNull();
  expect(recordingOwnerForSignOut(null, "a")).toBeNull();
});
