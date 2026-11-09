import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CapabilityCatalogStatus } from "../src/capability-catalog-row";
import {
  attentionFirst,
  ConnectionCatalog,
  type ConnectionCatalogService,
} from "../src/connection-catalog";

function service(
  name: string,
  state: CapabilityCatalogStatus,
  connected = true,
): ConnectionCatalogService {
  return {
    id: name.toLowerCase(),
    name,
    options: [
      {
        id: name.toLowerCase(),
        name,
        status: state === "attention" ? "Needs attention" : "Connected",
        state,
        connected,
        onOpen: () => {},
      },
    ],
  };
}

const names = (html: string) => [...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]);

test("a connection needing attention past the preview limit leads the preview", () => {
  const services = [
    service("Slack", "added"),
    service("GitHub", "added"),
    service("PostHog", "added"),
    service("Gmail", "added"),
    service("Google Calendar", "added"),
    service("Jira & Confluence", "added"),
    service("Notion", "attention"),
    service("Linear", "added"),
  ];
  const html = renderToStaticMarkup(
    <ConnectionCatalog grouped={false} columns={2} resultLimit={6} services={services} />,
  );
  expect(names(html)).toEqual(["Notion", "Slack", "GitHub", "PostHog", "Gmail", "Google Calendar"]);
  expect(html).toContain("View all connections");
});

test("attention first keeps every other connection in its given order", () => {
  const ordered = attentionFirst([
    service("Slack", "added"),
    service("GitHub", "attention"),
    service("Mail", "available", false),
    // Merely unavailable to add here is not a problem with your connection.
    service("Drive", "unavailable", false),
    // A connection you have that became unavailable is.
    service("Calendar", "unavailable", true),
    service("Notion", "attention"),
  ]);
  expect(ordered.map((entry) => entry.name)).toEqual([
    "GitHub",
    "Calendar",
    "Notion",
    "Slack",
    "Mail",
    "Drive",
  ]);
});
