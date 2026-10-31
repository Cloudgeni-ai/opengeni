import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

import {
  WORKSPACE_DELETION_CONFIRM_DELAYS_MS,
  completeWorkspaceDeletionFollowUp,
  deleteOrganizationWorkspaceWithReconciliation,
  deleteWorkspaceWithReconciliation,
} from "./workspace-deletion";

function recordingSleep() {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

describe("workspace deletion reconciliation", () => {
  test("accepts direct success without a point read", async () => {
    let reads = 0;

    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {},
        readWorkspace: async () => {
          reads += 1;
        },
      }),
    ).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });

  test("accepts a DELETE 404 without a point read", async () => {
    let reads = 0;

    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {
          throw new OpenGeniApiError(404, "missing", { mutation: true });
        },
        readWorkspace: async () => {
          reads += 1;
        },
      }),
    ).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });

  for (const [label, mutationError] of [
    [
      "response marked outcome-unknown",
      new OpenGeniApiError(503, "unavailable", { mutation: true, outcomeUnknown: true }),
    ],
    ["transport error", new TypeError("network failed")],
  ] as const) {
    test(`accepts a ${label} when the point read proves deletion`, async () => {
      await expect(
        deleteWorkspaceWithReconciliation({
          deleteWorkspace: async () => {
            throw mutationError;
          },
          readWorkspace: async () => {
            throw new OpenGeniApiError(404, "missing");
          },
        }),
      ).resolves.toBeUndefined();
    });
  }

  for (const mutationError of [
    new OpenGeniApiError(400, "bad request", { mutation: true }),
    new OpenGeniApiError(409, "workspace is not quiescent", { mutation: true }),
    new OpenGeniApiError(500, "failed", { mutation: true }),
  ]) {
    test(`preserves a definitive ${mutationError.status} without a point read`, async () => {
      let reads = 0;

      await expect(
        deleteWorkspaceWithReconciliation({
          deleteWorkspace: async () => {
            throw mutationError;
          },
          readWorkspace: async () => {
            reads += 1;
            throw new OpenGeniApiError(404, "missing");
          },
        }),
      ).rejects.toBe(mutationError);
      expect(reads).toBe(0);
    });
  }

  test("preserves the mutation error when the workspace still exists", async () => {
    const mutationError = new OpenGeniApiError(503, "unavailable", {
      mutation: true,
      outcomeUnknown: true,
    });
    const clock = recordingSleep();
    let reads = 0;

    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {
          throw mutationError;
        },
        readWorkspace: async () => {
          reads += 1;
          return { id: "workspace" };
        },
        sleep: clock.sleep,
      }),
    ).rejects.toBe(mutationError);
    // Every read in the confirmation window still found it.
    expect(reads).toBe(WORKSPACE_DELETION_CONFIRM_DELAYS_MS.length);
    expect(clock.slept).toEqual(WORKSPACE_DELETION_CONFIRM_DELAYS_MS.filter((ms) => ms > 0));
  });

  test("preserves the mutation error when the point read is inconclusive", async () => {
    const mutationError = new TypeError("network failed");
    const clock = recordingSleep();
    let reads = 0;

    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {
          throw mutationError;
        },
        readWorkspace: async () => {
          reads += 1;
          throw new OpenGeniApiError(503, "unavailable");
        },
        sleep: clock.sleep,
      }),
    ).rejects.toBe(mutationError);
    expect(reads).toBe(WORKSPACE_DELETION_CONFIRM_DELAYS_MS.length);
  });

  test("confirms a delete whose response was lost while the server was still committing it", async () => {
    // The browser lost the DELETE response; the first reads race the server's
    // still-open deletion transaction and see the workspace, then it is gone.
    const mutationError = new OpenGeniApiError(502, "", { mutation: true });
    expect(mutationError.outcomeUnknown).toBe(true);
    const clock = recordingSleep();
    const answers: Array<() => unknown> = [
      () => ({ id: "workspace" }),
      () => ({ id: "workspace" }),
      () => {
        throw new OpenGeniApiError(404, "missing");
      },
    ];
    let reads = 0;

    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {
          throw mutationError;
        },
        readWorkspace: async () => answers[reads++]!(),
        sleep: clock.sleep,
      }),
    ).resolves.toBeUndefined();
    expect(reads).toBe(3);
    expect(clock.slept).toEqual([500, 1_000]);
  });

  test("keeps confirming through a transient read failure", async () => {
    const clock = recordingSleep();
    let reads = 0;

    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {
          throw new TypeError("network failed");
        },
        readWorkspace: async () => {
          reads += 1;
          if (reads === 1) throw new TypeError("network failed");
          if (reads === 2) throw new OpenGeniApiError(503, "unavailable");
          return null;
        },
        sleep: clock.sleep,
      }),
    ).resolves.toBeUndefined();
    expect(reads).toBe(3);
  });

  test("stops confirming when the read is definitively refused", async () => {
    const mutationError = new TypeError("network failed");
    const clock = recordingSleep();
    let reads = 0;

    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {
          throw mutationError;
        },
        readWorkspace: async () => {
          reads += 1;
          throw new OpenGeniApiError(401, "signed out");
        },
        sleep: clock.sleep,
      }),
    ).rejects.toBe(mutationError);
    expect(reads).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  test("waits about half a minute in total before reporting an unconfirmed delete", () => {
    const totalMs = WORKSPACE_DELETION_CONFIRM_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(WORKSPACE_DELETION_CONFIRM_DELAYS_MS[0]).toBe(0);
    expect(totalMs).toBeGreaterThanOrEqual(25_000);
    expect(totalMs).toBeLessThanOrEqual(45_000);
  });

  test("accepts an authoritative null point read", async () => {
    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {
          throw new TypeError("network failed");
        },
        readWorkspace: async () => null,
      }),
    ).resolves.toBeUndefined();
  });

  test("reconciles organization-admin deletion through the administration overview", async () => {
    const mutationError = new OpenGeniApiError(503, "unavailable", {
      mutation: true,
      outcomeUnknown: true,
    });
    let reads = 0;

    await expect(
      deleteOrganizationWorkspaceWithReconciliation({
        client: {
          deleteOrganizationWorkspace: async () => {
            throw mutationError;
          },
          getOrganizationAdministrationOverview: async () => {
            reads += 1;
            return { workspaces: [{ id: "remaining-workspace" }] };
          },
        },
        organizationId: "organization",
        workspaceId: "deleted-workspace",
      }),
    ).resolves.toEqual({ workspaces: [{ id: "remaining-workspace" }] });
    expect(reads).toBe(1);
  });

  test("confirms organization-admin deletion once the overview stops listing it", async () => {
    const clock = recordingSleep();
    let reads = 0;

    await expect(
      deleteOrganizationWorkspaceWithReconciliation({
        client: {
          deleteOrganizationWorkspace: async () => {
            throw new TypeError("network failed");
          },
          getOrganizationAdministrationOverview: async () => {
            reads += 1;
            return reads === 1
              ? { workspaces: [{ id: "deleted-workspace" }, { id: "remaining-workspace" }] }
              : { workspaces: [{ id: "remaining-workspace" }] };
          },
        },
        organizationId: "organization",
        workspaceId: "deleted-workspace",
        sleep: clock.sleep,
      }),
    ).resolves.toEqual({ workspaces: [{ id: "remaining-workspace" }] });
    expect(reads).toBe(2);
    expect(clock.slept).toEqual([500]);
  });

  test("returns a fresh organization overview after direct deletion success", async () => {
    let reads = 0;

    await expect(
      deleteOrganizationWorkspaceWithReconciliation({
        client: {
          deleteOrganizationWorkspace: async () => {},
          getOrganizationAdministrationOverview: async () => {
            reads += 1;
            return { workspaces: [{ id: "current-workspace" }] };
          },
        },
        organizationId: "organization",
        workspaceId: "deleted-workspace",
      }),
    ).resolves.toEqual({ workspaces: [{ id: "current-workspace" }] });
    expect(reads).toBe(1);
  });

  test("keeps deletion successful when the post-delete overview refresh is unavailable", async () => {
    await expect(
      deleteOrganizationWorkspaceWithReconciliation({
        client: {
          deleteOrganizationWorkspace: async () => {},
          getOrganizationAdministrationOverview: async () => {
            throw new TypeError("network failed");
          },
        },
        organizationId: "organization",
        workspaceId: "deleted-workspace",
      }),
    ).resolves.toBeNull();
  });

  test("preserves an unknown organization-admin outcome while the workspace still exists", async () => {
    const mutationError = new TypeError("network failed");
    const clock = recordingSleep();

    await expect(
      deleteOrganizationWorkspaceWithReconciliation({
        client: {
          deleteOrganizationWorkspace: async () => {
            throw mutationError;
          },
          getOrganizationAdministrationOverview: async () => ({
            workspaces: [{ id: "target-workspace" }],
          }),
        },
        organizationId: "organization",
        workspaceId: "target-workspace",
        sleep: clock.sleep,
      }),
    ).rejects.toBe(mutationError);
    expect(clock.slept).toEqual(WORKSPACE_DELETION_CONFIRM_DELAYS_MS.filter((ms) => ms > 0));
  });

  test("keeps committed deletion successful when refresh fails and still attempts navigation", async () => {
    const refreshError = new TypeError("refresh failed");
    let navigated = false;

    await expect(
      completeWorkspaceDeletionFollowUp({
        refreshAccess: async () => {
          throw refreshError;
        },
        navigate: async () => {
          navigated = true;
        },
      }),
    ).resolves.toEqual({ status: "failed", error: refreshError });
    expect(navigated).toBe(true);
  });

  test("reports a navigation failure without rejecting committed deletion", async () => {
    const navigationError = new Error("navigation failed");

    await expect(
      completeWorkspaceDeletionFollowUp({
        refreshAccess: async () => {},
        navigate: async () => {
          throw navigationError;
        },
      }),
    ).resolves.toEqual({ status: "failed", error: navigationError });
  });
});
