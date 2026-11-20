import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteFile, sqliteFilePath } from "../src/sqlite-file";

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("sqliteFilePath", () => {
  test("uses the extended-length form for Windows drive and UNC paths", () => {
    expect(sqliteFilePath("C:\\Users\\user\\state\\operations.sqlite", "win32")).toBe(
      "\\\\?\\C:\\Users\\user\\state\\operations.sqlite",
    );
    expect(sqliteFilePath("C:/Users/user/state/operations.sqlite", "win32")).toBe(
      "\\\\?\\C:\\Users\\user\\state\\operations.sqlite",
    );
    expect(sqliteFilePath("\\\\server\\share\\state\\operations.sqlite", "win32")).toBe(
      "\\\\?\\UNC\\server\\share\\state\\operations.sqlite",
    );
    expect(sqliteFilePath("\\\\?\\C:\\already\\operations.sqlite", "win32")).toBe(
      "\\\\?\\C:\\already\\operations.sqlite",
    );
  });

  test("leaves other platforms and in-memory databases unchanged", () => {
    expect(sqliteFilePath("/srv/a/state/operations.sqlite", "linux")).toBe(
      "/srv/a/state/operations.sqlite",
    );
    expect(sqliteFilePath("/opt/a/state/operations.sqlite", "darwin")).toBe(
      "/opt/a/state/operations.sqlite",
    );
    expect(sqliteFilePath(":memory:", "win32")).toBe(":memory:");
  });
});

test("creates and writes a database whose path is longer than 260 characters", async () => {
  const root = await mkdtemp(join(tmpdir(), "browserd-sqlite-"));
  created.push(root);
  let directory = root;
  while (join(directory, "operations.sqlite").length <= 300) {
    directory = join(directory, "d".repeat(40));
  }
  await mkdir(directory, { recursive: true });
  const path = join(directory, "operations.sqlite");
  expect(path.length).toBeGreaterThan(260);

  const database = openSqliteFile(path, { create: true, readwrite: true, strict: true });
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    database.query("INSERT INTO entries (value) VALUES (?)").run("written");
    expect(database.query("SELECT value FROM entries").get()).toEqual({ value: "written" });
  } finally {
    database.close();
  }
});
