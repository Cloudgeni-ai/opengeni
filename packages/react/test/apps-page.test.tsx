import { describe, expect, test } from "bun:test";
import type { AppPackageStatus } from "@opengeni/sdk";
import { renderToStaticMarkup } from "react-dom/server";

import { appPackageExtras } from "../src/app/routes/apps";

const status = (extra: Partial<AppPackageStatus> = {}): AppPackageStatus => ({
  appId: "app-1",
  title: "Work summary",
  packageId: "6f1d4c2a-8b3e-8d71-9a05-3c2e7b4f1a90",
  packageVersion: "1.0.0",
  archived: false,
  customized: false,
  skills: [{ id: "skill-1", name: "work-summary", modified: false }],
  automations: [],
  previous: null,
  update: null,
  ...extra,
});
const actions = { update: () => undefined, restore: () => undefined };
const badges = (entry: AppPackageStatus, withActions = true) =>
  renderToStaticMarkup(<>{appPackageExtras(entry, withActions ? actions : null)?.badges}</>);

describe("an installed app on the Apps page", () => {
  test("an app not installed from a package has no extras", () => {
    expect(appPackageExtras(undefined, actions)).toBeUndefined();
  });

  test("shows its version, and nothing else when unchanged and current", () => {
    const html = badges(status());
    expect(html).toContain("v1.0.0");
    expect(html).not.toContain("Customized");
    expect(html).not.toContain("Update available");
  });

  test("is Customized, with why it gets no updates, once changed here", () => {
    const html = badges(status({ customized: true }));
    expect(html).toContain("Customized");
    expect(html).toContain("Customized apps don&#x27;t get updates.");
  });

  test("offers an update only to people who can apply it", () => {
    const update = status({ update: { templateKey: "work-summary", packageVersion: "1.1.0" } });
    expect(badges(update)).toContain("Update available");
    expect(badges(update, false)).not.toContain("Update available");
  });
});
