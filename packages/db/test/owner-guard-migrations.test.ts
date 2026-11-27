import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const directory = join(import.meta.dir, "../drizzle");

// The per-table owner-guard migrations are one template with the table name
// filled in, so a fix to one must reach every copy.
test("every owner-guard migration is the same template for its own table", () => {
  const files = readdirSync(directory)
    .map((file) => /^(\d{4})_owner_guard_(\w+)\.sql$/.exec(file))
    .filter((match) => match !== null)
    .sort((a, b) => a[1]!.localeCompare(b[1]!));
  expect(files.length).toBe(43);
  const template = (file: string, table: string) =>
    readFileSync(join(directory, file), "utf8")
      .replace(`row policies of ${table} get`, "row policies of TABLE get")
      .replace(`'${table}'::regclass`, "'TABLE'::regclass");
  const first = template(files[0]![0], files[0]![2]!);
  expect(first).toContain("'TABLE'::regclass");
  expect(first).toContain("'lock_timeout', '300ms'");
  for (const [file, , table] of files)
    expect({ file, sql: template(file, table!) }).toEqual({ file, sql: first });
  expect(files.map(([, , table]) => table)).toEqual(files.map(([, , table]) => table).sort());
});
