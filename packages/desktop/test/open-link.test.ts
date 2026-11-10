import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appHandoffUrl, OPENGENI_WEB_PATHS } from "@opengeni/sdk/app-links";
import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);
const { DesktopShell } = await import("../src/main/app");
const { AccountStore } = await import("../src/main/accounts");

const plainStorage = {
  available: () => true,
  encrypt: (value: string) => Buffer.from(value),
  decrypt: (value: Buffer) => value.toString(),
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The real main-process handling of `opengeni://open` links, with the window left out. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "desktop-open-link-"));
  dirs.push(dir);
  const opened: string[] = [];
  electronStub.shell.openExternal = async (url: string) => {
    opened.push(url);
  };
  const store = new AccountStore(dir, plainStorage);
  const add = (subjectId: string, workspaceId: string) =>
    store.upsert(
      {
        baseUrl: "https://team.example",
        subjectId,
        email: `${subjectId}@example.com`,
        workspaceId,
      },
      "token",
    ).id;
  const first = add("one", "w1");
  const second = add("two", "w2");
  store.setActive(first);
  const shown: { accountId: string; path: string | undefined }[] = [];
  let revealed = 0;
  const shell = Object.create(DesktopShell.prototype) as any;
  Object.assign(shell, {
    config: { scheme: "opengeni", productName: "Test", defaultServerUrl: "https://team.example" },
    redirectUri: "opengeni://auth/callback",
    paths: OPENGENI_WEB_PATHS,
    store,
    pending: null,
    connectingFromLink: false,
    showAccount: (accountId: string, path?: string) => shown.push({ accountId, path }),
    reveal: () => (revealed += 1),
  });
  return { shell, opened, shown, first, second, revealed: () => revealed };
}

// What the browser's "Back to Opengeni" page hands the app once a connector
// sign-in started in the app has finished there.
const pluginsPage =
  "/workspaces/w2/plugins?connect_item=mcp%3Aintegrations%3Amail&integration_oauth=success&connectionId=c1&ownership=personal";

test("a finished sign-in returns to its page and outcome, on that workspace's account", () => {
  const { shell, shown, opened, second, revealed } = fixture();
  shell.handleUrl(appHandoffUrl(`https://team.example${pluginsPage}`));
  expect(shown).toEqual([{ accountId: second, path: pluginsPage }]);
  expect(opened).toEqual([]);
  expect(revealed()).toBe(0);
});

test("any page of the web app opens in the app", () => {
  const { shell, shown, first } = fixture();
  for (const path of ["/workspaces/w1/settings", "/workspaces/w1/organization?tab=billing"]) {
    shell.handleUrl(appHandoffUrl(`https://team.example${path}`));
  }
  shell.handleUrl(appHandoffUrl("https://team.example/integrations?status=connected"));
  expect(shown).toEqual([
    { accountId: first, path: "/workspaces/w1/settings" },
    { accountId: first, path: "/workspaces/w1/organization?tab=billing" },
    { accountId: first, path: "/integrations?status=connected" },
  ]);
});

test("sessions still open on their workspace's account", () => {
  const { shell, shown, second } = fixture();
  shell.handleUrl(appHandoffUrl("https://team.example/workspaces/w2/sessions/s1?at=4"));
  expect(shown).toEqual([{ accountId: second, path: "/workspaces/w2/sessions/s1?at=4" }]);
});

test("a page on a server without an account here opens in the browser", () => {
  const { shell, shown, opened } = fixture();
  const web = `https://other.example${pluginsPage}`;
  shell.handleUrl(appHandoffUrl(web));
  expect(shown).toEqual([]);
  expect(opened).toEqual([web]);
});

test("a link that is no web page just brings the app forward", () => {
  const { shell, shown, opened, revealed } = fixture();
  shell.handleUrl("opengeni://open?url=javascript%3Aalert(1)");
  expect(shown).toEqual([]);
  expect(opened).toEqual([]);
  expect(revealed()).toBe(1);
});
