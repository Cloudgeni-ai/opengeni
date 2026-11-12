import { describe, expect, test } from "bun:test";

import {
  consoleHostRedirectPath,
  parseConsoleSearch,
  parseConsoleSessionsSearch,
} from "./console-route";

const org = "11111111-1111-4111-8111-111111111111";

describe("consoleHostRedirectPath", () => {
  test("leaves the app host alone", () => {
    expect(consoleHostRedirectPath("app.opengeni.ai", "/")).toBeNull();
    expect(consoleHostRedirectPath("app.opengeni.ai", "/sessions")).toBeNull();
  });

  test("sends the Console host's pages to /console", () => {
    expect(consoleHostRedirectPath("console.opengeni.ai", "/")).toBe("/console");
    expect(consoleHostRedirectPath("Console.opengeni.ai", "/sessions")).toBe("/console/sessions");
    expect(consoleHostRedirectPath("console.opengeni.ai", "/console")).toBeNull();
    expect(consoleHostRedirectPath("console.opengeni.ai", "/console/api-keys")).toBeNull();
  });

  test("keeps sign-in and public pages on their own path", () => {
    expect(consoleHostRedirectPath("console.opengeni.ai", "/account-auth")).toBeNull();
    expect(consoleHostRedirectPath("console.opengeni.ai", "/reset-password")).toBeNull();
    expect(consoleHostRedirectPath("console.opengeni.ai", "/share/abc")).toBeNull();
  });
});

describe("Console search", () => {
  test("accepts only organization and workspace ids", () => {
    expect(parseConsoleSearch({ org })).toEqual({ org });
    expect(parseConsoleSearch({ org: "acme" })).toEqual({});
    expect(parseConsoleSessionsSearch({ workspace: org })).toEqual({ workspace: org });
    expect(parseConsoleSessionsSearch({ workspace: 3 })).toEqual({});
  });
});
