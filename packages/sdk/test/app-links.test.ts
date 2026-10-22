import { describe, expect, test } from "bun:test";

import {
  accountForAppLink,
  appHandoffUrl,
  normalizeServerUrl,
  parseAppLink,
  serverLabel,
  computerConnectUrl,
  parseComputerConnectLink,
  OPENGENI_WEB_PATHS,
  sessionMoment,
  type AppWebPaths,
} from "../src/app-links";

describe("app links", () => {
  test("normalizes typed server addresses", () => {
    expect(normalizeServerUrl(" App.Example.com/ ")).toBe("https://app.example.com");
    expect(normalizeServerUrl("http://localhost:3000/x")).toBe("http://localhost:3000");
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("ftp://nope")).toBeNull();
    expect(serverLabel("https://app.example.com")).toBe("app.example.com");
  });

  test("reads session, workspace and bare session links", () => {
    expect(parseAppLink("https://app.example.com/workspaces/w1/sessions/s1?at=42")).toEqual({
      origin: "https://app.example.com",
      workspaceId: "w1",
      sessionId: "s1",
      at: 42,
      webUrl: "https://app.example.com/workspaces/w1/sessions/s1?at=42",
    });
    expect(parseAppLink("https://app.example.com/workspaces/w1")?.sessionId).toBeNull();
    expect(parseAppLink("https://app.example.com/sessions/s1")?.workspaceId).toBeNull();
    expect(parseAppLink("https://app.example.com/workspaces/w1/settings")).toBeNull();
  });

  test("unwraps the web's open-in-app handoff", () => {
    const web = "https://app.example.com/workspaces/w1/sessions/s1";
    expect(parseAppLink(appHandoffUrl(web))?.sessionId).toBe("s1");
    expect(parseAppLink(appHandoffUrl(web, "acme"), { scheme: "acme" })?.sessionId).toBe("s1");
    expect(parseAppLink(appHandoffUrl(web, "acme"))).toBeNull();
    expect(() => appHandoffUrl(web, "not a scheme")).toThrow();
  });

  test("reads a product's own web routes", () => {
    const paths: AppWebPaths = {
      home: (workspaceId) => `/app/${workspaceId}`,
      session: (workspaceId, sessionId, at) =>
        `/app/${workspaceId}/chat/${sessionId}${at ? `?at=${at}` : ""}`,
      inbox: (workspaceId) => `/app/${workspaceId}/inbox`,
      match(path, query) {
        const chat = /^\/app\/([\w-]+)\/chat\/([\w-]+)$/u.exec(path);
        if (chat) return { workspaceId: chat[1]!, sessionId: chat[2]!, at: sessionMoment(query) };
        const home = /^\/app\/([\w-]+)$/u.exec(path);
        return home ? { workspaceId: home[1]!, sessionId: null } : null;
      },
    };
    const web = `https://app.example.com${paths.session("w1", "s1", 7)}`;
    expect(parseAppLink(web, { paths })).toMatchObject({
      workspaceId: "w1",
      sessionId: "s1",
      at: 7,
    });
    expect(parseAppLink("https://app.example.com/app/w1", { paths })).toMatchObject({
      workspaceId: "w1",
      sessionId: null,
      at: null,
    });
    expect(parseAppLink("https://app.example.com/workspaces/w1/sessions/s1", { paths })).toBeNull();
    expect(parseAppLink(web)).toBeNull();
    const connect = computerConnectUrl({
      webUrl: "https://app.example.com/app/w1/chat/s1",
      subjectId: "user:one",
      scheme: "acme",
      paths,
    });
    expect(parseComputerConnectLink(connect, "acme", paths)).toMatchObject({
      workspaceId: "w1",
      sessionId: "s1",
    });
    expect(parseComputerConnectLink(connect, "acme")).toBeNull();
  });

  test("builds Opengeni's own web routes", () => {
    expect(OPENGENI_WEB_PATHS.session("w1", "s1", 42)).toBe("/workspaces/w1/sessions/s1?at=42");
    expect(OPENGENI_WEB_PATHS.session("w1", "s1")).toBe("/workspaces/w1/sessions/s1");
    expect(OPENGENI_WEB_PATHS.home("w1")).toBe("/workspaces/w1/sessions");
    expect(OPENGENI_WEB_PATHS.inbox("w1")).toBe("/workspaces/w1/inbox");
    expect(OPENGENI_WEB_PATHS.settings?.("w1")).toBe("/workspaces/w1/settings");
  });

  test("picks the account by server, then workspace, then the active one", () => {
    const accounts = [
      { id: "a", baseUrl: "https://app.example.com", workspaceId: "w1" },
      { id: "b", baseUrl: "https://app.example.com", workspaceId: "w2" },
      { id: "c", baseUrl: "https://other.example.com", workspaceId: "w2", signedOut: true },
    ];
    const link = (url: string) => parseAppLink(url)!;
    expect(
      accountForAppLink(link("https://app.example.com/workspaces/w2"), accounts, "a")?.id,
    ).toBe("b");
    expect(
      accountForAppLink(link("https://app.example.com/workspaces/w9"), accounts, "b")?.id,
    ).toBe("b");
    expect(accountForAppLink(link("https://other.example.com/workspaces/w2"), accounts, "a")).toBe(
      null,
    );
  });
});

describe("computer connection handoff", () => {
  const webUrl = "https://app.example.com/workspaces/w1/sessions/s1";
  test("keeps destination and exact account, including a product's own scheme", () => {
    const url = computerConnectUrl({ webUrl, subjectId: "user:one", scheme: "acme" });
    expect(parseComputerConnectLink(url, "acme")).toMatchObject({
      origin: "https://app.example.com",
      workspaceId: "w1",
      sessionId: "s1",
      subjectId: "user:one",
    });
    expect(parseComputerConnectLink(url)).toBeNull();
    expect(url).not.toContain("token");
  });
  test("rejects credentials, arbitrary paths, query payloads and non-web origins", () => {
    for (const destination of [
      "ftp://app.example.com/workspaces/w1",
      "https://u:p@app.example.com/workspaces/w1",
      "https://app.example.com/settings",
      `${webUrl}?command=anything`,
      `${webUrl}#token`,
      "javascript:alert(1)",
    ]) {
      expect(
        parseComputerConnectLink(
          `opengeni://connect?subject=u&url=${encodeURIComponent(destination)}`,
        ),
      ).toBeNull();
    }
    expect(
      parseComputerConnectLink(`opengeni://connect?url=${encodeURIComponent(webUrl)}`),
    ).toBeNull();
    expect(() => computerConnectUrl({ webUrl, subjectId: "", scheme: "acme" })).toThrow();
    expect(
      parseComputerConnectLink(
        computerConnectUrl({ webUrl: "http://localhost:3000/workspaces/w1", subjectId: "u" }),
      ),
    ).not.toBeNull();
  });
});
