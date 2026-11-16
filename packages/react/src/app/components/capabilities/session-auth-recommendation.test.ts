import { t } from "../../lib/console-text";
import { expect, test } from "bun:test";
import type { AuthNeededItem } from "../../../session";
import type { CapabilityCatalogItem } from "../../types";
import { sessionAuthRecommendation } from "../../../session-auth-recommendation";
import { authNeededPresentation } from "../../../auth-needed-presentation";
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
  expect(sessionAuthRecommendation(t, event, [item])?.capability?.id).toBe("catalog-example");
});
test("host-managed and unavailable authority never use stock connection controls", () => {
  expect(
    sessionAuthRecommendation(t, { ...event, authoritySource: "host" }, [item]),
  ).toBeUndefined();
  expect(
    sessionAuthRecommendation(t, { ...event, reason: "personal_authority_unavailable" }, [item]),
  ).toBeUndefined();
});
test("ambiguous accounts are not guessed by provider domain", () => {
  expect(sessionAuthRecommendation(t, event, [item, { ...item, id: "other" }])).toBeUndefined();
});

test("missing personal access opens the exact integration's consent flow without suggesting reconnect", () => {
  const personal = {
    ...item,
    connectionRef: {
      subjectScope: "subject",
      kind: "oauth2",
      providerDomain: "gmailmcp.googleapis.com",
    },
  } as CapabilityCatalogItem;
  const missingGrant = {
    ...event,
    connectionId: null,
    reason: "personal_authority_unavailable",
  } as AuthNeededItem;
  const recommendation = sessionAuthRecommendation(t, missingGrant, [personal]);
  expect(recommendation?.capability).toMatchObject({
    id: personal.id,
    action: "connect",
    rationale: "Review permission to use your personal account in this conversation.",
  });
  expect(
    sessionAuthRecommendation(t, missingGrant, [personal, { ...personal, id: "other" }]),
  ).toBeUndefined();
  expect(
    sessionAuthRecommendation(t, { ...missingGrant, serverId: "other" }, [personal]),
  ).toBeUndefined();
  expect(
    sessionAuthRecommendation(t, missingGrant, [
      { ...personal, connectionRef: { ...personal.connectionRef!, authoritySource: "host" } },
    ]),
  ).toBeUndefined();
});

test("an account that needs more access keeps the notice's own step-up for that account", () => {
  const moreAccess = {
    ...event,
    reason: "insufficient_scope",
    providerDomain: "gmailmcp.googleapis.com",
    scopes: ["https://www.googleapis.com/auth/gmail.compose"],
  } as unknown as AuthNeededItem;
  // No connect card that would read as already connected.
  expect(sessionAuthRecommendation(t, moreAccess, [item])).toBeUndefined();
  const presented = authNeededPresentation(t, moreAccess);
  expect(presented.title).toBe("Give Gmail more access");
  expect(presented.actionLabel).toBe("Allow");
  expect(presented.canRecover).toBe(true);
  // Without an exact account there is nothing to step up: the catalog card stays.
  expect(
    sessionAuthRecommendation(t, { ...moreAccess, connectionId: null } as AuthNeededItem, [item])
      ?.capability?.id,
  ).toBe("catalog-example");
});
