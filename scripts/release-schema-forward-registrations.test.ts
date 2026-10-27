import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FORWARD_MIGRATIONS_DIR,
  ForwardRegistrationError,
  forwardRegistrationContent,
  forwardRegistrationPath,
  parseForwardRegistrations,
  readForwardMigrationRegistrations,
} from "./release-schema-forward-registrations";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forward-registrations-"));
  scratch.push(root);
  await mkdir(join(root, FORWARD_MIGRATIONS_DIR), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, FORWARD_MIGRATIONS_DIR, name), content);
  }
  return root;
}

describe("release-schema forward registrations", () => {
  test("returns the registered migrations sorted, whatever the directory order", () => {
    expect(
      parseForwardRegistrations([
        { name: "0010_later.txt", isFile: true, content: "0010_later.sql\n" },
        { name: "README.md", isFile: true, content: "# docs" },
        { name: "0002_earlier.txt", isFile: true, content: "0002_earlier.sql" },
      ]),
    ).toEqual(["0002_earlier.sql", "0010_later.sql"]);
  });

  test("fails closed on anything that is not a well-formed registration", () => {
    for (const entry of [
      { name: "0002_earlier.sql", isFile: true, content: "0002_earlier.sql\n" },
      { name: "notes.txt", isFile: true, content: "notes.sql\n" },
      { name: "0002_earlier.txt", isFile: false },
      { name: "README.md", isFile: false },
    ]) {
      expect(() => parseForwardRegistrations([entry])).toThrow(ForwardRegistrationError);
    }
    expect(() =>
      parseForwardRegistrations([
        { name: "0002_earlier.txt", isFile: true, content: "0003_other.sql\n" },
      ]),
    ).toThrow("must contain exactly 0002_earlier.sql");
    expect(() =>
      parseForwardRegistrations([{ name: "0002_earlier.txt", isFile: true, content: "" }]),
    ).toThrow(ForwardRegistrationError);
  });

  test("names and fills a registration file from the migration file name", () => {
    expect(forwardRegistrationPath("0998_managed_auth_passkeys.sql")).toBe(
      `${FORWARD_MIGRATIONS_DIR}/0998_managed_auth_passkeys.txt`,
    );
    expect(forwardRegistrationContent("0998_managed_auth_passkeys.sql")).toBe(
      "0998_managed_auth_passkeys.sql\n",
    );
    expect(() => forwardRegistrationPath("custom_probe.sql")).toThrow(ForwardRegistrationError);
  });

  test("reads a repository's registration directory", async () => {
    const root = await repository({
      "0004_b.txt": "0004_b.sql\n",
      "0003_a.txt": "0003_a.sql\n",
      "README.md": "# docs\n",
    });
    expect(readForwardMigrationRegistrations(root)).toEqual(["0003_a.sql", "0004_b.sql"]);
  });

  test("rejects a symlinked registration and a missing directory", async () => {
    const root = await repository({});
    await writeFile(join(root, "target.txt"), "0003_a.sql\n");
    await symlink(join(root, "target.txt"), join(root, FORWARD_MIGRATIONS_DIR, "0003_a.txt"));
    expect(() => readForwardMigrationRegistrations(root)).toThrow(ForwardRegistrationError);
    const empty = await mkdtemp(join(tmpdir(), "forward-registrations-missing-"));
    scratch.push(empty);
    expect(() => readForwardMigrationRegistrations(empty)).toThrow(
      `cannot read ${FORWARD_MIGRATIONS_DIR}`,
    );
  });

  test("every registration in this repository names a well-formed migration file", () => {
    const registered = readForwardMigrationRegistrations();
    expect(registered.length).toBeGreaterThan(0);
    for (const migration of registered) expect(migration).toMatch(/^\d{4}_[A-Za-z0-9_]+\.sql$/);
  });
});
