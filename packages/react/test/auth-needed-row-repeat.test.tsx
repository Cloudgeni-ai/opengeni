import { expect, test } from "bun:test";
import { AuthNeededRow } from "../src/components/auth-needed-row";
import type { AuthNeededItem } from "../src/timeline/types";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

const item = {
  kind: "auth-needed",
  id: "event-1",
  turnId: "turn-1",
  serverId: "opengeni",
  toolName: "capability_authorization_request",
  providerDomain: "opengeni.ai",
  reason: "missing_connection",
  occurredAt: "2026-01-01T00:00:00.000Z",
  capability: {
    id: "mcp:slack",
    name: "Slack",
    kind: "mcp",
    source: "library",
    action: "connect",
    rationale: "Read the report.",
    requiredVariables: [],
  },
} as unknown as AuthNeededItem;

test("a connection asked for again further down shows as one line", async () => {
  const repeated = await renderComponent(
    <AuthNeededRow item={{ ...item, askedAgainLater: true }} />,
  );
  expect(repeated.container.textContent).toBe(
    "The agent asked to connect Slack. It asked again below.",
  );
  expect(repeated.container.querySelector("button")).toBeNull();
  await repeated.unmount();

  const live = await renderComponent(<AuthNeededRow item={item} />);
  expect(live.container.textContent).not.toContain("It asked again below.");
  await live.unmount();
});
