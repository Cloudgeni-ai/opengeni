import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InboxItem, ListInboxResponse } from "@opengeni/sdk";

import { AccountStore } from "../src/main/accounts";
import {
  agentBinaryCandidates,
  connectionFor,
  lastErrorLine,
  parseConnections,
  parseServiceRunning,
} from "../src/main/agent-cli";
import { diffInbox, inboxItemPath, notificationPlan, plainText } from "../src/main/inbox-model";
import { localFile, localPageUrl } from "../src/main/local-pages";
import { nativeSignInUrl, parseSignInCallback, pkcePair } from "../src/main/pkce";
import { newestReleaseTag, resolveUpdateFeedUrl } from "../src/main/update-feed";
import { createHash } from "node:crypto";

const cipher = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(`sealed:${plain}`),
  decrypt: (sealed: Buffer) => sealed.toString().replace(/^sealed:/u, ""),
};

describe("account store", () => {
  test("keeps several accounts, one credential each, and reads them back", () => {
    const directory = mkdtempSync(join(tmpdir(), "og-desktop-"));
    const store = new AccountStore(directory, cipher);
    const first = store.upsert(
      { baseUrl: "https://App.Example.com/", subjectId: "u1", email: "a@x.io", workspaceId: "w1" },
      "ogapp_one",
    );
    const second = store.upsert(
      { baseUrl: "https://other.example", subjectId: "u2", email: "b@x.io", workspaceId: null },
      "ogapp_two",
    );
    expect(first.baseUrl).toBe("https://app.example.com");
    expect(store.active()?.id).toBe(second.id);
    expect(store.token(first.id)).toBe("ogapp_one");
    expect(readFileSync(join(directory, "accounts.json"), "utf8")).not.toContain("ogapp_");

    const reopened = new AccountStore(directory, cipher);
    expect(reopened.snapshot().accounts.map((account) => account.email)).toEqual([
      "a@x.io",
      "b@x.io",
    ]);
    expect(reopened.token(second.id)).toBe("ogapp_two");
  });

  test("the same person on the same server signs in again as the same account", () => {
    const store = new AccountStore(mkdtempSync(join(tmpdir(), "og-desktop-")), cipher);
    const first = store.upsert(
      { baseUrl: "https://app.example.com", subjectId: "u1", email: "a@x.io", workspaceId: "w1" },
      "old",
    );
    store.update(first.id, { signedOut: true, lastPath: "/workspaces/w1/sessions/s1" });
    const again = store.upsert(
      { baseUrl: "https://app.example.com", subjectId: "u1", email: "a@x.io", workspaceId: null },
      "new",
    );
    expect(again.id).toBe(first.id);
    expect(again.signedOut).toBeUndefined();
    expect(again.workspaceId).toBe("w1");
    expect(again.lastPath).toBe("/workspaces/w1/sessions/s1");
    expect(store.token(first.id)).toBe("new");
    expect(store.snapshot().accounts).toHaveLength(1);
  });

  test("removing the active account moves to the next and forgets its credential", () => {
    const store = new AccountStore(mkdtempSync(join(tmpdir(), "og-desktop-")), cipher);
    const first = store.upsert(
      { baseUrl: "https://a.example", subjectId: "u1", email: "a@x.io", workspaceId: null },
      "one",
    );
    const second = store.upsert(
      { baseUrl: "https://b.example", subjectId: "u2", email: "b@x.io", workspaceId: null },
      "two",
    );
    store.remove(second.id);
    expect(store.active()?.id).toBe(first.id);
    expect(store.token(second.id)).toBeNull();
  });

  test("refuses to keep a credential without secure storage", () => {
    const store = new AccountStore(mkdtempSync(join(tmpdir(), "og-desktop-")), {
      ...cipher,
      available: () => false,
    });
    expect(() =>
      store.upsert(
        { baseUrl: "https://a.example", subjectId: "u", email: "e", workspaceId: null },
        "t",
      ),
    ).toThrow(/secure storage/u);
  });
});

describe("native sign-in", () => {
  test("PKCE challenge is the S256 of the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  test("builds the server's sign-in page address", () => {
    const url = new URL(
      nativeSignInUrl({
        baseUrl: "https://app.example.com",
        redirectUri: "opengeni://auth/callback",
        challenge: "c",
        state: "s",
        platform: "macos",
        deviceName: "  Studio  ",
      }),
    );
    expect(url.pathname).toBe("/native-sign-in");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: "opengeni://auth/callback",
      code_challenge: "c",
      state: "s",
      platform: "macos",
      device_name: "Studio",
    });
  });

  test("reads the callback, and ignores other app links", () => {
    const redirect = "opengeni://auth/callback";
    expect(parseSignInCallback("opengeni://auth/callback?code=abc&state=s1", redirect)).toEqual({
      kind: "code",
      code: "abc",
      state: "s1",
    });
    expect(
      parseSignInCallback("opengeni://auth/callback?error=access_denied&state=s1", redirect),
    ).toEqual({
      kind: "error",
      state: "s1",
      error: "access_denied",
    });
    expect(parseSignInCallback("opengeni://open?url=https%3A%2F%2Fa.example", redirect)).toBeNull();
  });
});

describe("agent command line", () => {
  test("finds the installer's agent paths", () => {
    expect(agentBinaryCandidates("darwin", "/Users/user", {})).toEqual([
      "/Users/user/Applications/OpenGeni Agent.app/Contents/MacOS/opengeni-agent",
      "/Users/user/.local/bin/opengeni-agent",
    ]);
    expect(agentBinaryCandidates("linux", "/home/user", {})).toEqual([
      "/home/user/.local/bin/opengeni-agent",
    ]);
    expect(agentBinaryCandidates("win32", "C:/Users/user", { LOCALAPPDATA: "C:/L" })[0]).toContain(
      "opengeni-agent.exe",
    );
  });

  test("parses connections and matches the server and workspace", () => {
    const output = [
      "Configured Opengeni connections (2):",
      "  c1  https://App.Example.com  workspace=w1  agent=a1",
      "  c2  https://old.example (legacy origin unverified; reconnect once to confirm)  workspace=w2  agent=a2",
    ].join("\n");
    const connections = parseConnections(output);
    expect(connections).toEqual([
      { connectionId: "c1", apiUrl: "https://app.example.com", workspaceId: "w1", agentId: "a1" },
      { connectionId: "c2", apiUrl: "https://old.example", workspaceId: "w2", agentId: "a2" },
    ]);
    expect(connectionFor(connections, "https://app.example.com/", "w1")?.connectionId).toBe("c1");
    expect(connectionFor(connections, "https://app.example.com", "w2")).toBeNull();
    expect(
      parseConnections("No Opengeni connections configured. Run `opengeni-agent connect`."),
    ).toEqual([]);
  });

  test("reads the service status on each platform", () => {
    expect(parseServiceRunning("opengeni-agent LaunchAgent: loaded")).toBe(true);
    expect(parseServiceRunning("opengeni-agent LaunchAgent: not loaded")).toBe(false);
    expect(parseServiceRunning("opengeni-agent service: active")).toBe(true);
    expect(parseServiceRunning("opengeni-agent service: inactive")).toBe(false);
    expect(parseServiceRunning("        STATE              : 4  RUNNING")).toBe(true);
    expect(parseServiceRunning("        STATE              : 1  STOPPED")).toBe(false);
  });

  test("keeps the last meaningful error line", () => {
    expect(lastErrorLine("\u001b[31merror: enroll token expired\u001b[0m\n\n")).toBe(
      "enroll token expired",
    );
    expect(lastErrorLine("   \n")).toBeNull();
  });
});

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: "i1",
    workspaceId: "w1",
    sessionId: "s1",
    sessionTitle: "Fix the build",
    kind: "question",
    sourceKey: "q1",
    title: "Which branch?",
    subtitle: "",
    body: "Pick **one**",
    facts: [],
    link: null,
    eventSequence: 42,
    choices: [],
    urgency: "normal",
    status: "open",
    unread: true,
    snoozedUntil: null,
    createdAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-14T10:00:00Z",
    resolvedAt: null,
    sender: null,
    sessionAvailable: true,
    ...overrides,
  };
}

function inbox(items: InboxItem[]): ListInboxResponse {
  return { items, needsYouCount: items.length, unreadCount: items.length };
}

describe("inbox notifications", () => {
  test("the first reading only records; later readings announce new and changed items", () => {
    const first = diffInbox(null, inbox([item({})]), Date.now());
    expect(first.announce).toEqual([]);
    const second = diffInbox(
      first.seen,
      inbox([item({}), item({ id: "i2", kind: "approval", title: "Run rm?" })]),
      Date.now(),
    );
    expect(second.announce.map((entry) => entry.id)).toEqual(["i2"]);
    const changed = diffInbox(
      second.seen,
      inbox([item({ updatedAt: "2026-10-14T11:00:00Z" })]),
      Date.now(),
    );
    expect(changed.announce.map((entry) => entry.id)).toEqual(["i1"]);
    expect(changed.retract).toEqual(["i2"]);
  });

  test("read, snoozed and closed items stay quiet", () => {
    const now = Date.parse("2026-10-14T10:30:00Z");
    const diff = diffInbox(
      new Map(),
      inbox([
        item({ id: "read", unread: false }),
        item({ id: "snoozed", snoozedUntil: "2026-10-14T12:00:00Z" }),
        item({ id: "done", status: "resolved" }),
      ]),
      now,
    );
    expect(diff.announce).toEqual([]);
    expect([...diff.seen.keys()]).toEqual(["read", "snoozed"]);
  });

  test("plans one-tap answers like the inbox", () => {
    expect(notificationPlan(item({ kind: "approval" }), null).buttons.map((b) => b.label)).toEqual([
      "Approve",
      "Deny",
    ]);
    const choice = notificationPlan(
      item({ choices: [{ id: "main", label: "main" }] }),
      "a@x.io · app",
    );
    expect(choice.buttons).toEqual([
      { label: "main", action: { kind: "choose", choiceId: "main", label: "main" } },
    ]);
    expect(choice.subtitle).toBe("Fix the build · a@x.io · app");
    expect(notificationPlan(item({}), null).reply).toBe(true);
    expect(notificationPlan(item({ kind: "notification" }), null).buttons).toEqual([]);
  });

  test("opens the session at the item's moment", () => {
    expect(inboxItemPath(item({}))).toBe("/workspaces/w1/sessions/s1?at=42");
    expect(inboxItemPath(item({ sessionAvailable: false }))).toBe("/workspaces/w1/inbox");
  });

  test("plain text for the banner", () => {
    expect(plainText("Use **this** [link](https://x) and `code`\n- one\n- two")).toBe(
      "Use this link and code\n• one\n• two",
    );
  });
});

describe("local pages", () => {
  test("serve only page files inside the pages directory", () => {
    expect(localFile("/app/pages", localPageUrl("welcome.html"))).toBe("/app/pages/welcome.html");
    expect(localFile("/app/pages", "app://local/welcome.css?x=1")).toBe("/app/pages/welcome.css");
    expect(localFile("/app/pages", "app://local/../main.mjs")).toBeNull();
    expect(localFile("/app/pages", "app://local/..%2Fsecrets.html")).toBeNull();
    expect(localFile("/app/pages", "app://local/notes.txt")).toBeNull();
    expect(localFile("/app/pages", "app://elsewhere/welcome.html")).toBeNull();
    expect(localFile("/app/pages", "https://local/welcome.html")).toBeNull();
  });
});

describe("update feed", () => {
  test("picks the highest stable release tag with the prefix", () => {
    expect(
      newestReleaseTag(
        [
          "desktop-v0.9.0",
          "desktop-v0.10.0",
          "desktop-v1.0.0-beta.1",
          "agent-v9.0.0",
          "desktop-vx",
        ],
        "desktop-v",
      ),
    ).toBe("desktop-v0.10.0");
    expect(newestReleaseTag(["agent-v1.0.0"], "desktop-v")).toBeNull();
  });

  test("reads the newest release's files, or a fixed feed as is", async () => {
    const requested: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json([
        { ref: "refs/tags/desktop-v0.1.0" },
        { ref: "refs/tags/desktop-v0.2.1" },
      ]);
    }) as typeof fetch;
    expect(
      await resolveUpdateFeedUrl(
        { githubRepository: "example/app", tagPrefix: "desktop-v" },
        fakeFetch,
      ),
    ).toBe("https://github.com/example/app/releases/download/desktop-v0.2.1");
    expect(requested).toEqual([
      "https://api.github.com/repos/example/app/git/matching-refs/tags/desktop-v",
    ]);
    expect(await resolveUpdateFeedUrl({ url: "https://updates.example.com/app" })).toBe(
      "https://updates.example.com/app",
    );
  });
});
