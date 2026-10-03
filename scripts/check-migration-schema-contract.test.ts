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
  parseFilteredMembershipTests,
  registrationFixLines,
  unreachableContractReferences,
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
    // The real contract always carries a ladder, and `parseFilteredMembershipTests` is
    // strict about that so a refactor cannot silently disable the audit. Give
    // every fixture a baseline rung, the same way it gets a baseline probe.
    '      if (migrations.has("0001_first.sql")) {',
    '        return includesActivation ? "cc" : "dd";',
    "      }",
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

/** Independent fixture for the executable semantic metadata contract. */
function semanticContract(forward: readonly string[] = []): string {
  return `
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildSchemaContract as buildCompleteSchemaContract } from "./release-schema-contract";
${miniContract({ forward })}
test("checks complete ledger metadata against migration files", async () => {
  const completeSourceContract = await buildCompleteSchemaContract();
  const sourceMigrationPaths = (
    await readdir(join(import.meta.dir, "../packages/db/drizzle"), { withFileTypes: true })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const contractMigrationPaths = completeSourceContract.migrations.map((migration) => migration.path);
  expect(completeSourceContract).toMatchObject({
    fileCount: sourceMigrationPaths.length,
    latestMigration: sourceMigrationPaths.at(-1) ?? null,
  });
  expect(contractMigrationPaths).toEqual(sourceMigrationPaths);
  expect(new Set(contractMigrationPaths).size).toBe(contractMigrationPaths.length);
});
`;
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
  source?: string;
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
    options.source ?? miniContract(options.sites),
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

describe("unreachable contract references", () => {
  const contract = (ladder: readonly string[], forward: readonly string[]) =>
    miniContract({ ladder, forward });

  test("reports a rung whose migration is forward-listed and present", () => {
    expect(
      unreachableContractReferences(
        contract(["0003_new.sql"], ["0003_new.sql"]),
        ["0003_new.sql"],
        ["0003_new.sql"],
      ),
    ).toEqual(["0003_new.sql"]);
  });

  test("accepts a rung whose migration is not forward-listed", () => {
    expect(
      unreachableContractReferences(contract(["0003_new.sql"], []), ["0003_new.sql"], []),
    ).toEqual([]);
  });

  /**
   * A rung for a migration this tree does not carry is an ordinary
   * compatibility rung: it fires on a branch holding fewer migrations, and the
   * check must not touch it.
   */
  test("leaves a compatibility rung for an absent migration alone", () => {
    expect(
      unreachableContractReferences(
        contract(["0003_new.sql"], ["0003_new.sql"]),
        [],
        ["0003_new.sql"],
      ),
    ).toEqual([]);
  });

  test("reads every membership test in source order", () => {
    expect(parseFilteredMembershipTests(contract(["0004_next.sql", "0003_new.sql"], []))).toEqual([
      "0001_first.sql",
      "0004_next.sql",
      "0003_new.sql",
    ]);
  });

  /**
   * The strictness is the anti-no-op guard: if a refactor removed every
   * membership test the audit would otherwise pass vacuously forever.
   */
  test("fails loudly when nothing tests the filtered set at all", () => {
    const stripped = contract(["0003_new.sql"], []).replaceAll("migrations.has(", "other.has(");
    expect(() => parseFilteredMembershipTests(stripped)).toThrow(ContractParseError);
  });

  /**
   * The `latestCompatibleMigration` shape resolves its entries through
   * `.find((path) => migrations.has(path))`, so its names are membership tests
   * too and a dead entry there is the same debris as a dead rung.
   */
  test.each([
    ["annotated find callback", ".find((path: string) => migrations.has(path))"],
    ["filter callback", ".filter((file) => migrations.has(file))"],
    ["extra-argument callback", ".find((path, index) => migrations.has(path) && index >= 0)"],
  ])("reads names resolved through an array %s", (_label, tail) => {
    const withArray = contract([], []) + `\nconst picked = ["0003_new.sql"]${tail};\n`;
    expect(parseFilteredMembershipTests(withArray)).toContain("0003_new.sql");
  });

  test("reads names resolved through a .find over migrations.has", () => {
    const withFind =
      contract([], []) +
      '\nconst latestCompatibleMigration = ["0003_new.sql"].find((path) => migrations.has(path));\n';
    expect(parseFilteredMembershipTests(withFind)).toContain("0003_new.sql");
    expect(unreachableContractReferences(withFind, ["0003_new.sql"], ["0003_new.sql"])).toEqual([
      "0003_new.sql",
    ]);
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

describe("semantic complete-ledger registration", () => {
  test("uses source semantics instead of adding per-file count/latest pins", () => {
    const parsed = parseContractRegistration(semanticContract(["0003_new.sql"]));
    expect(parsed.semanticLedger).toBe(true);
    expect(parsed.fileCountProbes).toEqual([]);
    expect(parsed.latestMigrationPins).toEqual([]);
    expect(
      unregisteredMigrations(
        ["0001_first.sql", "0002_second.sql", "0003_new.sql"],
        { ref: "origin/main", files: ["0001_first.sql", "0002_second.sql"] },
        parsed,
      ),
    ).toEqual([]);
  });

  test("still requires every new forward registration, including cross-branch additions", () => {
    const parsed = parseContractRegistration(semanticContract(["0003_new.sql"]));
    const missing = unregisteredMigrations(
      ["0001_first.sql", "0003_new.sql", "0004_next.sql", "custom_probe.sql"],
      { ref: "origin/main", files: ["0001_first.sql"] },
      parsed,
    );
    expect(missing).toEqual([
      { file: "0004_next.sql", missing: ["forward-list"], absentFrom: "origin/main" },
      { file: "custom_probe.sql", missing: ["forward-list"], absentFrom: "origin/main" },
    ]);
    const guidance = registrationFixLines(missing, new Set(), true).join("\n");
    expect(guidance).toContain("do not add file-count indicators or latest-migration name pins");
    expect(guidance).toContain("Do NOT instead pin a fresh hash");
    expect(guidance).not.toContain("Add a presence probe");
    expect(guidance).not.toContain("Prepend a `latestMigration` branch");
  });

  test("accepts local/import renaming, quote style, annotations, and harmless comments", () => {
    const renamed = semanticContract(["0003_new.sql"])
      .replaceAll("completeSourceContract", "completeLedger")
      .replaceAll("sourceMigrationPaths", "filesFromDisk")
      .replaceAll("contractMigrationPaths", "contractPaths")
      .replaceAll("(entry)", "(file: Entry)")
      .replaceAll("entry.", "file.")
      .replace("import { readdir }", "import { readdir as readMigrationFiles }")
      .replace("await readdir(", "await readMigrationFiles(")
      .replace('"../packages/db/drizzle"', "'../packages/db/drizzle'")
      .replace(".sort();", ".sort(/* lexical SQL-file order */);");
    expect(parseContractRegistration(renamed).semanticLedger).toBe(true);
  });

  test.each([
    [
      "count from the contract, not disk",
      "fileCount: sourceMigrationPaths.length",
      "fileCount: contractMigrationPaths.length",
    ],
    ["a fixed count", "fileCount: sourceMigrationPaths.length", "fileCount: 999"],
    [
      "latest from the contract, not disk",
      "latestMigration: sourceMigrationPaths.at(-1)",
      "latestMigration: contractMigrationPaths.at(-1)",
    ],
    [
      "a fixed latest name",
      "latestMigration: sourceMigrationPaths.at(-1) ?? null",
      'latestMigration: "0003_new.sql"',
    ],
    ["wrong source directory", '"../packages/db/drizzle"', '"../fixtures"'],
    [
      "filtered rather than complete builder",
      "await buildCompleteSchemaContract()",
      "await buildSchemaContract()",
    ],
    ["wrong builder module", 'from "./release-schema-contract"', 'from "./filtered-contract"'],
    [
      "type-only builder import",
      "import { buildSchemaContract as",
      "import type { buildSchemaContract as",
    ],
    ["missing file-only selection", "entry.isFile() && ", ""],
    ["missing SQL selection", ' && entry.name.endsWith(".sql")', ""],
    ["missing ordering", ".sort();", ";"],
    ["incorrect ordering", ".sort();", ".sort(() => -1);"],
    [
      "only partial path comparison",
      "expect(contractMigrationPaths).toEqual(sourceMigrationPaths)",
      "expect(contractMigrationPaths).toContain(sourceMigrationPaths[0])",
    ],
    [
      "commented-out path assertion",
      "expect(contractMigrationPaths).toEqual(sourceMigrationPaths);",
      "/* expect(contractMigrationPaths).toEqual(sourceMigrationPaths); */",
    ],
    [
      "commented-out uniqueness",
      "expect(new Set(contractMigrationPaths).size).toBe(contractMigrationPaths.length);",
      "// expect(new Set(contractMigrationPaths).size).toBe(contractMigrationPaths.length);",
    ],
    [
      "tautological uniqueness",
      "new Set(contractMigrationPaths).size",
      "contractMigrationPaths.length",
    ],
    ["skipped test", 'test("checks complete ledger', 'test.skip("checks complete ledger'],
    [
      "unconditional early return",
      "const completeSourceContract = await",
      "return; const completeSourceContract = await",
    ],
    ["mutable directory paths", "const sourceMigrationPaths =", "let sourceMigrationPaths ="],
  ])("rejects %s even though unrelated legacy probes remain", (_label, before, after) => {
    const source = semanticContract(["0003_new.sql"]);
    expect(source).toContain(before);
    expect(() => parseContractRegistration(source.replace(before, after))).toThrow(
      ContractParseError,
    );
  });

  test("a commented complete test cannot opt in to semantic registration", () => {
    const source = semanticContract(["0003_new.sql"]);
    const start = source.indexOf('test("checks complete ledger');
    expect(() =>
      parseContractRegistration(source.slice(0, start) + "/*" + source.slice(start) + "*/"),
    ).toThrow(ContractParseError);
  });

  test.each([
    ["shadowed matcher", "const expect = () => ({ toMatchObject() {}, toEqual() {}, toBe() {} });"],
    ["shadowed directory reader", "const readdir = async () => [];"],
    ["shadowed uniqueness constructor", "const Set = class { size = 0; };"],
    ["unreachable registration", "return;"],
    ["conditionally unreachable registration", "if (true) return;"],
  ])("rejects %s in the enclosing registration scope", (_label, prefix) => {
    const source = semanticContract(["0003_new.sql"]);
    const start = source.indexOf('test("checks complete ledger');
    const wrapped =
      source.slice(0, start) +
      `describe("wrapped", () => { ${prefix}\n` +
      source.slice(start) +
      "\n});";
    expect(() => parseContractRegistration(wrapped)).toThrow(ContractParseError);
  });

  test("commented and string-embedded forward lists do not register additions", () => {
    const source = semanticContract(["0003_new.sql"]);
    const commented = source.replace('      "0003_new.sql",', '      /* "0003_new.sql", */');
    expect(parseContractRegistration(commented).forward).not.toContain("0003_new.sql");
    const fake =
      source.replace("const appendedMigrationPaths = [", "const unrelated = [") +
      "\nconst fake = 'const appendedMigrationPaths = [\"0003_new.sql\"]';\n";
    expect(() => parseContractRegistration(fake)).toThrow(ContractParseError);
  });
});

describe("check-migration-schema-contract CLI", () => {
  const guard = [
    "bun",
    join(import.meta.dir, "check-migration-schema-contract.ts"),
    "--base",
    "origin/main",
  ];

  test("passes source-semantic metadata only when all additions are forward-listed", async () => {
    const root = await fixtureRepo({
      added: ["0003_new.sql", "0004_next.sql"],
      sites: {},
      source: semanticContract(["0003_new.sql"]),
    });
    const missing = await run(root, guard);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("- 0004_next.sql  (missing: forward-list)");
    expect(missing.stderr).not.toContain("Add a presence probe");
    await writeFile(
      join(root, "scripts/release-schema-contract.test.ts"),
      semanticContract(["0003_new.sql", "0004_next.sql"]),
    );
    const registered = await run(root, guard);
    expect(registered.code).toBe(0);
    expect(registered.stderr).toBe("");
  });

  test("fails closed on altered semantic assertions even when no migration was added", async () => {
    const root = await fixtureRepo({
      added: [],
      sites: {},
      source: semanticContract().replace(
        "fileCount: sourceMigrationPaths.length",
        "fileCount: contractMigrationPaths.length",
      ),
    });
    const result = await run(root, guard);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("independent, ordered SQL-file paths");
  });

  test("semantic mode retains the unreachable governed-checkpoint reference audit", async () => {
    const root = await fixtureRepo({
      added: [],
      sites: {},
      source: semanticContract(["0001_first.sql"]),
    });
    const result = await run(root, guard);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("where the check can never match");
    expect(result.stderr).toContain("- 0001_first.sql");
  });

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

  test("fails on an unreachable ladder rung even when nothing new was added", async () => {
    const root = await fixtureRepo({
      added: [],
      sites: { forward: ["0002_second.sql"], ladder: ["0002_second.sql"] },
    });
    const result = await run(root, guard);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("where the check can never match");
    expect(result.stderr).toContain("- 0002_second.sql");
    expect(result.stderr).toContain("Delete every reference to them");
    // Nothing new was added, so the registration report must stay suppressed
    // rather than announcing "0 new migrations are not fully registered".
    expect(result.stderr).not.toContain("not fully registered");
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
