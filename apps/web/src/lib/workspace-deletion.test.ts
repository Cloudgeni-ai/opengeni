import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

import { deleteWorkspaceWithReconciliation } from "./workspace-deletion";

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

    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {
          throw mutationError;
        },
        readWorkspace: async () => ({ id: "workspace" }),
      }),
    ).rejects.toBe(mutationError);
  });

  test("preserves the mutation error when the point read is inconclusive", async () => {
    const mutationError = new TypeError("network failed");

    await expect(
      deleteWorkspaceWithReconciliation({
        deleteWorkspace: async () => {
          throw mutationError;
        },
        readWorkspace: async () => {
          throw new OpenGeniApiError(503, "unavailable");
        },
      }),
    ).rejects.toBe(mutationError);
  });
});
