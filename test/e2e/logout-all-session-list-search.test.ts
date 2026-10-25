import { expect, test } from "bun:test";
import { exactLogoutAllSessionListSearch } from "./logout-all-session-list-search";

test.each(["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"])(
  "logout-all fence rejects inherited extra query key %s",
  (key) => {
    for (const search of [
      "?view=page&limit=50&parentSessionId=null",
      "?view=page&limit=1&pinsOnly=true",
      "?view=page&limit=4&parentSessionId=null&projection=summary&sortBy=updatedAt&archiveStatus=active&includeTotals=true&includePinned=false",
      "?view=page&limit=4&parentSessionId=null&projection=summary&channelId=null&sortBy=updatedAt&archiveStatus=active&includePinned=false",
    ]) {
      expect(exactLogoutAllSessionListSearch(search)).toBe(true);
      const params = new URLSearchParams(search);
      params.append(key, "1");
      expect(exactLogoutAllSessionListSearch(`?${params}`)).toBe(false);
    }
  },
);

test("logout-all session-list fence admits only the finite legacy and current rail reads", () => {
  for (const search of [
    "",
    "?view=page&limit=50&parentSessionId=null",
    "?view=page&limit=50&parentSessionId=null&archivedOnly=true",
    "?view=page&limit=1&pinsOnly=true",
    "?pinsOnly=true&limit=1&view=page",
    "?view=page&limit=50&parentSessionId=null&sortBy=updatedAt&archiveStatus=active",
    "?archiveStatus=active&parentSessionId=null&sortBy=updatedAt&limit=50&view=page",
    // The rail's compact summary projection (#3184).
    "?view=page&limit=1&projection=summary&pinsOnly=true",
    "?view=page&limit=50&parentSessionId=null&projection=summary",
    "?view=page&limit=50&parentSessionId=null&sortBy=updatedAt&archiveStatus=active&projection=summary",
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
    "?view=page&limit=1&projection=full&pinsOnly=true",
    "?view=page&limit=1&projection=summary&projection=summary&pinsOnly=true",
    "?view=page&limit=1&projection=summary&pinsOnly=true&search=tenant",
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

test("logout-all fence admits the current project-grouped rail root page and Default window", () => {
  // The exact root page main CI saw fenced (project grouping is the default view).
  const rootPage =
    "?view=page&limit=4&parentSessionId=null&projection=summary&sortBy=updatedAt&archiveStatus=active&includeTotals=true&includePinned=false";
  const defaultWindow =
    "?view=page&limit=4&parentSessionId=null&projection=summary&channelId=null&sortBy=updatedAt&archiveStatus=active&includePinned=false";
  for (const search of [
    rootPage,
    rootPage.replace("limit=4", "limit=50"),
    rootPage.replace("&includeTotals=true", ""),
    rootPage.replace("&includePinned=false", ""),
    defaultWindow,
    defaultWindow.replace("limit=4", "limit=50"),
  ])
    expect(exactLogoutAllSessionListSearch(search)).toBe(true);

  for (const base of [rootPage, defaultWindow]) {
    for (const [key, value] of [
      ["limit", "25"],
      ["limit", "5"],
      ["projection", "full"],
      ["parentSessionId", "00000000-0000-4000-8000-000000000001"],
      ["sortBy", "name"],
      ["archiveStatus", "all"],
      ["includePinned", "true"],
    ] as const) {
      const params = new URLSearchParams(base);
      params.set(key, value);
      expect(exactLogoutAllSessionListSearch(`?${params}`)).toBe(false);
    }
    for (const [key, value] of [
      ["cursor", "opaque"],
      ["search", "tenant"],
      ["needsYouOnly", "true"],
      ["mineOnly", "true"],
      ["includePinned", "false"],
      ["unexpected", "1"],
    ] as const) {
      const params = new URLSearchParams(base);
      params.append(key, value);
      expect(exactLogoutAllSessionListSearch(`?${params}`)).toBe(false);
    }
  }
  // The current shapes always carry the summary projection.
  expect(exactLogoutAllSessionListSearch(rootPage.replace("&projection=summary", ""))).toBe(false);
  expect(
    exactLogoutAllSessionListSearch(rootPage.replace("includeTotals=true", "includeTotals=false")),
  ).toBe(false);
  // A named project window is not part of this flow.
  expect(
    exactLogoutAllSessionListSearch(
      defaultWindow.replace("channelId=null", "channelId=00000000-0000-4000-8000-000000000001"),
    ),
  ).toBe(false);
  expect(exactLogoutAllSessionListSearch(defaultWindow.replace("&includePinned=false", ""))).toBe(
    false,
  );
});

test("logout-all fence admits the current rail reads that carry Site conversations", () => {
  // The exact pin-section read main CI saw fenced (run 40161676403).
  const pinPage = "?view=page&limit=1&projection=summary&pinsOnly=true&siteConversations=include";
  const rootPage =
    "?view=page&limit=4&parentSessionId=null&projection=summary&sortBy=updatedAt&archiveStatus=active&includeTotals=true&includePinned=false&siteConversations=group";
  for (const search of [pinPage, rootPage, rootPage.replace("limit=4", "limit=50")])
    expect(exactLogoutAllSessionListSearch(search)).toBe(true);

  for (const search of [
    // Wrong value for the read, repeated key, or a pin read without the summary projection.
    pinPage.replace("siteConversations=include", "siteConversations=group"),
    `${pinPage}&siteConversations=include`,
    pinPage.replace("&projection=summary", ""),
    rootPage.replace("siteConversations=group", "siteConversations=include"),
    `${rootPage}&siteConversations=group`,
    // Search, archived and filtered reads stay user-driven and out of the fence.
    `${pinPage}&includeTotals=true`,
    `${pinPage}&search=tenant`,
    `${rootPage}&search=tenant`,
    rootPage.replace("archiveStatus=active", "archiveStatus=archived"),
    `${rootPage}&needsYouOnly=true`,
    // The Default project window does not carry Site conversations.
    "?view=page&limit=4&parentSessionId=null&projection=summary&channelId=null&sortBy=updatedAt&archiveStatus=active&includePinned=false&siteConversations=group",
  ])
    expect(exactLogoutAllSessionListSearch(search)).toBe(false);
});
