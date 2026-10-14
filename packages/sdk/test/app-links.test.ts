import { describe, expect, test } from "bun:test";

import {
  accountForAppLink,
  appHandoffUrl,
  normalizeServerUrl,
  parseAppLink,
  serverLabel,
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
