import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchReopenedTabs,
  readBrowserTabIds,
  tabUrlHash,
  takeStoppedBrowserTabs,
  writeBrowserTabIds,
  writeStoppedBrowserTabs,
} from "../src/stopped-browser-tabs";

const page = (id: string, url: string, selected = false) => ({ id, url, selected, kind: "page" });
const stoppedTab = (targetId: string, url: string, selected = false) => ({
  targetId,
  urlHash: tabUrlHash(url),
  selected,
});

test("each stopped tab maps to the reopened tab showing its page", () => {
  expect(
    matchReopenedTabs(
      [
        stoppedTab("old-a", "https://a.example.test/"),
        stoppedTab("old-b", "https://b.example.test/", true),
        stoppedTab("old-gone", "https://gone.example.test/"),
      ],
      [page("new-b", "https://b.example.test/", true), page("new-a", "https://a.example.test/")],
    ),
  ).toEqual([
    { targetId: "old-a", replacementId: "new-a" },
    { targetId: "old-b", replacementId: "new-b" },
    // No reopened tab shows its page.
    { targetId: "old-gone", replacementId: null },
  ]);
});

test("tabs showing the same page never pair, as they can't be told apart", () => {
  const url = "https://same.example.test/";
  expect(
    matchReopenedTabs(
      [
        stoppedTab("old-1", url),
        stoppedTab("old-2", url, true),
        stoppedTab("old-3", url),
        stoppedTab("old-unique", "https://unique.example.test/"),
      ],
      [
        page("new-1", url),
        page("new-2", url, true),
        page("new-3", url),
        page("new-unique", "https://unique.example.test/"),
      ],
    ),
  ).toEqual([
    { targetId: "old-1", replacementId: null },
    { targetId: "old-2", replacementId: null },
    { targetId: "old-3", replacementId: null },
    { targetId: "old-unique", replacementId: "new-unique" },
  ]);
  // One stopped tab, two reopened tabs showing its page: still ambiguous.
  expect(
    matchReopenedTabs([stoppedTab("old", url, true)], [page("new-1", url), page("new-2", url)]),
  ).toEqual([{ targetId: "old", replacementId: null }]);
});

test("a tab whose ID still exists is the same tab and is not reported", () => {
  expect(
    matchReopenedTabs(
      [
        stoppedTab("kept", "https://kept.example.test/", true),
        stoppedTab("old", "https://kept.example.test/"),
      ],
      [
        page("kept", "https://kept.example.test/", true),
        { id: "worker", url: "https://kept.example.test/", selected: false, kind: "worker" },
      ],
    ),
  ).toEqual([{ targetId: "old", replacementId: null }]);
});

test("a blank tab never matches, even another blank tab", () => {
  // A URL too long to report reads as about:blank, so blank says nothing
  // about which page a tab showed.
  expect(tabUrlHash("about:blank")).toBeNull();
  expect(tabUrlHash("")).toBeNull();
  expect(
    matchReopenedTabs(
      [stoppedTab("old-blank", "about:blank", true), stoppedTab("old-new-tab", "chrome://newtab/")],
      [page("new-blank", "about:blank", true), page("new-new-tab", "chrome://newtab/")],
    ),
  ).toEqual([
    { targetId: "old-blank", replacementId: null },
    { targetId: "old-new-tab", replacementId: null },
  ]);
});

test("the record keeps a hash of each page's URL, never the URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ogb-stopped-tabs-"));
  try {
    const url = `https://private.example.test/inbox?token=${"x".repeat(16 * 1024)}`;
    const tabs = Array.from({ length: 64 }, (_, index) => stoppedTab(`old-${index}`, url));
    await writeStoppedBrowserTabs(directory, {
      version: 2,
      reason: "controller_restart",
      stoppedAt: "2026-01-02T03:04:05.000Z",
      tabs,
    });
    const text = await readFile(join(directory, "stopped-browser-tabs.json"), "utf8");
    expect(text).not.toContain("private.example.test");
    // 64 tabs of long URLs stay far below the size a read accepts.
    expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024);
    expect((await takeStoppedBrowserTabs(directory))?.tabs).toEqual(tabs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the record describes only the next launch and ignores anything unreadable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ogb-stopped-tabs-"));
  try {
    expect(await takeStoppedBrowserTabs(directory)).toBeNull();
    const record = {
      version: 2 as const,
      reason: "idle_release" as const,
      idleReleaseMinutes: 10,
      stoppedAt: "2026-01-02T03:04:05.000Z",
      tabs: [
        stoppedTab("old", "https://a.example.test/", true),
        stoppedTab("blank", "about:blank"),
      ],
    };
    await writeStoppedBrowserTabs(directory, record);
    expect(await takeStoppedBrowserTabs(directory)).toEqual(record);
    // Taken once: a later launch finds nothing.
    expect(await takeStoppedBrowserTabs(directory)).toBeNull();
    expect(await readdir(directory)).toEqual([]);

    await writeFile(join(directory, "stopped-browser-tabs.json"), "{not json");
    expect(await takeStoppedBrowserTabs(directory)).toBeNull();
    await writeFile(
      join(directory, "stopped-browser-tabs.json"),
      JSON.stringify({ ...record, reason: "something_else" }),
    );
    expect(await takeStoppedBrowserTabs(directory)).toBeNull();
    // A record with raw URLs is not read.
    await writeFile(
      join(directory, "stopped-browser-tabs.json"),
      JSON.stringify({
        ...record,
        tabs: [{ targetId: "old", urlHash: "https://a.example.test/", selected: true }],
      }),
    );
    expect(await takeStoppedBrowserTabs(directory)).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a running browser's tab IDs are kept for a reattach until a browser has none", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ogb-tab-ids-"));
  try {
    expect(await readBrowserTabIds(directory)).toEqual([]);
    const tabs = [
      { tabId: "old-a", browserTargetId: "new-a" },
      { tabId: "old-b", browserTargetId: "new-b" },
    ];
    await writeBrowserTabIds(directory, tabs);
    // Read, not taken: every reattach to the same browser needs them.
    expect(await readBrowserTabIds(directory)).toEqual(tabs);
    expect(await readBrowserTabIds(directory)).toEqual(tabs);
    await writeBrowserTabIds(directory, []);
    expect(await readdir(directory)).toEqual([]);

    await writeFile(join(directory, "browser-tab-ids.json"), "{not json");
    expect(await readBrowserTabIds(directory)).toEqual([]);
    await writeFile(
      join(directory, "browser-tab-ids.json"),
      JSON.stringify({ version: 1, tabs: [{ tabId: "old-a", browserTargetId: 7 }] }),
    );
    expect(await readBrowserTabIds(directory)).toEqual([]);
    await writeFile(join(directory, "browser-tab-ids.json"), JSON.stringify({ version: 2, tabs }));
    expect(await readBrowserTabIds(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
