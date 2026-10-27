import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import {
  acquireBlankTestDatabase,
  type BlankTestDatabase,
  planSharedTestTemplatePrune,
  pruneStaleSharedTestTemplates,
  sharedTestTemplateLastUsed,
  sharedTestTemplateName,
  sharedTestTemplateStamp,
} from "../src/shared-pg";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DB_PACKAGE_DIR = fileURLToPath(new URL("../../db", import.meta.url));

describe("shared test template name", () => {
  test("is the same for identical checkouts at different paths", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opengeni-template-name-"));
    try {
      const copies = [join(scratch, "one", "db"), join(scratch, "elsewhere", "two", "db")];
      for (const copy of copies) {
        await cp(join(DB_PACKAGE_DIR, "drizzle"), join(copy, "drizzle"), { recursive: true });
        await cp(join(DB_PACKAGE_DIR, "src"), join(copy, "src"), { recursive: true });
      }
      const original = await sharedTestTemplateName(DB_PACKAGE_DIR);
      expect(original).toMatch(/^og_test_template_[0-9a-f]{12}$/u);
      expect(await sharedTestTemplateName(copies[0]!)).toBe(original);
      expect(await sharedTestTemplateName(copies[1]!)).toBe(original);

      // Any change to the template contract still gets its own template.
      await appendFile(join(copies[1]!, "src", "provision-roles.ts"), "\n// changed\n");
      expect(await sharedTestTemplateName(copies[1]!)).not.toBe(original);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("shared test template retention", () => {
  const now = new Date("2026-06-10T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  test("round-trips the last-use stamp and ignores foreign comments", () => {
    expect(sharedTestTemplateLastUsed(sharedTestTemplateStamp(now))).toEqual(now);
    expect(sharedTestTemplateLastUsed(null)).toBeNull();
    expect(sharedTestTemplateLastUsed("hand-written note")).toBeNull();
    expect(sharedTestTemplateLastUsed("og-test-template last-used not-a-date")).toBeNull();
  });

  test("prunes idle templates oldest first and never busy or recently used ones", () => {
    const plan = planSharedTestTemplatePrune(
      [
        {
          name: "used-today",
          comment: sharedTestTemplateStamp(ago(HOUR)),
          builtAt: ago(30 * DAY),
          busy: false,
        },
        {
          name: "idle-4d",
          comment: sharedTestTemplateStamp(ago(4 * DAY)),
          builtAt: ago(4 * DAY),
          busy: false,
        },
        {
          name: "idle-9d",
          comment: sharedTestTemplateStamp(ago(9 * DAY)),
          builtAt: ago(9 * DAY),
          busy: false,
        },
        {
          name: "busy-idle",
          comment: sharedTestTemplateStamp(ago(9 * DAY)),
          builtAt: ago(9 * DAY),
          busy: true,
        },
        // Unstamped templates predate last-use stamps: aged by build time with a longer grace.
        { name: "unstamped-5d", comment: null, builtAt: ago(5 * DAY), busy: false },
        { name: "unstamped-8d", comment: null, builtAt: ago(8 * DAY), busy: false },
        { name: "unknown-age", comment: "hand-written note", builtAt: null, busy: false },
      ],
      now,
    );
    expect(plan.drop).toEqual(["idle-9d", "unstamped-8d", "idle-4d"]);
    expect(plan.stamp).toEqual(["unknown-age"]);
  });

  test("bounds how many templates one build drops", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      name: `stale-${index}`,
      comment: sharedTestTemplateStamp(ago((10 + index) * DAY)),
      builtAt: null,
      busy: false,
    }));
    const plan = planSharedTestTemplatePrune(candidates, now, 3);
    expect(plan.drop).toEqual(["stale-39", "stale-38", "stale-37"]);
  });
});

describe("pruning stale templates in PostgreSQL", () => {
  let blank: BlankTestDatabase;
  let root: postgres.Sql;
  const prefix = `og_prunetest_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}_`;
  const name = (suffix: string) => `${prefix}${suffix}`;
  const created: string[] = [];
  let holder: postgres.Sql | undefined;

  beforeAll(async () => {
    const acquired = await acquireBlankTestDatabase("template-prune");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    blank = acquired;
    root = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
  }, 180_000);

  afterAll(async () => {
    await holder?.end().catch(() => undefined);
    for (const database of created) {
      await root
        .unsafe(`ALTER DATABASE "${database}" WITH IS_TEMPLATE false`)
        .catch(() => undefined);
      await root
        .unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
        .catch(() => undefined);
    }
    await root?.end().catch(() => undefined);
    await blank?.release();
  }, 60_000);

  async function createTemplate(suffix: string, options: { template: boolean; stamp?: Date }) {
    const database = name(suffix);
    created.push(database);
    await root.unsafe(`CREATE DATABASE "${database}"`);
    if (options.template) {
      await root.unsafe(`ALTER DATABASE "${database}" WITH IS_TEMPLATE true`);
    }
    if (options.stamp) {
      await root.unsafe(
        `COMMENT ON DATABASE "${database}" IS '${sharedTestTemplateStamp(options.stamp)}'`,
      );
    }
  }

  async function remaining(): Promise<{ name: string; template: boolean }[]> {
    const rows = await root<{ name: string; template: boolean }[]>`
      SELECT datname AS name, datistemplate AS template FROM pg_database
      WHERE datname = ANY(${created}) ORDER BY datname`;
    return rows.map((row) => ({ name: row.name, template: row.template }));
  }

  test("drops only idle templates and partial leftovers past retention", async () => {
    const start = new Date();
    const later = (ms: number) => new Date(start.getTime() + ms);
    await createTemplate("a_recent", { template: true, stamp: later(8 * DAY - HOUR) });
    await createTemplate("b_idle", { template: true, stamp: start });
    await createTemplate("c_unstamped", { template: true });
    await createTemplate("d_partial", { template: false });
    await createTemplate("e_connected", { template: true, stamp: start });
    await createTemplate("f_kept", { template: true, stamp: start });
    // A connected session marks a template as in use; it is never dropped.
    const url = new URL(blank.databaseUrl);
    url.pathname = `/${name("e_connected")}`;
    holder = postgres(url.toString(), { max: 1 });
    await holder`SELECT 1`;

    // Four days on: only the idle stamped template has aged out.
    expect(
      await pruneStaleSharedTestTemplates(root, {
        prefix,
        keep: name("f_kept"),
        now: later(4 * DAY),
      }),
    ).toEqual([name("b_idle")]);

    // Eight days on: unstamped templates and crashed partial builds age out too.
    expect(
      (
        await pruneStaleSharedTestTemplates(root, {
          prefix,
          keep: name("f_kept"),
          now: later(8 * DAY),
        })
      ).sort(),
    ).toEqual([name("c_unstamped"), name("d_partial")]);

    expect(await remaining()).toEqual([
      { name: name("a_recent"), template: true },
      { name: name("e_connected"), template: true },
      { name: name("f_kept"), template: true },
    ]);
  });
});
