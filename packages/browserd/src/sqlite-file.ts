import { win32 } from "node:path";
import { Database } from "bun:sqlite";

type SqliteOpenOptions = ConstructorParameters<typeof Database>[1];

/**
 * SQLite's Windows file layer passes the path to CreateFileW as given, so a
 * file path of 260 characters or more fails with "unable to open database
 * file" unless it uses the extended-length (\\?\) form. Node's own file calls
 * add that form themselves, so the directory can exist while the database
 * cannot be created. A deep but legitimate controller root (for example an
 * app-private data folder) easily crosses the limit.
 */
export function sqliteFilePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || path === "" || path === ":memory:") return path;
  return win32.toNamespacedPath(win32.resolve(path));
}

/** Open a browserd SQLite file in a form that works at any path length. */
export function openSqliteFile(path: string, options?: SqliteOpenOptions): Database {
  return new Database(sqliteFilePath(path), options);
}
