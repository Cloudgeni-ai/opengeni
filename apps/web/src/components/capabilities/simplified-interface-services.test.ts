import { describe, expect, test } from "bun:test";

import { partitionSimplifiedInterfaceServices } from "./simplified-interface-services";

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("simplified interface apps", () => {
  test("puts mail, calendar, files, chat and payments first, in its own order", () => {
    const { apps, others } = partitionSimplifiedInterfaceServices(
      named(
        "PostHog",
        "Stripe",
        "Slack",
        "Microsoft Excel",
        "Linear",
        "Google Drive",
        "Outlook Mail",
        "Gmail",
        "Microsoft Teams",
        "Google Calendar",
      ),
    );
    expect(apps.map((service) => service.name)).toEqual([
      "Gmail",
      "Outlook Mail",
      "Google Calendar",
      "Google Drive",
      "Microsoft Excel",
      "Microsoft Teams",
      "Slack",
      "Stripe",
    ]);
    expect(others.map((service) => service.name)).toEqual(["PostHog", "Linear"]);
  });

  test("a similar name is not one of them", () => {
    const { apps, others } = partitionSimplifiedInterfaceServices(
      named("Slack Canvas Exporter", "Wordpress", "Stripe Atlas"),
    );
    expect(apps).toEqual([]);
    expect(others).toHaveLength(3);
  });
});
