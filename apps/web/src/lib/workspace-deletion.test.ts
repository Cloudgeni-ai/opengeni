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

  for (const [label, mutationError] of [
    ["400 response", new OpenGeniApiError(400, "bad request", { mutation: true })],
    ["404 response", new OpenGeniApiError(404, "missing", { mutation: true })],
    ["500 response", new OpenGeniApiError(500, "failed", { mutation: true })],
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

  test("preserves the mutation error when the workspace still exists", async () => {
    const mutationError = new OpenGeniApiError(500, "failed", { mutation: true });

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
