import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionCatalog, ConnectionServiceRow } from "../src/connection-catalog";
const service = {
  id: "slack",
  name: "Slack",
  options: [
    {
      id: "bot",
      name: "Chat",
      description: "Conversations",
      status: "Connected",
      connected: true,
      state: "added" as const,
      onOpen: () => {},
    },
    {
      id: "tools",
      name: "Agent tools",
      description: "Search messages",
      status: "Not connected",
      connected: false,
      state: "available" as const,
      onOpen: () => {},
    },
  ],
};
test("service summarizes partial setup while retaining each option status", () => {
  const html = renderToStaticMarkup(<ConnectionServiceRow service={service} />);
  expect(html).toContain("1 of 2 added");
  expect(html).toContain('class="og-capability-catalog-sr-only"');
  expect(html).toContain("Not connected");
  expect(html).toContain("<details");
});
test("catalogue searches option descriptions and handles no matches", () => {
  expect(
    renderToStaticMarkup(<ConnectionCatalog services={[service]} query="messages" />),
  ).toContain("Slack");
  expect(
    renderToStaticMarkup(<ConnectionCatalog services={[service]} query="unknown" />),
  ).toContain("No connections match");
});

test("each row has one button with a decorative plus or check, never a second action", () => {
  for (const option of service.options) {
    const html = renderToStaticMarkup(
      <ConnectionServiceRow service={{ ...service, options: [option] }} />,
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("og-connection-details-action");
    expect(html).toContain(option.connected ? "lucide-check" : "lucide-plus");
    expect(html).not.toContain("›");
  }
  const grouped = renderToStaticMarkup(<ConnectionServiceRow service={service} />);
  expect(grouped.match(/<button/g)).toHaveLength(2);
});

test("a distinct host-supplied action remains a sibling of the details button", () => {
  const html = renderToStaticMarkup(
    <ConnectionServiceRow
      service={{
        ...service,
        options: [{ ...service.options[0]!, action: <button>Connect now</button> }],
      }}
    />,
  );
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).toContain("</button><button>Connect now</button>");
});

test("explicit health overrides connected state and remains visible in a service group", () => {
  const html = renderToStaticMarkup(
    <ConnectionServiceRow
      service={{
        ...service,
        options: [
          service.options[0]!,
          {
            ...service.options[1]!,
            connected: true,
            state: "attention",
            status: "Reconnect required",
          },
        ],
      }}
    />,
  );
  expect(html.match(/data-status="attention"/g)).toHaveLength(2);
  expect(html.match(/og-capability-catalog-notice/g)).toHaveLength(2);
  expect(html).toContain("Reconnect required");
});

test("legacy callers without typed health retain their visible host status", () => {
  const { state: _state, ...legacy } = service.options[0]!;
  const html = renderToStaticMarkup(
    <ConnectionServiceRow
      service={{ ...service, options: [{ ...legacy, status: "Reconnect required" }] }}
    />,
  );
  expect(html).toContain('class="og-capability-catalog-notice">Reconnect required');
  expect(html).not.toContain('class="og-capability-catalog-sr-only"');
});

test("flat services expose each connection directly without a disclosure", () => {
  const html = renderToStaticMarkup(<ConnectionCatalog services={[service]} grouped={false} />);
  expect(html).not.toContain("<details");
  expect(html).not.toContain("<summary");
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).toContain("Slack · Chat");
  expect(html).toContain("Slack · Agent tools");
  expect(html).toContain('data-status="added"');
  expect(html).toContain('data-status="available"');
});

test("overview filters before limiting individual connection rows", () => {
  const services = Array.from({ length: 12 }, (_, i) => ({
    ...service,
    id: String(i),
    name: i < 4 ? "Other" : `Match ${i}`,
    options: [{ ...service.options[0]!, id: String(i) }],
  }));
  const html = renderToStaticMarkup(
    <ConnectionCatalog
      services={services}
      grouped={false}
      query="Match"
      resultLimit={6}
      onShowMore={() => {}}
    />,
  );
  expect(html.match(/class="og-connection-catalog-action-row"/g)).toHaveLength(6);
  expect(html).toContain("Match 4");
  expect(html).not.toContain("Match 10");
  expect(html).toContain("View all connections");
  const empty = renderToStaticMarkup(
    <ConnectionCatalog
      services={services}
      grouped={false}
      query="absent"
      resultLimit={6}
      onShowMore={() => {}}
    />,
  );
  expect(empty).not.toContain("View all connections");
});
