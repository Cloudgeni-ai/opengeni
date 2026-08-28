import { describe, expect, test } from "bun:test";

describe("internal applications preview boundary", () => {
  test("guards direct navigation with the projected deployment flag", async () => {
    const source = await Bun.file(`${import.meta.dir}/internal-applications.tsx`).text();

    expect(source).toContain("context.clientConfig.advancedDeployments?.enabled === true");
    expect(source).toContain('title="Page not found"');
    expect(source).toContain("if (!enabled) return;");
    expect(source).toContain("createInternalApplicationBuildSession");
    expect(source).toContain("retireInternalApplicationDeployment");
    expect(source).toContain("listInternalApplicationEvents");
  });
});
