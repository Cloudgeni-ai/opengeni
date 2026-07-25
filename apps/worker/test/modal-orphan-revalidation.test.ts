import { describe, expect, test } from "bun:test";
import type { LiveModalSandboxLeaseAttribution } from "@opengeni/db";
import { modalOrphanTerminationStillEligible } from "../src/activities/sandbox-lease";

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
});
