import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContractParseError,
  type ContractRegistration,
  availableProbeName,
  declaredIdentifiers,
  parseContractRegistration,
  parseForwardMigrations,
  parseLedgerPaths,
  probeName,
  registrationFixLines,
  unregisteredMigrations,
} from "./migration-schema-contract";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function run(cwd: string, command: string[]) {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
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
 * A miniature contract with all three registration sites the real one has: the
 * two forward lists, the `completeSourceContract` presence probes that feed
 * `fileCount`, and the `latestMigration` chain in the same assertion. A test
 * registers a migration at any subset of them, so partial registration - the
 * shape that still lands main red - is reproducible.
 */
function miniContract(sites: {
  forward?: readonly string[];
  probes?: readonly string[];
  pins?: readonly string[];
  ladder?: readonly string[];
}): string {
  return [
    'import { describe, expect, test } from "bun:test";',
    'describe("release schema contract", () => {',
    '  test("preserves published host-export history", () => {',
    "    const companyBrainMigrationPaths = [",
    '      "0238_goal_persistence_policy.sql",',
    "    ].filter((path) => paths.has(path));",
    "    const appendedMigrationPaths = [",
    ...(sites.forward ?? []).map((file) => `      "${file}",`),
    "    ].filter((path) => paths.has(path));",
    ...(sites.probes ?? []).flatMap((file) => [
      `    const ${probeName(file)} = completeSourceContract.migrations.some(`,
      `      (migration) => migration.path === "${file}",`,
      "    );",
    ]),
    "    const baselineProbe = completeSourceContract.migrations.some(",
    '      (migration) => migration.path === "0002_second.sql",',
    "    );",
    "    expect(completeSourceContract).toMatchObject({",
    "      fileCount: 2 + (baselineProbe ? 1 : 0),",
    ...(sites.pins ?? []).map((file) => `      latestMigration: "${file}",`),
    '      latestMigration: "0002_second.sql",',
    "    });",
    '    const laterPin = "0004_later.sql";',
    "    const releaseSchemaContractHash = (includesActivation: boolean): string | null => {",
    ...(sites.ladder ?? []).flatMap((file) => [
      `      if (migrations.has("${file}")) {`,
      '        return includesActivation ? "aa" : "bb";',
      "      }",
    ]),
    "      return null;",
    "    };",
    "    void companyBrainMigrationPaths;",
    "    void appendedMigrationPaths;",
    "    void releaseSchemaContractHash;",
    "    void laterPin;",
    "  });",
    "});",
    "",
  ].join("\n");
}

/** Registers a migration at every site, i.e. what a correct pull request does. */
function fullyRegistered(files: readonly string[]) {
  return { forward: files, probes: files, pins: files };
}

function registration(sites: Parameters<typeof miniContract>[0]): ContractRegistration {
  return parseContractRegistration(miniContract(sites));
}

/**
 * A repository shaped like OpenGeni: a protected `origin/main` ledger plus a
 * branch that adds migrations and registers them at whichever sites the test
 * chooses.
 */
async function fixtureRepo(options: {
  added: readonly string[];
  sites: Parameters<typeof miniContract>[0];
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migration-schema-contract-"));
  scratch.push(dir);
  const upstream = join(dir, "upstream.git");
  const root = join(dir, "work");
  await mkdir(join(root, "packages/db/drizzle"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "test");
  for (const file of ["0001_first.sql", "0002_second.sql"]) {
    await writeFile(join(root, "packages/db/drizzle", file), "-- deployment-mode: rolling\n");
  }
  await writeFile(join(root, "scripts/release-schema-contract.test.ts"), miniContract({}));
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");
  await git(root, "clone", "-q", "--bare", root, upstream);
  await git(root, "remote", "add", "origin", upstream);
  await git(root, "fetch", "-q", "origin");
  await git(root, "checkout", "-q", "-b", "feature");
  for (const file of options.added) {
    await writeFile(join(root, "packages/db/drizzle", file), "-- deployment-mode: rolling\n");
  }
  await writeFile(
    join(root, "scripts/release-schema-contract.test.ts"),
    miniContract(options.sites),
  );
  await git(root, "add", "-A");
  // `--allow-empty`: the no-migration-added case leaves the tree identical to the
  // base, and that case is exactly what the guard must stay quiet about.
  await git(root, "commit", "-q", "--allow-empty", "-m", "feature");
  return root;
}

describe("release-schema registration rule", () => {
  const base = { ref: "origin/main", files: ["0001_first.sql", "0002_second.sql"] };
  const head = ["0001_first.sql", "0002_second.sql", "0003_new.sql"];

  test("reports a migration this head adds that is registered nowhere", () => {
    expect(unregisteredMigrations(head, base, registration({}))).toEqual([
      {
        file: "0003_new.sql",
        missing: ["forward-list", "file-count-probe", "latest-migration-pin"],
        absentFrom: "origin/main",
      },
    ]);
  });

  /**
   * The defect that made the first version of this guard useless in practice:
   * `fileCount` and `latestMigration` pin the UNFILTERED ledger, so the forward
   * list alone leaves the contract test red.
   */
  test("still reports a migration registered only in the forward list", () => {
    expect(unregisteredMigrations(head, base, registration({ forward: ["0003_new.sql"] }))).toEqual(
      [
        {
          file: "0003_new.sql",
          missing: ["file-count-probe", "latest-migration-pin"],
          absentFrom: "origin/main",
        },
      ],
    );
  });

  test("still reports a migration missing only the latest-migration pin", () => {
    expect(
      unregisteredMigrations(
        head,
        base,
        registration({ forward: ["0003_new.sql"], probes: ["0003_new.sql"] }),
      ).map((violation) => violation.missing),
    ).toEqual([["latest-migration-pin"]]);
  });

  test("accepts a migration registered at every site", () => {
    expect(
      unregisteredMigrations(head, base, registration(fullyRegistered(["0003_new.sql"]))),
    ).toEqual([]);
  });

  test("accepts registration through the legacy Company Brain list", () => {
    const sites = fullyRegistered(["0238_goal_persistence_policy.sql"]);
    expect(
      unregisteredMigrations(
        ["0001_first.sql", "0002_second.sql", "0238_goal_persistence_policy.sql"],
        base,
        registration({ probes: sites.probes, pins: sites.pins }),
      ),
    ).toEqual([]);
  });

  test("never reports a migration the base already carries", () => {
    expect(
      unregisteredMigrations(["0001_first.sql", "0002_second.sql"], base, registration({})),
    ).toEqual([]);
  });

  /**
   * The base is the single branch this head targets. A migration that exists
   * only on `origin/production` genuinely IS a new addition to `main` when it
   * is forward-ported, so it must still be registered for main's contract.
   */
  test("reports a migration inherited from another protected branch but new to this base", () => {
    expect(
      unregisteredMigrations(
        ["0001_first.sql", "0002_hotfix.sql"],
        { ref: "origin/main", files: ["0001_first.sql"] },
        registration({}),
      ).map((violation) => violation.file),
    ).toEqual(["0002_hotfix.sql"]);
  });

  test("reports every unregistered migration in ledger order", () => {
    expect(
      unregisteredMigrations(
        ["0004_beta.sql", "0003_alpha.sql", "0001_first.sql", "0002_second.sql"],
        base,
        registration({}),
      ).map((violation) => violation.file),
    ).toEqual(["0003_alpha.sql", "0004_beta.sql"]);
  });

  test("reports an off-convention SQL file, which still moves the pins", () => {
    expect(
      unregisteredMigrations(
        ["0001_first.sql", "0002_second.sql", "custom_probe.sql"],
        base,
        registration({}),
      ).map((violation) => violation.file),
    ).toEqual(["custom_probe.sql"]);
  });
});

describe("release-schema contract parsing", () => {
  test("reads both forward-migration lists", () => {
    expect(
      parseForwardMigrations(miniContract({ forward: ["0003_new.sql", "0004_next.sql"] })),
    ).toEqual(["0238_goal_persistence_policy.sql", "0003_new.sql", "0004_next.sql"]);
  });

  test("reads the file-count probes and the latest-migration pins", () => {
    const parsed = registration({ probes: ["0003_new.sql"], pins: ["0004_next.sql"] });
    expect(parsed.fileCountProbes).toEqual(["0003_new.sql", "0002_second.sql"]);
    expect(parsed.latestMigrationPins).toEqual(["0004_next.sql", "0002_second.sql"]);
  });

  test("a commented-out entry does not count as registered", () => {
    const commented = miniContract({ forward: ["0003_new.sql"] }).replace(
      '      "0003_new.sql",',
      '      // "0003_new.sql",',
    );
    expect(parseForwardMigrations(commented)).toEqual(["0238_goal_persistence_policy.sql"]);
  });

  test("fails loudly when the contract no longer declares the forward list", () => {
    const renamed = miniContract({ forward: ["0003_new.sql"] }).replace(
      "const appendedMigrationPaths = [",
      "const forwardMigrationEntries = [",
    );
    expect(() => parseForwardMigrations(renamed)).toThrow(ContractParseError);
    expect(() => parseForwardMigrations(renamed)).toThrow("appendedMigrationPaths");
  });

  test("fails loudly when the complete-contract assertion is gone", () => {
    const renamed = miniContract({}).replace(
      "expect(completeSourceContract).toMatchObject({",
      "expect(someOtherContract).toMatchObject({",
    );
    expect(() => parseContractRegistration(renamed)).toThrow(ContractParseError);
  });

  test("fails loudly when no presence probe remains", () => {
    const stripped = miniContract({}).replace(
      "completeSourceContract.migrations.some(",
      "otherContract.migrations.some(",
    );
    expect(() => parseContractRegistration(stripped)).toThrow(ContractParseError);
  });

  test("fails loudly when both forward lists are empty rather than reporting everything", () => {
    const emptied = miniContract({}).replace('      "0238_goal_persistence_policy.sql",\n', "");
    expect(() => parseForwardMigrations(emptied)).toThrow(ContractParseError);
  });

  /**
   * The probe is recognised by shape, not by house style. Rejecting a probe the
   * contract itself accepts is the one case where the guard would be wrong
   * about a correct tree.
   */
  test.each([
    ["renamed callback parameter", "(m) => m.path"],
    ["typed callback parameter", "(migration: Migration) => migration.path"],
  ])("recognises a file-count probe with a %s", (_label, callback) => {
    const rewritten = miniContract({ probes: ["0003_new.sql"] }).replace(
      "(migration) => migration.path",
      callback,
    );
    expect(parseContractRegistration(rewritten).fileCountProbes).toContain("0003_new.sql");
  });

  /**
   * A bare depth counter desyncs on a brace inside a string and over-runs the
   * end of the assertion, silently widening what counts as registered. That is
   * the only direction this parser must never fail in.
   */
  test("a brace inside a string does not widen the assertion region", () => {
    const contract = miniContract({ pins: ["0003_new.sql"] });
    const withBrace = contract.replace(
      '      latestMigration: "0002_second.sql",',
      '      note: "unbalanced { brace",\n      latestMigration: "0002_second.sql",',
    );
    // `0004_later.sql` is named only AFTER the assertion, so an over-running
    // scan is exactly what would pick it up as a pin.
    expect(withBrace.indexOf("0004_later.sql")).toBeGreaterThan(
      withBrace.indexOf("latestMigration"),
    );
    expect(parseContractRegistration(withBrace).latestMigrationPins).not.toContain(
      "0004_later.sql",
    );
  });

  test("suggests a const name that is neither reserved nor already declared", () => {
    expect(availableProbeName("0342_new.sql")).toBe("newMigration");
    expect(availableProbeName("0342_eval.sql")).toBe("evalMigration");
    expect(availableProbeName("0342_migrations.sql", new Set(["migrations"]))).toBe("migrations2");
    expect(availableProbeName("0342_migrations.sql", new Set(["migrations", "migrations2"]))).toBe(
      "migrations3",
    );
  });

  test("reads the identifiers the contract already declares", () => {
    const declared = declaredIdentifiers(miniContract({}));
    expect(declared.has("appendedMigrationPaths")).toBe(true);
    expect(declared.has("baselineProbe")).toBe(true);
  });

  test("parses a git ls-tree listing into bare SQL file names", () => {
    expect(
      parseLedgerPaths(
        [
          "packages/db/drizzle/0002_second.sql",
          "packages/db/drizzle/0001_first.sql",
          "packages/db/drizzle/custom_probe.sql",
          "packages/db/drizzle/meta",
          "",
        ].join("\n"),
      ),
    ).toEqual(["0001_first.sql", "0002_second.sql", "custom_probe.sql"]);
  });

  test("the fix text names every missing site and refuses the ladder-pin repair", () => {
    const text = registrationFixLines([
      {
        file: "0003_new.sql",
        missing: ["forward-list", "file-count-probe", "latest-migration-pin"],
        absentFrom: "origin/main",
      },
    ]).join("\n");
    expect(text).toContain('      "0003_new.sql",');
    expect(text).toContain("appendedMigrationPaths");
    expect(text).toContain("const newMigration = completeSourceContract.migrations.some(");
    expect(text).toContain("latestMigration: newMigration");
    expect(text).toContain("Do NOT instead pin a fresh hash");
  });

  test("the fix text omits a site that is already registered", () => {
    const text = registrationFixLines([
      { file: "0003_new.sql", missing: ["latest-migration-pin"], absentFrom: "origin/main" },
    ]).join("\n");
    expect(text).not.toContain("appendedMigrationPaths`, at the end");
    expect(text).toContain("latestMigration: newMigration");
  });
});

describe("check-migration-schema-contract CLI", () => {
  const guard = [
    "bun",
    join(import.meta.dir, "check-migration-schema-contract.ts"),
    "--base",
    "origin/main",
  ];

  test("fails on an unregistered migration and passes once every site names it", async () => {
    const unregistered = await fixtureRepo({ added: ["0003_new.sql"], sites: {} });
    const before = await run(unregistered, guard);
    expect(before.code).toBe(1);
    expect(before.stderr).toContain("1 new migration is not fully registered");
    expect(before.stderr).toContain(
      "- 0003_new.sql  (missing: forward-list, file-count-probe, latest-migration-pin)",
    );
    expect(before.stderr).toContain('      "0003_new.sql",');

    const registered = await fixtureRepo({
      added: ["0003_new.sql"],
      sites: fullyRegistered(["0003_new.sql"]),
    });
    const after = await run(registered, guard);
    expect(after.stderr).toBe("");
    expect(after.code).toBe(0);
    expect(after.stdout).toContain("[migration-schema-contract] ok");
  });

  /**
   * The forward list alone is what the first version of this guard accepted,
   * and it leaves `fileCount` and `latestMigration` red on merged main.
   */
  test("a forward-list entry alone is not accepted as registration", async () => {
    const root = await fixtureRepo({
      added: ["0003_new.sql"],
      sites: { forward: ["0003_new.sql"] },
    });
    const result = await run(root, guard);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "- 0003_new.sql  (missing: file-count-probe, latest-migration-pin)",
    );
    expect(result.stderr).not.toContain("1. Add to `appendedMigrationPaths`");
  });

  /**
   * The regression that reached main twice: the author repaired the contract by
   * pinning a fresh checkpoint hash for their own migration instead of
   * registering it. That is green on the branch and stale the moment another
   * migration merges first.
   */
  test("a fresh ladder pin for the new migration is not accepted as registration", async () => {
    const root = await fixtureRepo({
      added: ["0003_new.sql"],
      sites: { ladder: ["0003_new.sql"] },
    });
    const result = await run(root, guard);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("- 0003_new.sql");
    expect(result.stderr).toContain("Do NOT instead pin a fresh hash");
  });

  /**
   * `listLedger` matches every top-level `*.sql`, like the contract generator,
   * rather than the stricter `NNNN_slug.sql` shape. Exercised through the CLI
   * because the pure-function cases bypass `listLedger` entirely.
   */
  test("reports an off-convention SQL file the contract would still hash", async () => {
    const root = await fixtureRepo({ added: ["custom_probe.sql", "0003_bad-name.sql"], sites: {} });
    const result = await run(root, guard);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("- 0003_bad-name.sql");
    expect(result.stderr).toContain("- custom_probe.sql");
  });

  test("stays quiet when the head adds no migration at all", async () => {
    const root = await fixtureRepo({ added: [], sites: {} });
    const result = await run(root, guard);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[migration-schema-contract] ok");
  });

  test("fails closed when the base ref cannot be read", async () => {
    const root = await fixtureRepo({
      added: ["0003_new.sql"],
      sites: fullyRegistered(["0003_new.sql"]),
    });
    const result = await run(root, [
      "bun",
      join(import.meta.dir, "check-migration-schema-contract.ts"),
      "--base",
      "origin/does-not-exist",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot read packages/db/drizzle at origin/does-not-exist");
  });
});
