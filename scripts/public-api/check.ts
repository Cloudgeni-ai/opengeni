#!/usr/bin/env bun
/**
 * Public API compatibility guard (`bun run check:public-api`).
 *
 * Policy: docs/design/api-compatibility-policy.md. This command:
 *
 * 1. Regenerates the public surface inventory from source (SDK call sites ->
 *    registered API routes, contracts zod schemas, SDK/React exports).
 * 2. Fails when it differs from the committed snapshot
 *    (`scripts/public-api/surface.gen.json`); run
 *    `bun run public-api:refresh` to accept additive changes.
 * 3. Diffs the snapshot on the merge base with `origin/main` (override with
 *    `OPENGENI_PUBLIC_API_BASE_REF`, or diff against a file with
 *    `OPENGENI_PUBLIC_API_BASE_SNAPSHOT`) against the regenerated surface. Every
 *    breaking finding (removal, retyping, narrowing, new required request field)
 *    fails. Only an entry in `scripts/public-api/breaking-changes.json` that
 *    records a security exception or a linked owner approval admits one; a
 *    major release, changeset or deprecation period never does.
 * 4. Fails when a route that a published `@opengeni/sdk` calls
 *    (`scripts/public-api/published-sdk.gen.json`) is no longer registered.
 *
 * Pending changesets that declare a major release of `@opengeni/sdk` or
 * `@opengeni/react` are checked separately on every PR and batch by
 * `scripts/ci/changeset-plan.ts` (see `major-changesets.ts`).
 *
 * Flags: `--write` regenerates the snapshot; `--json` prints findings as JSON.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SDK_COMPATIBILITY_MATRIX_PATH, sdkCompatibilityFailures } from "./sdk-compatibility";
import {
  PUBLISHED_SDK_PATH,
  publishedSdkFindings,
  validatePublishedInventory,
} from "./published-sdk";
import { registeredRoutes } from "./registered-routes";
import {
  ALLOWLIST_PATH,
  SNAPSHOT_PATH,
  allowlisted,
  diffSnapshots,
  generateSnapshot,
  validateAllowlist,
  type Finding,
  type SchemaIo,
  type Snapshot,
} from "./surface";

const root = resolve(import.meta.dir, "..", "..");

async function contractSchemas(): Promise<Map<string, unknown>> {
  const manifest = JSON.parse(
    readFileSync(join(root, "packages/contracts/package.json"), "utf8"),
  ) as {
    exports: Record<string, unknown>;
  };
  const schemas = new Map<string, unknown>();
  const subpaths = Object.keys(manifest.exports).sort((a, b) =>
    a === "." ? -1 : b === "." ? 1 : a.localeCompare(b),
  );
  for (const subpath of subpaths) {
    if (!/^\.(\/[\w-]+)?$/.test(subpath)) continue;
    const specifier =
      subpath === "." ? "@opengeni/contracts" : `@opengeni/contracts/${subpath.slice(2)}`;
    const module = (await import(specifier)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      if (value instanceof z.ZodType && !schemas.has(name)) schemas.set(name, value);
    }
  }
  return schemas;
}

function toJsonSchema(schema: unknown, io: SchemaIo): Record<string, unknown> {
  return z.toJSONSchema(schema as z.ZodType, {
    io,
    unrepresentable: "any",
    cycles: "ref",
    reused: "inline",
  }) as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function baseSnapshot(): { ref: string; snapshot: Snapshot } | null {
  const file = process.env.OPENGENI_PUBLIC_API_BASE_SNAPSHOT?.trim();
  if (file) return { ref: file, snapshot: JSON.parse(readFileSync(file, "utf8")) as Snapshot };
  const explicit = process.env.OPENGENI_PUBLIC_API_BASE_REF?.trim();
  const candidates = explicit ? [explicit] : ["origin/main", "main"];
  for (const candidate of candidates) {
    const base = git(["merge-base", "HEAD", candidate])?.trim();
    if (!base) continue;
    const text = git(["show", `${base}:${SNAPSHOT_PATH}`]);
    if (text === null) return null;
    return { ref: `${candidate}@${base.slice(0, 12)}`, snapshot: JSON.parse(text) as Snapshot };
  }
  return null;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const asJson = process.argv.includes("--json");
  const routes = registeredRoutes();
  const generated = generateSnapshot({
    repositoryRoot: root,
    registeredRoutes: routes,
    contractSchemas: await contractSchemas(),
    toJsonSchema,
  });
  const snapshotFile = join(root, SNAPSHOT_PATH);
  const committedText = existsSync(snapshotFile) ? readFileSync(snapshotFile, "utf8") : null;
  const generatedText = stableJson(generated);
  const allowlist = validateAllowlist(JSON.parse(readFileSync(join(root, ALLOWLIST_PATH), "utf8")));

  const base = baseSnapshot();
  const failures: string[] = [];
  const matrixBase = git([
    "merge-base",
    "HEAD",
    process.env.OPENGENI_PUBLIC_API_BASE_REF?.trim() || "origin/main",
  ])?.trim();
  const previousMatrix = matrixBase
    ? git(["show", `${matrixBase}:${SDK_COMPATIBILITY_MATRIX_PATH}`])
    : null;
  failures.push(
    ...sdkCompatibilityFailures(
      JSON.parse(readFileSync(join(root, SDK_COMPATIBILITY_MATRIX_PATH), "utf8")),
      previousMatrix ? JSON.parse(previousMatrix) : undefined,
    ),
  );
  let findings: Finding[] = [];
  if (base) {
    findings = diffSnapshots(base.snapshot, generated);
    for (const finding of findings.filter((candidate) => candidate.breaking)) {
      if (!allowlisted(finding, allowlist))
        failures.push(`BREAKING ${finding.message}\n    id: ${finding.id}`);
    }
  }

  const published = validatePublishedInventory(
    JSON.parse(readFileSync(join(root, PUBLISHED_SDK_PATH), "utf8")),
  );
  const publishedResult = publishedSdkFindings(published, routes);
  for (const finding of publishedResult.breaking) {
    if (!allowlisted({ ...finding, breaking: true }, allowlist))
      failures.push(`BREAKING ${finding.message}\n    id: ${finding.id}`);
  }

  for (const call of generated.unmatchedSdkCalls) {
    failures.push(
      `SDK call site matches no route the API registers: ${call}. A public SDK method must not call a removed or misspelled route.`,
    );
  }

  if (write) {
    writeFileSync(snapshotFile, generatedText);
    process.stdout.write(
      `[public-api] wrote ${SNAPSHOT_PATH} (${generated.routes.length} routes, ${Object.keys(generated.schemas).length} schemas)\n`,
    );
  } else if (committedText !== generatedText) {
    failures.push(
      `${SNAPSHOT_PATH} is stale. Run \`bun run public-api:refresh\` and commit the result (additive changes need nothing else).`,
    );
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ base: base?.ref ?? null, findings, published: publishedResult, failures }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `[public-api] ${generated.routes.length} public routes, ${Object.keys(generated.schemas).length} schemas, ${Object.keys(generated.exports).length} entry points\n`,
    );
    if (generated.unmatchedSdkCalls.length > 0) {
      process.stdout.write(
        `[public-api] note: ${generated.unmatchedSdkCalls.length} SDK call sites match no registered route (recorded in the snapshot)\n`,
      );
    }
    process.stdout.write(
      `[public-api] published SDKs checked: ${published.packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ") || "none"}\n`,
    );
    for (const gap of publishedResult.resolvedGaps) {
      process.stdout.write(
        `[public-api] note: accepted gap is served again and can be removed from ${PUBLISHED_SDK_PATH}: ${gap}\n`,
      );
    }
    if (!base) {
      process.stdout.write(
        "[public-api] no base snapshot on the merge base; compatibility diff skipped\n",
      );
    } else {
      const additive = findings.filter((finding) => !finding.breaking);
      process.stdout.write(
        `[public-api] vs ${base.ref}: ${findings.length - additive.length} breaking, ${additive.length} additive\n`,
      );
      for (const finding of additive.slice(0, 40)) process.stdout.write(`  + ${finding.message}\n`);
      if (additive.length > 40) process.stdout.write(`  + ... ${additive.length - 40} more\n`);
    }
  }
  if (failures.length > 0) {
    process.stderr.write(
      `\n[public-api] FAILED\n${failures.map((line) => `  ${line}`).join("\n")}\n`,
    );
    process.stderr.write(
      "\nOpengeni does not ship breaking public API changes, in any release. Keep the old behaviour and add the new one alongside it (a new optional field, route or versioned surface over shared logic); see docs/design/api-compatibility-policy.md.\n",
    );
    process.exit(1);
  }
  process.stdout.write("[public-api] passed\n");
}

await main();
