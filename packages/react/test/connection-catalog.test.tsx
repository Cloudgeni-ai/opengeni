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
      onOpen: () => {},
    },
    {
      id: "tools",
      name: "Agent tools",
      description: "Search messages",
      status: "Not connected",
      connected: false,
      onOpen: () => {},
    },
  ],
};
test("service summarizes partial setup while retaining each option status", () => {
  const html = renderToStaticMarkup(<ConnectionServiceRow service={service} />);
  expect(html).toContain("1 of 2 connected");
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

test("each default detail row has one button and no misleading plus action", () => {
  for (const option of service.options) {
    const html = renderToStaticMarkup(
      <ConnectionServiceRow service={{ ...service, options: [option] }} />,
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("og-connection-details-action");
    expect(html).toContain("›");
    expect(html).not.toContain(">+</span>");
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
