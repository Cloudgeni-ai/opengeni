import { describe, expect, test } from "bun:test";
import {
  capabilityPackRequiresInstallationPlan,
  getCapabilityPack,
  listCapabilityPacks,
} from "@opengeni/core";

describe("built-in capability packs", () => {
  test("keeps built-in runtime additions behind reviewed installation", () => {
    for (const pack of listCapabilityPacks()) {
      expect(pack.sandboxImage).toBeUndefined();
      expect(pack.sandboxProviderImages).toBeUndefined();
      if (pack.skills.length > 0) {
        expect(capabilityPackRequiresInstallationPlan(pack)).toBe(true);
      }
    }

    expect(getCapabilityPack("opengeni-lens")?.skills.map((skill) => skill.name)).toEqual([
      "pr-review",
    ]);
  });
});
