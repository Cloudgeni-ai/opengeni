import { describe, expect, test } from "bun:test";
import {
  APP_PACKAGE_FORMAT,
  AppPackageFormatError,
  AppPackageUpgradeRequest,
  compareAppPackageVersions,
  parseAppPackage,
  siteSqlDestructiveChanges,
} from "../src";

describe("destructive SQL in a new migration", () => {
  test("finds statements that delete, overwrite or rename existing data", () => {
    expect(siteSqlDestructiveChanges("DROP TABLE items;")).toEqual(["DROP TABLE"]);
    expect(siteSqlDestructiveChanges("ALTER TABLE items DROP COLUMN qty")).toEqual([
      "ALTER TABLE … DROP",
    ]);
    expect(siteSqlDestructiveChanges("ALTER TABLE items RENAME COLUMN a TO b")).toEqual([
      "ALTER TABLE … RENAME",
    ]);
    expect(siteSqlDestructiveChanges("DELETE FROM items; UPDATE items SET qty = 0")).toEqual([
      "DELETE",
      "UPDATE",
    ]);
    expect(siteSqlDestructiveChanges("INSERT OR REPLACE INTO items VALUES (1)")).toEqual([
      "REPLACE",
    ]);
  });

  test("leaves additive SQL alone", () => {
    expect(
      siteSqlDestructiveChanges(`
        CREATE TABLE orders (id INTEGER PRIMARY KEY, item INTEGER REFERENCES items(id) ON DELETE CASCADE);
        CREATE INDEX orders_item ON orders (item);
        DROP INDEX old_index;
        ALTER TABLE items ADD COLUMN price INTEGER;
        INSERT INTO items (name) VALUES ('DELETE me'); -- DROP TABLE nothing
      `),
    ).toEqual([]);
  });

  test("reports SQL it can't read", () => {
    expect(siteSqlDestructiveChanges("SELECT 'unterminated")).toEqual(["unreadable SQL"]);
  });
});

const FILE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

describe("app package demo files and blob values", () => {
  const base = {
    format: APP_PACKAGE_FORMAT,
    version: 1,
    app: { title: "Board", html: "<h1>Board</h1>" },
  };

  test("reads shared files and base64 blob values", () => {
    const { package: pkg, problems } = parseAppPackage({
      ...base,
      demoData: {
        records: {},
        sqlRows: { blobs: [{ id: 1, data: { $base64: "AP8Q" } }] },
        files: [
          { id: FILE_ID, name: "readme.txt", contentType: "text/plain", base64: "aGVsbG8=" },
          { name: "broken" },
        ],
      },
    });
    expect(pkg.demoData?.sqlRows.blobs).toEqual([{ id: 1, data: { $base64: "AP8Q" } }]);
    expect(pkg.demoData?.files).toEqual([
      { id: FILE_ID, name: "readme.txt", contentType: "text/plain", base64: "aGVsbG8=" },
    ]);
    expect(problems).toContainEqual(expect.objectContaining({ part: "demo_data" }));
  });

  test("version 1 packages without files stay readable", () => {
    const { package: pkg } = parseAppPackage({
      ...base,
      demoData: { records: {}, sqlRows: { items: [{ id: 1, name: "Bolts" }] } },
    });
    expect(pkg.demoData?.files).toBeUndefined();
    expect(pkg.demoData?.sqlRows.items).toEqual([{ id: 1, name: "Bolts" }]);
  });
});

describe("app package asset files and package id", () => {
  const base = {
    format: APP_PACKAGE_FORMAT,
    version: 1,
    app: { title: "Board", html: "<h1>Board</h1>" },
  };
  const PACKAGE_ID = "3f1c2b9a-8d4e-8f21-9a6b-5c7d0e1f2a3b";

  test("reads a multi-file build's files and the package id", () => {
    const assets = { files: [{ path: "assets/index-1.js", base64: "eA==" }] };
    const { package: pkg, problems } = parseAppPackage({
      ...base,
      packageId: PACKAGE_ID,
      app: { ...base.app, assets },
    });
    expect(pkg.packageId).toBe(PACKAGE_ID);
    expect(pkg.app.assets).toEqual(assets);
    expect(problems).toEqual([]);
  });

  test("ignores an invalid package id and refuses invalid asset files", () => {
    expect(parseAppPackage({ ...base, packageId: "nope" }).package.packageId).toBeUndefined();
    expect(() => parseAppPackage({ ...base, app: { ...base.app, assets: { files: [] } } })).toThrow(
      AppPackageFormatError,
    );
  });
});

describe("package versions, Skills and automations", () => {
  const base = {
    format: APP_PACKAGE_FORMAT,
    version: 1,
    app: { title: "Board", html: "<h1>Board</h1>" },
  };
  const skill = (name: string, description = "Do the thing") => ({
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`,
      },
    ],
  });

  test("compares versions by their numbers", () => {
    expect(compareAppPackageVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareAppPackageVersions("1.0", "1.0.0")).toBe(0);
    expect(compareAppPackageVersions("0.9.1", "1.0.0")).toBeLessThan(0);
  });

  test("reads a version, Skills named by their SKILL.md, and automations", () => {
    const { package: pkg, problems } = parseAppPackage({
      ...base,
      packageVersion: "1.2.0",
      skills: [skill("notes", "Add notes to the board"), skill("notes"), { files: [] }],
      automations: [{ name: "Daily", prompt: "Update {{appId}}", schedule: { type: "calendar" } }],
    });
    expect(pkg.packageVersion).toBe("1.2.0");
    expect(pkg.skills?.map((entry) => [entry.name, entry.description])).toEqual([
      ["notes", "Add notes to the board"],
    ]);
    expect(pkg.automations?.map((entry) => entry.name)).toEqual(["Daily"]);
    // A second Skill with the same name and an empty one are reported, not read.
    expect(problems.filter((problem) => problem.part === "skill").length).toBe(2);
  });

  test("an invalid version is reported and left out", () => {
    const { package: pkg, problems } = parseAppPackage({ ...base, packageVersion: "v1" });
    expect(pkg.packageVersion).toBeUndefined();
    expect(problems).toContainEqual(expect.objectContaining({ name: "packageVersion" }));
  });

  test("an upgrade names exactly one of a package or the previous version", () => {
    expect(AppPackageUpgradeRequest.safeParse({ package: base }).success).toBe(true);
    expect(AppPackageUpgradeRequest.safeParse({ previous: true }).success).toBe(true);
    expect(AppPackageUpgradeRequest.safeParse({ package: base, previous: true }).success).toBe(
      false,
    );
    expect(AppPackageUpgradeRequest.safeParse({}).success).toBe(false);
  });
});
