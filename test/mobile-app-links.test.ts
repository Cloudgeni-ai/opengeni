import { describe, expect, test } from "bun:test";
import type { StoredAccount } from "../apps/mobile/src/account-store";
import {
  accountForAppLink,
  appHandoffUrl,
  appSessionPath,
  parseAppLink,
} from "../apps/mobile/src/app-links";

const WS = "3f1d0000-0000-4000-8000-000000000001";
const SID = "93e00000-0000-4000-8000-000000000002";
const BASE = "https://app.example.com";

function account(id: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id,
    baseUrl: BASE,
    subjectId: `user:${id}`,
    email: `${id}@x`,
    workspaceId: null,
    ...extra,
  };
}

describe("parseAppLink", () => {
  test("a session link opens the session in its workspace", () => {
    expect(parseAppLink(`${BASE}/workspaces/${WS}/sessions/${SID}`)).toEqual({
      origin: BASE,
      workspaceId: WS,
      sessionId: SID,
      at: null,
      webUrl: `${BASE}/workspaces/${WS}/sessions/${SID}`,
    });
  });

  test("keeps the session moment and ignores other query and hash", () => {
    const link = parseAppLink(`${BASE}/workspaces/${WS}/sessions/${SID}/?find=x&at=42#top`);
    expect(link?.sessionId).toBe(SID);
    expect(link?.at).toBe(42);
  });

  test("a workspace link, with or without its session list", () => {
    for (const path of [`/workspaces/${WS}`, `/workspaces/${WS}/`, `/workspaces/${WS}/sessions`]) {
      expect(parseAppLink(`${BASE}${path}`)).toMatchObject({ workspaceId: WS, sessionId: null });
    }
  });

  test("the web's workspace-less session link", () => {
    expect(parseAppLink(`${BASE}/sessions/${SID}`)).toMatchObject({
      workspaceId: null,
      sessionId: SID,
    });
  });

  test("pages the app does not have stay on the web", () => {
    for (const path of [
      "/",
      "/settings/security",
      `/workspaces/${WS}/settings`,
      `/workspaces/${WS}/organization`,
      `/workspaces/${WS}/artifacts/abc`,
      `/workspaces/${WS}/sessions/${SID}/extra`,
    ]) {
      expect(parseAppLink(`${BASE}${path}`)).toBeNull();
    }
    expect(parseAppLink("mailto:someone@example.com")).toBeNull();
    expect(parseAppLink("not a url")).toBeNull();
  });

  test("the origin matches stored accounts: case, scheme and port kept", () => {
    expect(parseAppLink(`HTTPS://App.Example.com/workspaces/${WS}`)?.origin).toBe(BASE);
    expect(parseAppLink(`http://box.local:8080/workspaces/${WS}`)?.origin).toBe(
      "http://box.local:8080",
    );
  });

  test("unwraps the web's Open in app handoff", () => {
    const web = `${BASE}/workspaces/${WS}/sessions/${SID}?at=7`;
    const handoff = appHandoffUrl(web);
    expect(handoff.startsWith("opengeni://open?url=")).toBe(true);
    expect(parseAppLink(handoff)).toMatchObject({ sessionId: SID, at: 7, webUrl: web });
    expect(parseAppLink("opengeni://open?url=%E0%A4%A")).toBeNull();
    expect(parseAppLink("opengeni://open?other=1")).toBeNull();
  });
});

describe("accountForAppLink", () => {
  const link = parseAppLink(`${BASE}/workspaces/${WS}/sessions/${SID}`)!;

  test("no account on that deployment means the browser", () => {
    expect(
      accountForAppLink(link, [account("a", { baseUrl: "https://other.dev" })], "a"),
    ).toBeNull();
  });

  test("a signed-out account does not take links", () => {
    expect(accountForAppLink(link, [account("a", { signedOut: true })], "a")).toBeNull();
  });

  test("prefers the account last used in that workspace, then the active one", () => {
    const accounts = [account("a"), account("b", { workspaceId: WS }), account("c")];
    expect(accountForAppLink(link, accounts, "c")?.id).toBe("b");
    expect(accountForAppLink(link, [account("a"), account("c")], "c")?.id).toBe("c");
    expect(accountForAppLink(link, [account("a"), account("c")], null)?.id).toBe("a");
  });
});

test("appSessionPath carries the workspace and moment", () => {
  expect(appSessionPath(SID, WS, 9)).toBe(`/session/${SID}?workspace=${WS}&at=9`);
  expect(appSessionPath(SID, WS, null)).toBe(`/session/${SID}?workspace=${WS}`);
});
