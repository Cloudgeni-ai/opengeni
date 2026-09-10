import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

import { unlinkGitHubInstallationWithReconciliation } from "@/lib/github-installation-unlink";
import type { GitHubAppInfo } from "@/types";

function status(installationIds: number[]): GitHubAppInfo {
  return {
    configured: true,
    setupMode: "platform",
    status: installationIds.length > 0 ? "bound" : "unbound",
    appSlug: "opengeni",
    appName: "OpenGeni",
    installUrl: null,
    linkUrl: null,
    installations: installationIds.map((installationId) => ({
      installationId,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
    })),
  } as unknown as GitHubAppInfo;
}

describe("GitHub installation unlink reconciliation", () => {
  test("accepts direct success", async () => {
    await expect(
      unlinkGitHubInstallationWithReconciliation({
        installationId: 1,
        unlink: async () => {},
        readStatus: async () => {
          throw new Error("not used");
        },
      }),
    ).resolves.toBeUndefined();
  });

  for (const error of [
    new OpenGeniApiError(404, "missing", { mutation: true }),
    new OpenGeniApiError(503, "unavailable", { mutation: true, outcomeUnknown: true }),
    new TypeError("network failed"),
  ]) {
    test(`accepts ${error.name} when status proves the installation absent`, async () => {
      await expect(
        unlinkGitHubInstallationWithReconciliation({
          installationId: 1,
          unlink: async () => {
            throw error;
          },
          readStatus: async () => status([]),
        }),
      ).resolves.toBeUndefined();
    });
  }

  test("preserves the mutation error when the installation is still present", async () => {
    const error = new TypeError("network failed");
    await expect(
      unlinkGitHubInstallationWithReconciliation({
        installationId: 1,
        unlink: async () => {
          throw error;
        },
        readStatus: async () => status([1]),
      }),
    ).rejects.toBe(error);
  });

  test("reports a failed reconciliation read", async () => {
    const readError = new Error("status unavailable");
    await expect(
      unlinkGitHubInstallationWithReconciliation({
        installationId: 1,
        unlink: async () => {
          throw new TypeError("network failed");
        },
        readStatus: async () => {
          throw readError;
        },
      }),
    ).rejects.toBe(readError);
  });
});
