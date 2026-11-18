import { describe, expect, test } from "bun:test";

import {
  DESKTOP_CONNECT_WATCH_MS,
  desktopConnectAlreadyFinished,
  finishedDesktopConnection,
  rememberDesktopConnectFinished,
  startDesktopConnectWatch,
} from "./desktop-connect-watch";

const gmail = (id: string, status: string) => ({
  id,
  providerDomain: "gmailmcp.googleapis.com",
  status,
  metadata: { mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1" },
});

function watching(connections = [gmail("old", "revoked")]) {
  return startDesktopConnectWatch({
    itemId: "mcp:gmail",
    providerDomain: "gmailmcp.googleapis.com",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    ownership: "personal",
    connections,
    now: 1_000,
  })!;
}

describe("the desktop app finishes a connection the browser signed in to", () => {
  test("a new active account for the provider is the finished sign-in", () => {
    const watch = watching();
    expect(watch.until).toBe(1_000 + DESKTOP_CONNECT_WATCH_MS);
    expect(finishedDesktopConnection(watch, [gmail("old", "revoked")])).toBe(null);
    expect(
      finishedDesktopConnection(watch, [gmail("old", "revoked"), gmail("new", "active")])?.id,
    ).toBe("new");
  });

  test("an account signed in again counts; one that was already working does not", () => {
    const watch = watching([gmail("lapsed", "needs_reauth"), gmail("fine", "active")]);
    expect(
      finishedDesktopConnection(watch, [gmail("lapsed", "needs_reauth"), gmail("fine", "active")]),
    ).toBe(null);
    expect(
      finishedDesktopConnection(watch, [gmail("lapsed", "active"), gmail("fine", "active")])?.id,
    ).toBe("lapsed");
  });

  test("another provider's new account is not this sign-in", () => {
    const calendar = { ...gmail("cal", "active"), providerDomain: "calendarmcp.googleapis.com" };
    expect(finishedDesktopConnection(watching(), [calendar])).toBe(null);
  });

  test("without a provider domain, the MCP address decides", () => {
    const watch = startDesktopConnectWatch({
      itemId: "mcp:custom",
      providerDomain: null,
      mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      ownership: "personal",
      connections: [],
    })!;
    expect(finishedDesktopConnection(watch, [gmail("new", "active")])?.id).toBe("new");
    expect(
      startDesktopConnectWatch({
        itemId: "x",
        providerDomain: null,
        mcpUrl: null,
        ownership: "personal",
        connections: [],
      }),
    ).toBe(null);
  });

  test("a connection finished by watching is not announced again by the hand-back link", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    } as unknown as Storage;
    expect(desktopConnectAlreadyFinished("c1", storage)).toBe(false);
    rememberDesktopConnectFinished("c1", storage);
    expect(desktopConnectAlreadyFinished("c1", storage)).toBe(true);
    expect(desktopConnectAlreadyFinished("c2", storage)).toBe(false);
  });
});
