import { describe, expect, test } from "bun:test";

import {
  accountForAppLink,
  appHandoffUrl,
  normalizeServerUrl,
  parseAppLink,
  serverLabel,
  computerConnectUrl,
  parseComputerConnectLink,
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
