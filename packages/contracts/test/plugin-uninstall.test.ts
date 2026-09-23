import { describe, expect, test } from "bun:test";
import { PluginUninstallPreview, UninstallPluginRequest } from "../src";

describe("Plugin removal impact contracts", () => {
  test("accepts named retained customized Skill and exact owner names", () => {
    const result = PluginUninstallPreview.parse({
      pluginKey: "example/plugin",
      installed: true,
      version: "1.0.0",
      installationVersion: 1,
      previewToken: "a".repeat(64),
      components: [
        {
          capabilityId: "skill/example",
          kind: "skill",
          name: "My customized Skill",
          retainedByOtherOwners: true,
          disposition: "retained",
          retentionReasons: ["customized", "other_owners"],
          remainingOwners: [{ kind: "plugin", name: "Research Plugin" }],
          skillId: "00000000-0000-4000-8000-000000000001",
        },
      ],
    });
    expect(result.components[0]?.name).toBe("My customized Skill");
    expect(result.previewToken).toBe("a".repeat(64));
  });
  test("old mutation requests remain valid while tokens are validated", () => {
    const request = { expectedInstallationVersion: 1, idempotencyKey: crypto.randomUUID() };
    expect(UninstallPluginRequest.safeParse(request).success).toBe(true);
    expect(
      UninstallPluginRequest.safeParse({ ...request, expectedPreviewToken: "a".repeat(64) })
        .success,
    ).toBe(true);
    expect(
      UninstallPluginRequest.safeParse({ ...request, expectedPreviewToken: "stale" }).success,
    ).toBe(false);
    expect(
      UninstallPluginRequest.safeParse({ ...request, removeCustomizedSkills: true }).success,
    ).toBe(false);
  });
});
