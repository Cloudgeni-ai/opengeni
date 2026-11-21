import { describe, expect, test } from "bun:test";
import { APP_PACKAGE_FORMAT } from "@opengeni/contracts";
import {
  notInstalledSummary,
  readAppPackageFile,
} from "../src/app/components/artifacts/app-package";

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
