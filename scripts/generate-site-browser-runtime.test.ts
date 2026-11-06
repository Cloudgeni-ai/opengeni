import { expect, test } from "bun:test";
import { renderSiteBrowserRuntime } from "./generate-site-browser-runtime";

test("the version-independent Site bridge matches the checked-in bytes", async () => {
  const source = await renderSiteBrowserRuntime();
  // Version PRs change package.json without regenerating this host bridge.
  // Only actual npm SDK builds may identify themselves as a package version.
  expect(
    source ===
      (await Bun.file(
        new URL("../packages/sdk/src/site-browser-runtime.gen.ts", import.meta.url),
      ).text()),
  ).toBe(true);
});
