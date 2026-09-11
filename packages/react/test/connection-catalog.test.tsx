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
