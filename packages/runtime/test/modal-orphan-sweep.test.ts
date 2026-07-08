import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { sweepModalOrphanSandboxes } from "../src/sandbox";
import type { LiveModalSandboxLeaseAttribution } from "@opengeni/db";

// The orphan sweep's LIVE-INSTANCE GUARD: a box that any live lease's envelope
// points at is NEVER terminated, whatever its tags say. Tags are best-effort
// attribution (setTags is a separate call after create and can fail or lag);
// judging by tags alone terminated a LIVE box mid-turn at exactly
// creation+30min (staging session e644e8a8, 2026-07-06).

const MODAL_SETTINGS = {
  sandboxBackend: "modal" as const,
  modalTokenId: "tok-id",
  modalTokenSecret: "tok-secret",
  modalAppName: "opengeni-test-app",
};

type FakeSandboxInfo = {
  id: string;
  createdAt?: number;
  tags?: Array<{ tagName?: string; tagValue?: string }>;
};

function fakeModalClient(sandboxes: FakeSandboxInfo[]) {
  const terminated: string[] = [];
  const retagged: Array<{ id: string; tags: Record<string, string> }> = [];
  let listed = false;
  const client = {
    apps: {
      fromName: async () => ({ appId: "app-1" }),
    },
    cpClient: {
      sandboxList: async () => {
        // Single page: return everything once, then an empty page.
        if (listed) {
          return { sandboxes: [] };
        }
        listed = true;
        return { sandboxes };
      },
    },
    sandboxes: {
      fromId: async (id: string) => ({
        terminate: async () => {
          terminated.push(id);
        },
        setTags: async (tags: Record<string, string>) => {
          retagged.push({ id, tags });
        },
      }),
    },
    close: () => {},
  };
  return { client, terminated, retagged };
}

function attributionTags(input: { leaseId: string; workspaceId: string; sandboxGroupId: string }) {
  return [
    { tagName: "opengeni", tagValue: "true" },
    { tagName: "opengeni_lease_id", tagValue: input.leaseId },
    { tagName: "opengeni_workspace_id", tagValue: input.workspaceId },
    { tagName: "opengeni_sandbox_group_id", tagValue: input.sandboxGroupId },
  ];
}

const LIVE_LEASE: LiveModalSandboxLeaseAttribution = {
  leaseId: "lease-1",
  workspaceId: "ws-1",
  sandboxGroupId: "grp-1",
  instanceId: "sb-live",
  liveness: "warm",
};

describe("sweepModalOrphanSandboxes live-instance guard", () => {
  test("never terminates an UNTAGGED box a live lease points at — and heals its tags", async () => {
    // The incident shape: the box lost/never got its attribution tags, is past
    // the unattributed grace, but a live lease resumes it by id every turn.
    const { client, terminated, retagged } = fakeModalClient([
      { id: "sb-live", createdAt: 1_000, tags: [] },
    ]);
    const result = await sweepModalOrphanSandboxes(testSettings(MODAL_SETTINGS), [LIVE_LEASE], {
      client: client as any,
      now: new Date(1_000_000 + 60 * 60_000),
    });
    expect(terminated).toEqual([]);
    expect(result.terminated).toEqual([]);
    expect(result.skipped).toBe(1);
    // Attribution healed so the box stops looking sweep-eligible.
    expect(retagged).toEqual([
      {
        id: "sb-live",
        tags: {
          opengeni: "true",
          opengeni_lease_id: "lease-1",
          opengeni_workspace_id: "ws-1",
          opengeni_sandbox_group_id: "grp-1",
        },
      },
    ]);
  });

  test("never terminates a STALE-TAGGED box a live lease points at — and re-tags it", async () => {
    // Tags reference a lease that no longer exists (e.g. epoch churn re-created
    // the lease row) while the CURRENT live lease points at this box.
    const { client, terminated, retagged } = fakeModalClient([
      {
        id: "sb-live",
        createdAt: 1_000,
        tags: attributionTags({
          leaseId: "lease-OLD",
          workspaceId: "ws-1",
          sandboxGroupId: "grp-1",
        }),
      },
    ]);
    const result = await sweepModalOrphanSandboxes(testSettings(MODAL_SETTINGS), [LIVE_LEASE], {
      client: client as any,
      now: new Date(1_000_000 + 60 * 60_000),
    });
    expect(terminated).toEqual([]);
    expect(result.terminated).toEqual([]);
    expect(retagged.map((r) => r.tags.opengeni_lease_id)).toEqual(["lease-1"]);
  });

  test("a correctly-tagged live box is skipped without re-tagging", async () => {
    const { client, terminated, retagged } = fakeModalClient([
      {
        id: "sb-live",
        createdAt: 1_000,
        tags: attributionTags({ leaseId: "lease-1", workspaceId: "ws-1", sandboxGroupId: "grp-1" }),
      },
    ]);
    const result = await sweepModalOrphanSandboxes(testSettings(MODAL_SETTINGS), [LIVE_LEASE], {
      client: client as any,
      now: new Date(1_000_000 + 60 * 60_000),
    });
    expect(terminated).toEqual([]);
    expect(retagged).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  test("still terminates genuinely orphaned boxes (no live lease points at them)", async () => {
    const { client, terminated } = fakeModalClient([
      // Unattributed and past grace, NOT referenced by any live lease.
      { id: "sb-derelict", createdAt: 1_000, tags: [] },
      // Tagged with an attribution no live lease matches.
      {
        id: "sb-stale",
        createdAt: 1_000,
        tags: attributionTags({
          leaseId: "lease-GONE",
          workspaceId: "ws-2",
          sandboxGroupId: "grp-2",
        }),
      },
      // Fresh unattributed box still inside the grace window — spared.
      { id: "sb-fresh", createdAt: (1_000_000 + 55 * 60_000) / 1000, tags: [] },
    ]);
    const result = await sweepModalOrphanSandboxes(testSettings(MODAL_SETTINGS), [LIVE_LEASE], {
      client: client as any,
      now: new Date(1_000_000 + 60 * 60_000),
    });
    expect(terminated.sort()).toEqual(["sb-derelict", "sb-stale"]);
    expect(result.terminated.map((t) => t.reason).sort()).toEqual([
      "stale_attribution",
      "unattributed",
    ]);
  });

  test("a failed re-tag never fails the sweep and the box is still spared", async () => {
    const { client, terminated } = fakeModalClient([{ id: "sb-live", createdAt: 1_000, tags: [] }]);
    (client.sandboxes as { fromId: unknown }).fromId = async () => ({
      terminate: async () => {
        terminated.push("sb-live");
      },
      setTags: async () => {
        throw new Error("tag write refused");
      },
    });
    const result = await sweepModalOrphanSandboxes(testSettings(MODAL_SETTINGS), [LIVE_LEASE], {
      client: client as any,
      now: new Date(1_000_000 + 60 * 60_000),
    });
    expect(terminated).toEqual([]);
    expect(result.terminated).toEqual([]);
    expect(result.skipped).toBe(1);
  });
});
