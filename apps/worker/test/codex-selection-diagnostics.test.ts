import { expect, test } from "bun:test";
import { codexSelectionDiagnostics } from "../src/activities/agent-turn/codex-selection-diagnostics";
test("assignment, explicit switches and reuse are separate observations", () => {
  const input = {
    previousCredentialId: null,
    credentialId: "b",
    reusedLease: false,
    pinnedCredentialId: null,
  };
  expect(codexSelectionDiagnostics(input)).toEqual({
    reason: "assigned",
    transition: "assigned",
    source: "allocator",
  });
  expect(codexSelectionDiagnostics({ ...input, previousCredentialId: "a" })).toEqual({
    reason: "switched",
    transition: "switched",
    source: "allocator",
  });
  expect(
    codexSelectionDiagnostics({
      ...input,
      previousCredentialId: "a",
      pinnedCredentialId: "b",
      pinSource: "manual",
    }),
  ).toEqual({ reason: "switched", transition: "switched", source: "manual_pin" });
  expect(
    codexSelectionDiagnostics({ ...input, previousCredentialId: "b", reusedLease: true }),
  ).toEqual({ reason: "lease_reused", transition: "unchanged", source: "allocator" });
});

test("automatic policy pins never become manual selection diagnostics", () => {
  expect(
    codexSelectionDiagnostics({
      previousCredentialId: "a",
      credentialId: "b",
      reusedLease: false,
      pinnedCredentialId: "b",
      pinSource: "policy",
    }),
  ).toEqual({ reason: "switched", transition: "switched", source: "allocator" });
});

test("legacy matching pins with no source retain manual semantics", () => {
  expect(
    codexSelectionDiagnostics({
      previousCredentialId: "a",
      credentialId: "b",
      reusedLease: false,
      pinnedCredentialId: "b",
      pinSource: null,
    }),
  ).toEqual({ reason: "switched", transition: "switched", source: "manual_pin" });
});
