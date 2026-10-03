import { expect, test } from "bun:test";
import { exactLogoutAllSessionListSearch } from "./logout-all-session-list-search";

test("logout-all session-list fence admits only the finite legacy and current rail reads", () => {
  for (const search of [
    "",
    "?view=page&limit=50&parentSessionId=null",
    "?view=page&limit=50&parentSessionId=null&archivedOnly=true",
    "?view=page&limit=1&pinsOnly=true",
    "?pinsOnly=true&limit=1&view=page",
    "?view=page&limit=50&parentSessionId=null&sortBy=updatedAt&archiveStatus=active",
    "?archiveStatus=active&parentSessionId=null&sortBy=updatedAt&limit=50&view=page",
  ])
    expect(exactLogoutAllSessionListSearch(search)).toBe(true);

  for (const search of [
    "?view=page",
    "?view=page&limit=25&parentSessionId=null",
    "?view=page&limit=50&parentSessionId=null&archivedOnly=false",
    "?view=page&limit=50&parentSessionId=null&cursor=opaque",
    "?view=page&limit=50&parentSessionId=null&search=tenant",
    "?view=page&view=page&limit=50&parentSessionId=null",
    "?view=page&limit=50&parentSessionId=null&sortBy=name&archiveStatus=active",
    "?view=page&limit=50&parentSessionId=null&sortBy=updatedAt&archiveStatus=all",
    "?view=page&limit=50&parentSessionId=null&sortBy=updatedAt&archiveStatus=archived",
    "?view=page&limit=50&parentSessionId=null&sortBy=updatedAt&archiveStatus=active&cursor=opaque",
    "?view=page&limit=50&parentSessionId=null&sortBy=updatedAt&archiveStatus=active&sortBy=updatedAt",
    "?view=page&limit=50&parentSessionId=null&sortBy=updatedAt",
    "?view=page&limit=1&pinsOnly=true&archiveStatus=active",
  ])
    expect(exactLogoutAllSessionListSearch(search)).toBe(false);
});

test("logout-all default-channel fence admits only the exact current finite read", () => {
  const search =
    "?view=page&limit=50&parentSessionId=null&channelId=null&sortBy=updatedAt&archiveStatus=active";
  expect(exactLogoutAllSessionListSearch(search)).toBe(true);
  expect(
    exactLogoutAllSessionListSearch(
      "?channelId=null&archiveStatus=active&sortBy=updatedAt&parentSessionId=null&limit=50&view=page",
    ),
  ).toBe(true);

  for (const [key, value] of [
    ["channelId", "00000000-0000-4000-8000-000000000001"],
    ["channelId", ""],
    ["limit", "25"],
    ["parentSessionId", "00000000-0000-4000-8000-000000000001"],
    ["sortBy", "name"],
    ["archiveStatus", "all"],
    ["archiveStatus", "archived"],
    ["view", "list"],
  ] as const) {
    const params = new URLSearchParams(search);
    params.set(key, value);
    expect(exactLogoutAllSessionListSearch(`?${params}`)).toBe(false);
  }
  for (const [key, value] of [
    ["channelId", "null"],
    ["sortBy", "updatedAt"],
    ["cursor", "opaque"],
    ["search", "tenant"],
    ["unexpected", "1"],
  ] as const) {
    const params = new URLSearchParams(search);
    params.append(key, value);
    expect(exactLogoutAllSessionListSearch(`?${params}`)).toBe(false);
  }
});
