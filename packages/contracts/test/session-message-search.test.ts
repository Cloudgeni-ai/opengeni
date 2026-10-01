import { expect, test } from "bun:test";
import { SessionMessageSearchRequest } from "../src/session-message-search";

test("message search preserves omitted, root-only and direct-child parent scopes", () => {
  const parentSessionId = "11111111-1111-4111-8111-111111111111";
  expect(SessionMessageSearchRequest.parse({ query: "needle" })).not.toHaveProperty(
    "parentSessionId",
  );
  for (const parent of [null, parentSessionId]) {
    for (const groupBy of [undefined, "session" as const]) {
      const request = { query: "needle", parentSessionId: parent, groupBy };
      expect(SessionMessageSearchRequest.parse(JSON.parse(JSON.stringify(request)))).toEqual(
        JSON.parse(JSON.stringify(request)),
      );
    }
  }
  // Parent and exact-session predicates may intersect; neither is authority.
  expect(
    SessionMessageSearchRequest.parse({
      query: "needle",
      sessionId: parentSessionId,
      parentSessionId: null,
    }).parentSessionId,
  ).toBeNull();
});

test("message search rejects malformed parent filters without coercing them to all", () => {
  for (const parentSessionId of ["", "null", "all", "not-a-uuid", 1, false, []]) {
    expect(
      SessionMessageSearchRequest.safeParse({ query: "needle", parentSessionId }).success,
    ).toBe(false);
  }
});
