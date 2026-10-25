import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchReopenedTabs,
  takeStoppedBrowserTabs,
  writeStoppedBrowserTabs,
} from "../src/stopped-browser-tabs";

const page = (id: string, url: string, selected = false) => ({ id, url, selected, kind: "page" });

test("each stopped tab maps to the reopened tab showing its page", () => {
  expect(
    matchReopenedTabs(
      [
        { targetId: "old-a", url: "https://a.example.test/", selected: false },
        { targetId: "old-b", url: "https://b.example.test/", selected: true },
        { targetId: "old-gone", url: "https://gone.example.test/", selected: false },
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

test("tabs showing the same page pair up once each, the selected one with the selected one", () => {
  const url = "https://same.example.test/";
  expect(
    matchReopenedTabs(
      [
        { targetId: "old-1", url, selected: false },
        { targetId: "old-2", url, selected: true },
        { targetId: "old-3", url, selected: false },
      ],
      [page("new-1", url), page("new-2", url, true)],
    ),
  ).toEqual([
    { targetId: "old-1", replacementId: "new-1" },
    { targetId: "old-2", replacementId: "new-2" },
    { targetId: "old-3", replacementId: null },
  ]);
});

test("a tab whose ID still exists is the same tab and is not reported", () => {
  expect(
    matchReopenedTabs(
      [
        { targetId: "kept", url: "https://kept.example.test/", selected: true },
        { targetId: "old", url: "https://kept.example.test/", selected: false },
      ],
      [
        page("kept", "https://kept.example.test/", true),
        { id: "worker", url: "https://kept.example.test/", selected: false, kind: "worker" },
      ],
    ),
  ).toEqual([{ targetId: "old", replacementId: null }]);
});

test("the record describes only the next launch and ignores anything unreadable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ogb-stopped-tabs-"));
  try {
    expect(await takeStoppedBrowserTabs(directory)).toBeNull();
    const record = {
      version: 1 as const,
      reason: "idle_release" as const,
      idleReleaseMinutes: 10,
      stoppedAt: "2026-01-02T03:04:05.000Z",
      tabs: [{ targetId: "old", url: "https://a.example.test/", selected: true }],
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
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
