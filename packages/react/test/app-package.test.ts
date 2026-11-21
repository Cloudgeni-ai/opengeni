import { describe, expect, test } from "bun:test";
import { APP_PACKAGE_FORMAT } from "@opengeni/contracts";
import {
  notInstalledSummary,
  readAppPackageFile,
  upgradePlanLines,
} from "../src/app/components/artifacts/app-package";
import type { AppPackageUpgradePlan } from "@opengeni/contracts";

const file = (text: string) => ({ text: async () => text });
const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: APP_PACKAGE_FORMAT,
    version: 1,
    app: { title: "Team board", html: "<h1>Board</h1>" },
    ...extra,
  });

describe("an app package file chosen in the console", () => {
  test("reads the title, and whether it has demo data", async () => {
    const plain = await readAppPackageFile(file(pkg()));
    expect(plain).toMatchObject({ ok: true, chosen: { title: "Team board", hasDemoData: false } });
    const demo = await readAppPackageFile(
      file(pkg({ demoData: { records: { tasks: [{ data: { title: "One" } }] }, sqlRows: {} } })),
    );
    expect(demo).toMatchObject({ ok: true, chosen: { hasDemoData: true } });
    const emptyDemo = await readAppPackageFile(
      file(pkg({ demoData: { records: {}, sqlRows: {} } })),
    );
    expect(emptyDemo).toMatchObject({ ok: true, chosen: { hasDemoData: false } });
    const files = await readAppPackageFile(
      file(
        pkg({
          demoData: {
            records: {},
            sqlRows: {},
            files: [{ name: "a.txt", contentType: "text/plain", base64: "YQ==" }],
          },
        }),
      ),
    );
    expect(files).toMatchObject({ ok: true, chosen: { hasDemoData: true } });
  });

  test("says when a file isn't a package", async () => {
    expect(await readAppPackageFile(file("not json"))).toEqual({
      ok: false,
      error: "This file isn't an app package.",
    });
    const other = await readAppPackageFile(file(JSON.stringify({ name: "an agent" })));
    expect(other.ok).toBe(false);
  });

  test("summarizes what an install left out", () => {
    expect(notInstalledSummary([])).toBeNull();
    expect(notInstalledSummary([{ part: "sql", reason: "No database here." }])).toBe(
      "No database here.",
    );
    expect(
      notInstalledSummary([
        { part: "migration", name: "create_items", reason: "It failed." },
        { part: "query", name: "list_items", reason: "It failed." },
      ]),
    ).toBe("create_items: It failed. (and 1 more)");
  });
});

describe("an upgrade's plan in the console", () => {
  const empty: AppPackageUpgradePlan = {
    version: { changed: false, html: false, source: false, tools: false },
    tools: { added: [], removed: [] },
    collections: { added: [], changed: [], unchanged: ["tasks"], kept: [] },
    migrations: { applied: ["create_items"], new: [], conflicting: [] },
    queries: { added: [], changed: [], removed: [], unchanged: [] },
    syncs: { added: [], changed: [], unchanged: [], kept: [] },
    destructive: [],
    conflicts: [],
    problems: [],
  };

  test("is empty when the app already matches", () => {
    expect(upgradePlanLines(empty)).toEqual([]);
  });

  test("lists each kind of change once, and what stays", () => {
    expect(
      upgradePlanLines({
        ...empty,
        version: { changed: true, html: true, source: false, tools: true },
        tools: { added: [{ serverId: "crm", toolName: "contacts_list" }], removed: [] },
        collections: { added: ["labels"], changed: ["tasks"], unchanged: [], kept: ["notes"] },
        migrations: { applied: [], new: ["a", "b", "c", "d"], conflicting: [] },
        queries: { added: [], changed: [], removed: ["old"], unchanged: [] },
        syncs: { added: ["Import"], changed: [], unchanged: [], kept: [] },
      }),
    ).toEqual([
      "New version of the app",
      "Tools: adds contacts_list",
      "Collections: adds labels; changes tasks",
      "Database: runs a, b, c and 1 more",
      "Queries: removes old",
      "Syncs: adds Import (paused)",
      "Keeps notes, which the package doesn't have",
    ]);
  });
});
