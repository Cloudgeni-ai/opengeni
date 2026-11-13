import { describe, expect, test } from "bun:test";

import {
  consoleHostRedirectPath,
  isConsoleHostname,
  parseConsoleMembersSearch,
  parseConsoleSearch,
  parseConsoleSessionsSearch,
  parseConsoleUsageSearch,
} from "./console-route";

const org = "11111111-1111-4111-8111-111111111111";

describe("isConsoleHostname", () => {
  test("matches console as the first or second label", () => {
    expect(isConsoleHostname("console.opengeni.ai")).toBe(true);
    expect(isConsoleHostname("staging.console.opengeni.ai")).toBe(true);
    expect(isConsoleHostname("Console.opengeni.ai.")).toBe(true);
    expect(isConsoleHostname("console.localhost")).toBe(true);
  });

  test("leaves other hosts alone", () => {
    expect(isConsoleHostname("app.opengeni.ai")).toBe(false);
    expect(isConsoleHostname("staging.app.opengeni.ai")).toBe(false);
    expect(isConsoleHostname("consolex.opengeni.ai")).toBe(false);
    expect(isConsoleHostname("myconsole.opengeni.ai")).toBe(false);
    expect(isConsoleHostname("a.b.console.opengeni.ai")).toBe(false);
    expect(isConsoleHostname("console")).toBe(false);
    expect(isConsoleHostname("localhost")).toBe(false);
  });
});

describe("consoleHostRedirectPath", () => {
  test("leaves the app host alone", () => {
    expect(consoleHostRedirectPath("app.opengeni.ai", "/")).toBeNull();
    expect(consoleHostRedirectPath("app.opengeni.ai", "/sessions")).toBeNull();
    expect(consoleHostRedirectPath("consolex.opengeni.ai", "/")).toBeNull();
  });

  test("sends the Console host's pages to /console", () => {
    expect(consoleHostRedirectPath("console.opengeni.ai", "/")).toBe("/console");
    expect(consoleHostRedirectPath("console.opengeni.ai", "/", `?org=${org}`)).toBe(
      `/console?org=${org}`,
    );
    expect(consoleHostRedirectPath("Console.opengeni.ai", "/sessions")).toBe("/console/sessions");
    expect(consoleHostRedirectPath("staging.console.opengeni.ai", "/api-keys/new")).toBe(
      "/console/api-keys/new",
    );
    expect(consoleHostRedirectPath("console.opengeni.ai", "/console")).toBeNull();
    expect(consoleHostRedirectPath("console.opengeni.ai", "/console/api-keys")).toBeNull();
  });

  test("never opens the app's workspaces or chats", () => {
    expect(consoleHostRedirectPath("console.opengeni.ai", `/workspaces/${org}/sessions`)).toBe(
      "/console",
    );
    expect(consoleHostRedirectPath("console.opengeni.ai", `/sessions/${org}`)).toBe("/console");
    expect(consoleHostRedirectPath("console.opengeni.ai", "/anything/else")).toBe("/console");
  });

  test("opens organization settings sections as Console pages", () => {
    const page = `/workspaces/${org}/organization`;
    expect(consoleHostRedirectPath("console.opengeni.ai", page, "?section=people")).toBe(
      "/console/members",
    );
    expect(
      consoleHostRedirectPath(
        "console.opengeni.ai",
        page,
        "?section=billing&checkout=success&checkoutSession=cs_1",
      ),
    ).toBe("/console/usage?checkout=success&checkoutSession=cs_1");
    expect(
      consoleHostRedirectPath("console.opengeni.ai", page, "?section=people&person=m1&tab=x"),
    ).toBe("/console/members?person=m1");
    expect(
      consoleHostRedirectPath("console.opengeni.ai", page, `?section=billing&workspace=${org}`),
    ).toBe(`/console/usage?workspace=${org}`);
    expect(consoleHostRedirectPath("console.opengeni.ai", page, "?section=models")).toBe(
      "/console",
    );
  });

  test("keeps sign-in and public pages on their own path", () => {
    expect(consoleHostRedirectPath("console.opengeni.ai", "/account-auth")).toBeNull();
    expect(consoleHostRedirectPath("console.opengeni.ai", "/reset-password")).toBeNull();
    expect(consoleHostRedirectPath("console.opengeni.ai", "/setup-account")).toBeNull();
    expect(consoleHostRedirectPath("console.opengeni.ai", "/share/abc")).toBeNull();
  });
});

describe("Console search", () => {
  test("accepts only organization and workspace ids", () => {
    expect(parseConsoleSearch({ org })).toEqual({ org });
    expect(parseConsoleSearch({ org: "acme" })).toEqual({});
    expect(parseConsoleSessionsSearch({ workspace: org })).toEqual({ workspace: org });
    expect(parseConsoleSessionsSearch({ workspace: 3 })).toEqual({});
    expect(parseConsoleMembersSearch({ person: "m1", view: "invite" })).toEqual({ person: "m1" });
    expect(parseConsoleMembersSearch({ view: "invite" })).toEqual({ view: "invite" });
    expect(parseConsoleUsageSearch({ workspace: "x", checkout: "success" })).toEqual({
      checkout: "success",
    });
  });
});
