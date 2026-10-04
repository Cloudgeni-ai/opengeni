import { describe, expect, test } from "bun:test";

import { continueAuthorizeUrl } from "@/routes/connect-agent";

import {
  developerSearch,
  isConnectedAgentsLocation,
  isDeveloperSubPage,
  isServiceAccountsLocation,
  parseAgentParam,
  parseDeveloperView,
  parseServiceAccountParam,
} from "./developer-route";

const agent = "3F0C8A52-1B4E-4C6D-9E2F-7A8B9C0D1E2F";

describe("Developer sub-pages for connected agents", () => {
  test("an agent's page and Connect an agent are their own sub-pages", () => {
    expect(parseDeveloperView("connect-agent")).toBe("connect-agent");
    expect(parseAgentParam(agent)).toBe(agent.toLowerCase());
    expect(parseAgentParam("not-an-id")).toBeUndefined();
    expect(developerSearch({ agent: agent.toLowerCase() })).toEqual({
      agent: agent.toLowerCase(),
    });
    expect(developerSearch({ view: "connect-agent", agent })).toEqual({ view: "connect-agent" });
    expect(isDeveloperSubPage({ agent })).toBe(true);
    expect(isConnectedAgentsLocation({ view: "connect-agent" })).toBe(true);
    expect(isConnectedAgentsLocation({ agent })).toBe(true);
    expect(isConnectedAgentsLocation({ view: "new-webhook" })).toBe(false);
  });
});

describe("Developer sub-pages for service accounts", () => {
  test("a service account's page and New service account are their own sub-pages", () => {
    expect(parseDeveloperView("new-service-account")).toBe("new-service-account");
    expect(parseServiceAccountParam(agent)).toBe(agent.toLowerCase());
    expect(parseServiceAccountParam("../x")).toBeUndefined();
    expect(developerSearch({ serviceAccount: agent })).toEqual({ serviceAccount: agent });
    expect(isDeveloperSubPage({ serviceAccount: agent })).toBe(true);
    expect(isServiceAccountsLocation({ view: "new-service-account" })).toBe(true);
    expect(isServiceAccountsLocation({ serviceAccount: agent })).toBe(true);
    expect(isServiceAccountsLocation({ agent })).toBe(false);
  });
});

describe("continuing an agent's sign-in", () => {
  const origin = "https://api.example.test";

  test("follows only the API's own authorize endpoint", () => {
    expect(continueAuthorizeUrl("/oauth/authorize?client_id=a&state=b", origin)).toBe(
      "https://api.example.test/oauth/authorize?client_id=a&state=b",
    );
    for (const authorize of [
      "https://evil.example/oauth/authorize?x=1",
      "//evil.example/oauth/authorize?x=1",
      "/oauth/authorize",
      "/oauth/token?x=1",
      "/\\evil.example/oauth/authorize?x=1",
    ]) {
      expect(continueAuthorizeUrl(authorize, origin)).toBeNull();
    }
  });
});
