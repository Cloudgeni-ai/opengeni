import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("leaving a workspace the person can't open for their own one leaves a notice for that page", () => {
  const route = readFileSync(new URL("./workspace-unavailable.tsx", import.meta.url), "utf8");
  // The notice is kept before the page is left, so the workspace that opens says why.
  expect(route).toMatch(
    /rememberRouteRecoveryNotice\("workspace_unavailable"\);\s*window\.location\.replace\(fallbackTarget\);/,
  );
});

test("the app shows a kept notice once the signed-in app has loaded", () => {
  const context = readFileSync(new URL("../context.tsx", import.meta.url), "utf8");
  expect(context).toContain("<RouteRecoveryNotice ready={accessContext !== null} />");
});
