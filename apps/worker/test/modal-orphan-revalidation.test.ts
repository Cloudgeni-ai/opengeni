import { describe, expect, test } from "bun:test";
import type { LiveModalSandboxLeaseAttribution } from "@opengeni/db";
import {
  countWarmModalLeasesMissingInstance,
  modalOrphanCandidateStillUnowned,
  modalOrphanTerminationStillEligible,
} from "../src/activities/sandbox-lease";

const lease: LiveModalSandboxLeaseAttribution = {
  leaseId: "lease-1",
  workspaceId: "ws-1",
  sandboxGroupId: "group-1",
  instanceId: "sb-live",
  liveness: "warming",
};

const candidate = (sandboxId: string) => ({
  sandboxId,
  reason: "stale_attribution" as const,
  tags: {
    opengeni_lease_id: lease.leaseId,
    opengeni_workspace_id: lease.workspaceId,
    opengeni_sandbox_group_id: lease.sandboxGroupId,
  },
});

describe("Modal orphan pre-termination lease revalidation", () => {
  test("spares a newly registered exact provider instance", () => {
    expect(modalOrphanTerminationStillEligible([lease], candidate("sb-live"))).toBe(false);
  });

  test("spares an active warming attribution before its exact instance is known", () => {
    expect(
      modalOrphanTerminationStillEligible([{ ...lease, instanceId: null }], candidate("sb-new")),
    ).toBe(false);
  });

  test("does not let copied tags protect a different provider instance", () => {
    expect(modalOrphanTerminationStillEligible([lease], candidate("sb-copy"))).toBe(true);
  });

  test("lost create reply also protects an untagged provider until attribution", () => {
    const untagged = { sandboxId: "sb-unreturned", reason: "unattributed" as const, tags: {} };
    expect(modalOrphanTerminationStillEligible([{ ...lease, instanceId: null }], untagged)).toBe(
      false,
    );
    expect(modalOrphanTerminationStillEligible([lease], untagged)).toBe(true);
  });

  test("inventory ownership ignores the pending-create postponement", () => {
    const pending = { ...lease, leaseId: "lease-2", instanceId: null };
    const untagged = { sandboxId: "sb-orphan", reason: "unattributed" as const, tags: {} };
    // Termination waits for the unreturned create, but the box is still unleased.
    expect(modalOrphanTerminationStillEligible([pending], untagged)).toBe(false);
    expect(modalOrphanCandidateStillUnowned([pending], untagged)).toBe(true);
    // Ownership established after the listing (exact instance or attribution) is not a leak.
    expect(modalOrphanCandidateStillUnowned([lease], candidate("sb-live"))).toBe(false);
    expect(
      modalOrphanCandidateStillUnowned([{ ...lease, instanceId: null }], candidate("sb-new")),
    ).toBe(false);
  });

  test("only a still-warm lease whose box is gone counts as a zombie", () => {
    const warm = { ...lease, liveness: "warm" };
    const draining = {
      ...lease,
      leaseId: "lease-d",
      instanceId: "sb-draining",
      liveness: "draining",
    };
    const rotated = { ...lease, leaseId: "lease-r", instanceId: "sb-new", liveness: "warm" };
    expect(
      countWarmModalLeasesMissingInstance(
        [warm, draining, rotated],
        // sb-live: warm zombie; sb-draining: mid-drain; sb-old: lease moved on.
        ["sb-live", "sb-draining", "sb-old"],
      ),
    ).toBe(1);
  });
});
