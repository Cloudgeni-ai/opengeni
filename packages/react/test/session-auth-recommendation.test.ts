import { expect, test } from "bun:test";
import type { CapabilityCatalogItem, SessionEvent } from "@opengeni/sdk";
import { CapabilityCatalogItem as CapabilitySchema } from "@opengeni/contracts";
import { buildTimeline } from "../src/timeline/projection";
import { sessionAuthRecommendation } from "../src/session-auth-recommendation";

test("personal alias recovery uses explicit canonical identity with hidden connection ids", () => {
  const [item] = buildTimeline([
    {
      id: "event",
      workspaceId: "workspace",
      sessionId: "session",
      sequence: 1,
      type: "tool.auth_needed",
      occurredAt: "2026-09-20T00:00:00Z",
      turnId: "turn",
      payload: {
        serverId: `account-${"a".repeat(64)}`,
        canonicalServerId: "mail",
        connectionSubjectScope: "subject",
        toolName: "send",
        providerDomain: "example.test",
        reason: "personal_authority_unavailable",
      },
    } as SessionEvent,
  ]);
  if (item?.kind !== "auth-needed") throw new Error("auth event not projected");
  const catalog: CapabilityCatalogItem[] = [
    CapabilitySchema.parse({
      id: "mail-capability",
      name: "Mail",
      kind: "mcp",
      source: "manual",
      runtime: { mcpServerId: "mail", available: true },
      connectionRef: { subjectScope: "workspace", providerDomain: "example.test", kind: "oauth2" },
    }),
  ];
  expect(item.serverId).toBe(`account-${"a".repeat(64)}`);
  expect(item.canonicalServerId).toBe("mail");
  expect(item.connectionId).toBeNull();
  expect(item.connectionSubjectScope).toBe("subject");
  expect(sessionAuthRecommendation(item, catalog)?.capability?.id).toBe("mail-capability");
  expect(
    sessionAuthRecommendation({ ...item, connectionSubjectScope: null }, catalog),
  ).toBeUndefined();
  expect(
    sessionAuthRecommendation({ ...item, connectionSubjectScope: "workspace" }, catalog),
  ).toBeUndefined();
  expect(
    sessionAuthRecommendation(
      {
        ...item,
        serverId: `account-${"b".repeat(64)}`,
        connectionSubjectScope: "workspace",
        reason: "expired",
      },
      catalog,
    )?.capability?.id,
  ).toBe("mail-capability");
  expect(sessionAuthRecommendation({ ...item, canonicalServerId: null }, catalog)).toBeUndefined();
  expect(
    sessionAuthRecommendation({ ...item, canonicalServerId: "other" }, catalog),
  ).toBeUndefined();
  expect(sessionAuthRecommendation({ ...item, authoritySource: "host" }, catalog)).toBeUndefined();
  expect(
    sessionAuthRecommendation(item, [...catalog, { ...catalog[0]!, id: "ambiguous" }]),
  ).toBeUndefined();
});
