import { expect, test } from "bun:test";
import type { AuthNeededItem } from "@opengeni/react/session";
import type { CapabilityCatalogItem } from "@/types";
import { sessionAuthRecommendation } from "./session-auth-recommendation";
const event = {
  serverId: "example",
  connectionId: "connection",
  authoritySource: null,
  reason: "token_expired",
} as unknown as AuthNeededItem;
const item = {
  id: "catalog-example",
  name: "Example",
  kind: "mcp",
  source: "manual",
  runtime: { mcpServerId: "example" },
  connectionRef: { connectionId: "connection" },
} as CapabilityCatalogItem;
test("reconnect resolves the exact runtime integration", () => {
  expect(sessionAuthRecommendation(event, [item])?.capability?.id).toBe("catalog-example");
});
test("host-managed and unavailable authority never use stock connection controls", () => {
  expect(sessionAuthRecommendation({ ...event, authoritySource: "host" }, [item])).toBeUndefined();
  expect(
    sessionAuthRecommendation({ ...event, reason: "personal_authority_unavailable" }, [item]),
  ).toBeUndefined();
});
test("ambiguous accounts are not guessed by provider domain", () => {
  expect(sessionAuthRecommendation(event, [item, { ...item, id: "other" }])).toBeUndefined();
});
