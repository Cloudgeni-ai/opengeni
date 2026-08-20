import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findOrdinalCollisions,
  nextFreeOrdinal,
  parseHashMismatch,
  parseLsTree,
  parseMigrationFile,
  planRenumber,
  resolveMigration,
  rewriteText,
} from "./migration-ordinals";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function name(file: string) {
  const parsed = parseMigrationFile(file);
  if (!parsed) throw new Error(`bad fixture name ${file}`);
  return parsed;
}

async function run(cwd: string, command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function git(cwd: string, ...args: string[]) {
  const result = await run(cwd, ["git", ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * A miniature repository shaped like OpenGeni: a `main` ledger, then a branch
 * that adds a migration whose ordinal main has meanwhile taken. Returns the
 * branch worktree path.
 */
async function fixtureRepo(): Promise<{ root: string; upstream: string }> {
  const dir = await mkdtemp(join(tmpdir(), "migration-ordinals-"));
  scratch.push(dir);
  const upstream = join(dir, "upstream.git");
  const root = join(dir, "work");
  await mkdir(root, { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "test");
  await mkdir(join(root, "packages/db/drizzle"), { recursive: true });
  await mkdir(join(root, "packages/db/test"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "packages/db/drizzle/0001_first.sql"),
    "-- deployment-mode: rolling\nselect 1;\n",
  );
  await writeFile(
    join(root, "packages/db/drizzle/0002_second.sql"),
    "-- deployment-mode: rolling\nselect 2;\n",
  );
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");
  await git(root, "clone", "-q", "--bare", root, upstream);
  await git(root, "remote", "add", "origin", upstream);
  await git(root, "fetch", "-q", "origin");
  // Branch adds 0003_scheduled_authority; main later merges 0003_company_brain.
  await git(root, "checkout", "-q", "-b", "feature");
  await writeFile(
    join(root, "packages/db/drizzle/0003_scheduled_authority.sql"),
    "-- deployment-mode: maintenance\n-- 0003 requires drained runs (see 0002/0003 receipts)\nselect 3;\n",
  );
  await writeFile(
    join(root, "packages/db/test/migration-0003-scheduled-authority.test.ts"),
    [
      'import { test } from "bun:test";',
      'const migrationUrl = new URL("../drizzle/0003_scheduled_authority.sql", import.meta.url);',
      'const files = ["a.sql"].filter((file) => file < "0003_");',
      'test("migration 0003 scheduled authority", () => { void migrationUrl; void files; });',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "packages/db/test/migration-0002-second.test.ts"),
    'const withheld = ["0003_scheduled_authority.sql"]; // stamped with 0002\nexport {};\n',
  );
  await writeFile(
    join(root, "docs/notes.md"),
    "Migration 0003 is a maintenance cutover; canonical `0003_scheduled_authority.sql`. Migration 0002 is rolling.\n",
  );
  await writeFile(
    join(root, "docs/other.md"),
    "Migration 0003 applies the fallback (unrelated feature).\n",
  );
  // A miniature release contract: one per-file pin and one chain pin computed
  // like the real one (sorted names + bytes), so the re-pin loop is exercised
  // end to end against real `bun test` failure output.
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts/release-schema-contract.test.ts"), MINI_CONTRACT_TEST);
  await pinMiniContract(root);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "feature");
  // Main advances with a different 0003 and a companion test sharing the digits.
  await git(root, "checkout", "-q", "main");
  await mkdir(join(root, "packages/db/test"), { recursive: true });
  await writeFile(
    join(root, "packages/db/drizzle/0003_company_brain.sql"),
    "-- deployment-mode: rolling\nselect 33;\n",
  );
  await writeFile(
    join(root, "packages/db/test/migration-0003-company-brain.test.ts"),
    'import { test } from "bun:test";\ntest("migration 0003 company brain", () => {\n  void "0003_company_brain.sql";\n});\n',
  );
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "main advances");
  await git(root, "push", "-q", "origin", "main");
  await git(root, "checkout", "-q", "feature");
  await git(root, "fetch", "-q", "origin");
  return { root, upstream };
}

const MINI_CONTRACT_TEST = [
  'import { expect, test } from "bun:test";',
  'import { createHash } from "node:crypto";',
  'import { readdirSync, readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "",
  'const dir = join(import.meta.dir, "../packages/db/drizzle");',
  'const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();',
  "const perFile = new Map(",
  '  files.map((f) => [f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")]),',
  ");",
  'const chain = createHash("sha256")',
  '  .update(files.map((f) => `${f}:${perFile.get(f)}`).join("\\n"))',
  '  .digest("hex");',
  "",
  'test("pins the newest migration and the chain", () => {',
  "  const newest = files.at(-1)!;",
  "  expect({ path: newest, sha256: perFile.get(newest) }).toMatchObject({",
  '    path: "0003_scheduled_authority.sql",',
  '    sha256: "PERFILE",',
  "  });",
  '  expect(chain).toBe("CHAIN");',
  "});",
  "",
].join("\n");

/** Pin the mini contract to the current migration bytes (like a maintainer would). */
async function pinMiniContract(root: string): Promise<void> {
  const dir = join(root, "packages/db/drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const perFile = new Map(
    files.map((f) => [
      f,
      createHash("sha256")
        .update(readFileSync(join(dir, f)))
        .digest("hex"),
    ]),
  );
  const chain = createHash("sha256")
    .update(files.map((f) => `${f}:${perFile.get(f)}`).join("\n"))
    .digest("hex");
  const path = join(root, "scripts/release-schema-contract.test.ts");
  const text = await readFile(path, "utf8");
  await writeFile(
    path,
    text
      .replace(/sha256: "[0-9a-fA-Z_]+"/, `sha256: "${perFile.get(files.at(-1)!)}"`)
      .replace(/toBe\("[0-9a-fA-Z_]+"\)/, `toBe("${chain}")`),
  );
}

describe("migration ordinal helpers", () => {
  test("parses names, ledgers, and next free ordinal across ledgers", () => {
    expect(parseMigrationFile("packages/db/drizzle/9871_alpha_widgets.sql")).toEqual({
      ordinal: "9871",
      slug: "alpha_widgets",
      basename: "9871_alpha_widgets",
      file: "9871_alpha_widgets.sql",
    });
    expect(parseMigrationFile("meta/_journal.json")).toBeNull();
    const base = parseLsTree(
      "packages/db/drizzle/9871_beta_gadgets.sql\npackages/db/drizzle/meta/_journal.json\npackages/db/drizzle/9870_x.sql\n",
    );
    expect(base.map((m) => m.file)).toEqual(["9870_x.sql", "9871_beta_gadgets.sql"]);
    expect(nextFreeOrdinal(base, [name("9872_local.sql")])).toBe("9873");
    expect(nextFreeOrdinal([], [])).toBe("0000");
  });

  test("resolves selectors exactly and reports ambiguity", () => {
    const local = [name("9871_a.sql"), name("9871_b.sql"), name("9872_c.sql")];
    expect(resolveMigration(local, "9872").file).toBe("9872_c.sql");
    expect(resolveMigration(local, "9871_b").file).toBe("9871_b.sql");
    expect(resolveMigration(local, "packages/db/drizzle/9871_a.sql").file).toBe("9871_a.sql");
    expect(() => resolveMigration(local, "9871")).toThrow(/ambiguous/);
    expect(() => resolveMigration(local, "0299")).toThrow(/no migration/);
  });

  test("detects head ordinals already taken on the base and local duplicates", () => {
    const base = [name("9870_x.sql"), name("9871_beta_gadgets.sql")];
    const head = [
      name("9870_x.sql"),
      name("9871_scheduled.sql"),
      name("9872_a.sql"),
      name("9872_b.sql"),
    ];
    expect(findOrdinalCollisions(head, base)).toEqual({
      collisions: [
        { headFile: "9871_scheduled.sql", baseFile: "9871_beta_gadgets.sql", ordinal: "9871" },
      ],
      duplicates: [["9872_a.sql", "9872_b.sql"]],
    });
    // Same file on both sides is never a collision, and duplicates that already
    // exist on the base (the historical ledger has many) are not reported.
    const historical = [name("0024_a.sql"), name("0024_b.sql")];
    expect(findOrdinalCollisions(historical, historical)).toEqual({
      collisions: [],
      duplicates: [],
    });
    expect(findOrdinalCollisions([...historical, name("0025_new.sql")], historical)).toEqual({
      collisions: [],
      duplicates: [],
    });
  });

  test("rewrites the basename, companion slug, and bare ordinal without touching neighbours", () => {
    const from = name("9871_alpha_widgets.sql");
    const to = name("9872_alpha_widgets.sql");
    const companions = ["migration-9871-alpha-widgets.test.ts"];
    const text = [
      'const url = "../drizzle/9871_alpha_widgets.sql";',
      'const other = "9871_beta_gadgets.sql";',
      'const otherTest = "migration-9871-beta-gadgets.test.ts";',
      'const ownTest = "migration-9871-alpha-widgets";',
      "-- 9871 requires drain; see 9852/9871; version 19871; x9871y",
      'const filter = file < "9871_";',
    ].join("\n");
    const result = rewriteText(text, from, to, companions, { bareOrdinal: true });
    expect(result.text).toBe(
      [
        'const url = "../drizzle/9872_alpha_widgets.sql";',
        'const other = "9871_beta_gadgets.sql";',
        'const otherTest = "migration-9871-beta-gadgets.test.ts";',
        'const ownTest = "migration-9872-alpha-widgets";',
        "-- 9872 requires drain; see 9852/9872; version 19871; x9871y",
        'const filter = file < "9872_";',
      ].join("\n"),
    );
    expect(result.replacements).toBe(2);
    expect(result.bareOrdinal).toBe(3);
    expect(rewriteText(text, from, to, companions, { bareOrdinal: false }).bareOrdinal).toBe(0);
  });

  test("plans renames and edits over a repo view, leaving unrelated ordinal mentions alone", () => {
    const from = name("0003_scheduled_authority.sql");
    const files = new Map<string, string>([
      [
        "packages/db/drizzle/0003_scheduled_authority.sql",
        "-- 0003 requires drained runs\nselect 3;\n",
      ],
      [
        "packages/db/test/migration-0003-scheduled-authority.test.ts",
        'new URL("../drizzle/0003_scheduled_authority.sql"); "0003"',
      ],
      [
        "packages/db/test/migration-0002-second.test.ts",
        '["0003_scheduled_authority.sql"] // stamped with 0002',
      ],
      ["docs/notes.md", "Migration 0003 is a cutover; `0003_scheduled_authority.sql`."],
      ["docs/other.md", "Migration 0003 applies the fallback (unrelated)."],
      ["node_modules/x/0003_scheduled_authority.sql", "ignored"],
    ]);
    const plan = planRenumber({
      from,
      toOrdinal: "0004",
      files,
      companionTests: ["packages/db/test/migration-0003-scheduled-authority.test.ts"],
    });
    expect(plan.to.file).toBe("0004_scheduled_authority.sql");
    expect(plan.renames).toEqual([
      {
        from: "packages/db/drizzle/0003_scheduled_authority.sql",
        to: "packages/db/drizzle/0004_scheduled_authority.sql",
      },
      {
        from: "packages/db/test/migration-0003-scheduled-authority.test.ts",
        to: "packages/db/test/migration-0004-scheduled-authority.test.ts",
      },
    ]);
    expect(plan.edits.map((edit) => edit.path)).toEqual([
      "docs/notes.md",
      "packages/db/drizzle/0004_scheduled_authority.sql",
      "packages/db/test/migration-0002-second.test.ts",
      "packages/db/test/migration-0004-scheduled-authority.test.ts",
    ]);
    expect(plan.contents.get("docs/notes.md")).toBe(
      "Migration 0004 is a cutover; `0004_scheduled_authority.sql`.",
    );
    expect(plan.contents.get("packages/db/drizzle/0004_scheduled_authority.sql")).toBe(
      "-- 0004 requires drained runs\nselect 3;\n",
    );
    expect(plan.contents.get("packages/db/test/migration-0002-second.test.ts")).toBe(
      '["0004_scheduled_authority.sql"] // stamped with 0002',
    );
    expect(plan.contents.has("docs/other.md")).toBe(false);
    expect(plan.unrewrittenBare).toEqual(["docs/other.md"]);
    const widened = planRenumber({
      from,
      toOrdinal: "0004",
      files,
      companionTests: ["packages/db/test/migration-0003-scheduled-authority.test.ts"],
      alsoBare: ["docs/other.md"],
    });
    expect(widened.contents.get("docs/other.md")).toBe(
      "Migration 0004 applies the fallback (unrelated).",
    );
    expect(widened.unrewrittenBare).toEqual([]);
  });

  test("only exact SHA-256 Expected/Received pairs count as re-pinnable mismatches", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(parseHashMismatch(`Expected: "${a}"\nReceived: "${b}"`)).toEqual({
      expected: a,
      received: b,
    });
    expect(
      parseHashMismatch(`Expected: {\n  sha256: "${a}",\n}\nReceived: {\n  sha256: "${b}",\n}`),
    ).toEqual({
      expected: a,
      received: b,
    });
    expect(
      parseHashMismatch(
        `@@ -2,3 +2,4 @@\n    "deploymentMode": "maintenance",\n-   "sha256": "${a}",\n+   "path": "x.sql",\n+   "sha256": "${b}",\n`,
      ),
    ).toEqual({ expected: a, received: b });
    expect(parseHashMismatch('Expected: "9871_x.sql"\nReceived: "9872_x.sql"')).toBeNull();
    expect(parseHashMismatch("Expected length: 5\nReceived length: 6")).toBeNull();
    // Pairs are only taken when adjacent inside one failure block: an Expected
    // hash with a non-hash Received must not pair with a later block.
    expect(
      parseHashMismatch(
        `Expected: "${a}"\nReceived: undefined\n\n(fail) one\n\nExpected: "9871_x.sql"\nReceived: "${b}"\n`,
      ),
    ).toBeNull();
  });
});

describe("migration ordinal CLIs", () => {
  const scripts = import.meta.dir;

  test("check-migration-ordinals fails on a collision with the base and passes after renumbering", async () => {
    const { root } = await fixtureRepo();
    const guard = ["bun", join(scripts, "check-migration-ordinals.ts"), "--base", "origin/main"];
    const before = await run(root, guard);
    expect(before.code).toBe(1);
    expect(before.stderr).toContain(
      "ordinal 0003 of 0003_scheduled_authority.sql is already used on origin/main by 0003_company_brain.sql",
    );
    expect(before.stderr).toContain(
      "bun scripts/renumber-migration.ts 0003_scheduled_authority --next   (next free ordinal: 0004)",
    );

    const renumber = await run(root, [
      "bun",
      join(scripts, "renumber-migration.ts"),
      "0003_scheduled_authority",
      "--next",
      "--base",
      "origin/main",
    ]);
    expect(renumber.stderr).toBe("");
    expect(renumber.code).toBe(0);
    expect(renumber.stdout).toContain(
      "renumber 0003_scheduled_authority.sql -> 0004_scheduled_authority.sql",
    );
    // The mini release contract was re-pinned (per-file + chain) and is green.
    expect(renumber.stdout).toMatch(/repin +scripts\/release-schema-contract\.test\.ts/);
    const contract = await run(root, ["bun", "test", "scripts/release-schema-contract.test.ts"]);
    expect(contract.code).toBe(0);
    expect(await readFile(join(root, "scripts/release-schema-contract.test.ts"), "utf8")).toContain(
      'path: "0004_scheduled_authority.sql"',
    );
    expect(existsSync(join(root, "packages/db/drizzle/0004_scheduled_authority.sql"))).toBe(true);
    expect(existsSync(join(root, "packages/db/drizzle/0003_scheduled_authority.sql"))).toBe(false);
    expect(
      existsSync(join(root, "packages/db/test/migration-0004-scheduled-authority.test.ts")),
    ).toBe(true);
    expect(
      await readFile(join(root, "packages/db/drizzle/0004_scheduled_authority.sql"), "utf8"),
    ).toBe(
      "-- deployment-mode: maintenance\n-- 0004 requires drained runs (see 0002/0004 receipts)\nselect 3;\n",
    );
    expect(
      await readFile(
        join(root, "packages/db/test/migration-0004-scheduled-authority.test.ts"),
        "utf8",
      ),
    ).toContain('new URL("../drizzle/0004_scheduled_authority.sql", import.meta.url)');
    expect(
      await readFile(
        join(root, "packages/db/test/migration-0004-scheduled-authority.test.ts"),
        "utf8",
      ),
    ).toContain('file < "0004_"');
    expect(
      await readFile(join(root, "packages/db/test/migration-0002-second.test.ts"), "utf8"),
    ).toBe('const withheld = ["0004_scheduled_authority.sql"]; // stamped with 0002\nexport {};\n');
    expect(await readFile(join(root, "docs/notes.md"), "utf8")).toBe(
      "Migration 0004 is a maintenance cutover; canonical `0004_scheduled_authority.sql`. Migration 0002 is rolling.\n",
    );
    // A file that mentions the digits for an unrelated migration is untouched.
    expect(await readFile(join(root, "docs/other.md"), "utf8")).toBe(
      "Migration 0003 applies the fallback (unrelated feature).\n",
    );
    // Renames stay git-tracked renames.
    const status = await git(root, "status", "--porcelain");
    expect(status).toMatch(
      /^R[ M] packages\/db\/drizzle\/0003_scheduled_authority\.sql -> packages\/db\/drizzle\/0004_scheduled_authority\.sql$/m,
    );

    const after = await run(root, guard);
    expect(after.code).toBe(0);
    expect(after.stdout).toContain("[migration-ordinals] ok");
  });

  test("check-migration-ordinals also fails closed against origin/production", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-ordinals-production-"));
    scratch.push(dir);
    const upstream = join(dir, "upstream.git");
    const root = join(dir, "work");
    await mkdir(root, { recursive: true });
    await git(root, "init", "-q", "-b", "main");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "test");
    await mkdir(join(root, "packages/db/drizzle"), { recursive: true });
    await writeFile(
      join(root, "packages/db/drizzle/0001_first.sql"),
      "-- deployment-mode: rolling\nselect 1;\n",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "base");
    await git(root, "clone", "-q", "--bare", root, upstream);
    await git(root, "remote", "add", "origin", upstream);
    await git(root, "push", "-q", "origin", "HEAD:refs/heads/production");
    await writeFile(
      join(root, "packages/db/drizzle/0002_main.sql"),
      "-- deployment-mode: rolling\nselect 2;\n",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "main took 0002");
    await git(root, "push", "-q", "origin", "HEAD:refs/heads/main");
    await git(root, "fetch", "-q", "origin");
    await git(root, "checkout", "-q", "-b", "hotfix/ordinal", "origin/production");
    await writeFile(
      join(root, "packages/db/drizzle/0002_hotfix.sql"),
      "-- deployment-mode: rolling\nselect 22;\n",
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "hotfix took 0002");

    const againstProduction = await run(root, [
      "bun",
      join(scripts, "check-migration-ordinals.ts"),
      "--base",
      "origin/production",
    ]);
    expect(againstProduction.code).toBe(1);
    expect(againstProduction.stderr).toContain(
      "ordinal 0002 of 0002_hotfix.sql is already used on origin/main by 0002_main.sql",
    );
  });

  test("after merging main, only this migration's companion is renamed and the sibling is untouched", async () => {
    const { root } = await fixtureRepo();
    await git(root, "merge", "-q", "--no-edit", "origin/main");
    // Both 0003_scheduled_authority.sql and 0003_company_brain.sql now coexist locally.
    const renumber = await run(root, [
      "bun",
      join(scripts, "renumber-migration.ts"),
      "0003_scheduled_authority",
      "--next",
      "--base",
      "origin/main",
      "--no-refresh-release-contract",
    ]);
    expect(renumber.stderr).toBe("");
    expect(renumber.code).toBe(0);
    expect(existsSync(join(root, "packages/db/drizzle/0004_scheduled_authority.sql"))).toBe(true);
    expect(existsSync(join(root, "packages/db/drizzle/0003_company_brain.sql"))).toBe(true);
    expect(existsSync(join(root, "packages/db/test/migration-0003-company-brain.test.ts"))).toBe(
      true,
    );
    expect(
      await readFile(join(root, "packages/db/test/migration-0003-company-brain.test.ts"), "utf8"),
    ).toContain('test("migration 0003 company brain"');
    expect(
      existsSync(join(root, "packages/db/test/migration-0004-scheduled-authority.test.ts")),
    ).toBe(true);
  });

  test("--to refuses to fill a gap below the ledger head unless --allow-gap", async () => {
    const { root } = await fixtureRepo();
    // 0002 is taken; 0000 is a free gap below the head.
    const gap = await run(root, [
      "bun",
      join(scripts, "renumber-migration.ts"),
      "0003_scheduled_authority",
      "--to",
      "0000",
      "--base",
      "origin/main",
    ]);
    expect(gap.code).toBe(1);
    expect(gap.stderr).toContain("below the ledger head");
    const allowed = await run(root, [
      "bun",
      join(scripts, "renumber-migration.ts"),
      "0003_scheduled_authority",
      "--to",
      "0000",
      "--base",
      "origin/main",
      "--allow-gap",
      "--no-refresh-release-contract",
    ]);
    expect(allowed.code).toBe(0);
    expect(existsSync(join(root, "packages/db/drizzle/0000_scheduled_authority.sql"))).toBe(true);
  });

  test("renumber refuses a taken target, dry-run writes nothing, and untracked files are renamed", async () => {
    const { root } = await fixtureRepo();
    const taken = await run(root, [
      "bun",
      join(scripts, "renumber-migration.ts"),
      "0003_scheduled_authority",
      "--to",
      "0003",
      "--base",
      "origin/main",
    ]);
    expect(taken.code).toBe(1);
    expect(taken.stderr).toContain("already used on origin/main by 0003_company_brain.sql");

    const dry = await run(root, [
      "bun",
      join(scripts, "renumber-migration.ts"),
      "0003",
      "--next",
      "--base",
      "origin/main",
      "--dry-run",
    ]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("dry run: nothing written");
    expect(existsSync(join(root, "packages/db/drizzle/0003_scheduled_authority.sql"))).toBe(true);

    // An untracked WIP migration is renamed with a plain fs rename.
    await writeFile(
      join(root, "packages/db/drizzle/0005_wip.sql"),
      "-- deployment-mode: rolling\n-- 0005 wip\nselect 5;\n",
    );
    const wip = await run(root, [
      "bun",
      join(scripts, "renumber-migration.ts"),
      "0005_wip",
      "--to",
      "0009",
      "--base",
      "origin/main",
      "--no-refresh-release-contract",
    ]);
    expect(wip.code).toBe(0);
    expect(existsSync(join(root, "packages/db/drizzle/0009_wip.sql"))).toBe(true);
    expect(await readFile(join(root, "packages/db/drizzle/0009_wip.sql"), "utf8")).toContain(
      "-- 0009 wip",
    );
  });
});
