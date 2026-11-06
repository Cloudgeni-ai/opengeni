import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerConnectUrl, OPENGENI_WEB_PATHS } from "@opengeni/sdk/app-links";
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

/** The real main-process link handling, with the window, inbox and computer left out. */
function fixture(options: { answer?: number; installedFrom?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-link-"));
  dirs.push(dir);
  const opened: string[] = [];
  const dialogs: { message: string; buttons: string[]; defaultId: number; cancelId: number }[] = [];
  electronStub.shell.openExternal = async (url: string) => {
    opened.push(url);
  };
  electronStub.dialog.showMessageBox = (async (box: (typeof dialogs)[number]) => {
    dialogs.push(box);
    return { response: options.answer ?? 0 };
  }) as typeof electronStub.dialog.showMessageBox;
  const store = new AccountStore(dir, plainStorage);
  const shell = Object.create(DesktopShell.prototype) as any;
  Object.assign(shell, {
    config: {
      scheme: "opengeni",
      productName: "Test",
      thisComputer: true,
      defaultServerUrl: "https://app.example",
    },
    redirectUri: "opengeni://auth/callback",
    paths: OPENGENI_WEB_PATHS,
    installedFrom: options.installedFrom ?? "",
    store,
    pending: null,
    connectingFromLink: false,
    welcomeError: null,
    window: { reveal() {}, welcomeContents: () => null },
  });
  const connected: string[] = [];
  shell.connectFromLink = async (account: { baseUrl: string }) => {
    connected.push(account.baseUrl);
  };
  /** Lets the handler's dialog and sign-in steps run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { shell, store, opened, dialogs, connected, settle };
}

const linkTo = (origin: string, subjectId = "person") =>
  computerConnectUrl({ webUrl: `${origin}/workspaces/w1/sessions/s1`, subjectId });

test("a link to a server the app has not used asks first and cancels by default", async () => {
  const { shell, opened, dialogs, settle } = fixture();
  shell.handleUrl(linkTo("https://unknown.example"));
  await settle();
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]!.message).toBe("Sign in to unknown.example?");
  expect(dialogs[0]!.buttons[dialogs[0]!.defaultId]).toBe("Cancel");
  expect(dialogs[0]!.buttons[dialogs[0]!.cancelId]).toBe("Cancel");
  expect(opened).toEqual([]);
  expect(shell.pending).toBeNull();
  expect(shell.connectingFromLink).toBe(false);
});

test("approving the new server starts sign-in on it", async () => {
  const { shell, opened, dialogs, settle } = fixture({ answer: 1 });
  shell.handleUrl(linkTo("https://unknown.example"));
  await settle();
  expect(dialogs).toHaveLength(1);
  expect(opened).toHaveLength(1);
  expect(new URL(opened[0]!).origin).toBe("https://unknown.example");
  expect(shell.pending.baseUrl).toBe("https://unknown.example");
  expect(shell.pending.computerLink.subjectId).toBe("person");
});

test("a second link while the question is open is ignored", async () => {
  const { shell, dialogs, settle } = fixture();
  shell.handleUrl(linkTo("https://unknown.example"));
  shell.handleUrl(linkTo("https://other.example"));
  await settle();
  expect(dialogs).toHaveLength(1);
});

test("the app's own and installed-from servers sign in without a question", async () => {
  for (const origin of ["https://app.example", "https://installed.example"]) {
    const { shell, opened, dialogs, settle } = fixture({
      installedFrom: "https://installed.example",
    });
    shell.handleUrl(linkTo(origin));
    await settle();
    expect(dialogs).toEqual([]);
    expect(opened.map((url) => new URL(url).origin)).toEqual([origin]);
  }
});

test("a server with an account here signs in another person without a question", async () => {
  const { shell, store, opened, dialogs, connected, settle } = fixture();
  store.upsert(
    {
      baseUrl: "https://team.example",
      subjectId: "someone",
      email: "s@example.com",
      workspaceId: null,
    },
    "token",
  );
  shell.handleUrl(linkTo("https://team.example"));
  await settle();
  expect(dialogs).toEqual([]);
  expect(opened.map((url) => new URL(url).origin)).toEqual(["https://team.example"]);
  expect(connected).toEqual([]);
});

test("a link for an account already here goes straight to its connect confirmation", async () => {
  const { shell, store, opened, dialogs, connected, settle } = fixture();
  store.upsert(
    {
      baseUrl: "https://team.example",
      subjectId: "person",
      email: "p@example.com",
      workspaceId: null,
    },
    "token",
  );
  shell.handleUrl(linkTo("https://team.example"));
  await settle();
  expect(dialogs).toEqual([]);
  expect(opened).toEqual([]);
  expect(connected).toEqual(["https://team.example"]);
});
