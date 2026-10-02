import { describe, expect, test } from "bun:test";

import { walkthroughScreens, type WalkthroughPath } from "./onboarding-walkthrough";

const ids = (path: WalkthroughPath) => walkthroughScreens(path).map((screen) => screen.id);
const PATHS: readonly WalkthroughPath[] = [
  "product-opengeni",
  "product-explore",
  "work",
  "skip",
  "no-trial",
  "invited",
];

describe("onboarding walkthrough", () => {
  test("each path walks its own screens in order", () => {
    // Every new person starts on the first question; no model step comes first.
    for (const path of PATHS.filter((candidate) => candidate !== "invited")) {
      const order = ids(path);
      expect(order[1]).toBe("use");
      expect(order).not.toContain("models");
    }
    expect(ids("product-opengeni")).toEqual(
      expect.arrayContaining([
        "product",
        "details",
        "details-filled",
        "details-no-github",
        "ready",
      ]),
    );
    // The person's own coding agent is set up later in the app, not in first run.
    expect(ids("product-opengeni")).not.toContain("own-agent");
    // Exploring asks nothing about the product.
    expect(ids("product-explore")).toContain("product");
    expect(ids("product-explore")).not.toContain("details");
    expect(ids("work")).not.toContain("product");
    expect(ids("skip")).toContain("ready");
    // The model step appears only without a trial grant.
    expect(ids("no-trial")).toEqual(expect.arrayContaining(["model-step", "ready-no-trial"]));
    expect(ids("no-trial")).not.toContain("ready");
    for (const path of ["product-opengeni", "work", "skip"] as const)
      expect(ids(path)).not.toContain("model-step");
    // An invited member skips the first question.
    expect(ids("invited")).toEqual(expect.arrayContaining(["invitation", "new-chat"]));
    // No Get started screens; the own coding agent waits in developer settings.
    for (const path of PATHS) {
      expect(ids(path).some((id) => id.includes("get-started") || id === "checklist")).toBe(false);
      expect(ids(path)).toContain("new-chat");
    }
    expect(ids("product-opengeni")).toEqual(
      expect.arrayContaining(["playground", "developer", "developer-worked"]),
    );
    expect(ids("invited")).not.toContain("use");
    for (const path of PATHS) {
      const screens = walkthroughScreens(path);
      expect(new Set(screens.map((screen) => screen.id)).size).toBe(screens.length);
      expect(screens[0]!.id).toBe("sign-up");
    }
  });

  test("screens carry the preview query for the path", () => {
    const ready = walkthroughScreens("product-opengeni").find((screen) => screen.id === "ready")!;
    expect(ready.params.get("view")).toBe("first-agent");
    expect(ready.params.get("step")).toBe("ready");
    expect(ready.params.get("credits")).toBe("trial");
    expect(ready.params.get("product")).toBe("have");
    expect(
      walkthroughScreens("skip")
        .find((screen) => screen.id === "ready")!
        .params.get("skipped"),
    ).toBe("1");
    expect(
      walkthroughScreens("no-trial")
        .find((screen) => screen.id === "model-step")!
        .params.get("model"),
    ).toBe("none");
  });
});
