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
 *    must match an entry in `scripts/public-api/breaking-changes.json` that
 *    references its deprecation and names a removal major greater than the base
 *    major, AND the candidate must carry the major bump (a pending changeset
 *    declaring `"@opengeni/sdk": major`, or an SDK package version already at
 *    that major). A `securityException` entry skips the major requirement.
 *
 * Flags: `--write` regenerates the snapshot; `--json` prints findings as JSON.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../../apps/api/src/app";
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

function registeredRoutes(): { method: string; path: string }[] {
  // Every deployment flag that gates route registration is enabled so the
  // inventory is the maximal surface a managed deployment can expose.
  const settings = testSettings({
    authRequired: true,
    accessKey: "public-api-surface",
    productAccessMode: "configured",
    integrationsEnabled: true,
    codexSubscriptionEnabled: true,
    supergrokSubscriptionEnabled: true,
    sandboxSelfhostedEnabled: true,
    sandboxDesktopEnabled: true,
    streamControlEnabled: true,
    mcpOauthEnabled: true,
  });
  const observability = createObservability(settings, { component: "api" });
  observability.info = () => undefined;
  observability.warn = () => undefined;
  const app = createApp({
    settings,
    observability,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const seen = new Set<string>();
  const routes: { method: string; path: string }[] = [];
  for (const route of app.routes) {
    // Middleware (`(c, next)`) and catch-all mounts are not callable routes.
    if (route.method === "ALL" || route.handler.length >= 2) continue;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: route.method, path: route.path });
  }
  return routes;
}

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

/** Pending changesets that declare a major release for the SDK. */
function pendingSdkMajorBump(): boolean {
  const directory = join(root, ".changeset");
  if (!existsSync(directory)) return false;
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".md")) continue;
    const text = readFileSync(join(directory, file), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    if (/["']?@opengeni\/sdk["']?\s*:\s*major\b/.test(frontmatter)) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const asJson = process.argv.includes("--json");
  const generated = generateSnapshot({
    repositoryRoot: root,
    registeredRoutes: registeredRoutes(),
    contractSchemas: await contractSchemas(),
    toJsonSchema,
  });
  const snapshotFile = join(root, SNAPSHOT_PATH);
  const committedText = existsSync(snapshotFile) ? readFileSync(snapshotFile, "utf8") : null;
  const generatedText = stableJson(generated);
  const allowlist = validateAllowlist(JSON.parse(readFileSync(join(root, ALLOWLIST_PATH), "utf8")));

  const base = baseSnapshot();
  const failures: string[] = [];
  let findings: Finding[] = [];
  if (base) {
    findings = diffSnapshots(base.snapshot, generated);
    const sdkMajor = generated.sdkMajor;
    const majorBumped = pendingSdkMajorBump() || sdkMajor > base.snapshot.sdkMajor;
    for (const finding of findings.filter((candidate) => candidate.breaking)) {
      const entry = allowlisted(finding, allowlist, base.snapshot.sdkMajor);
      if (!entry) {
        failures.push(`BREAKING ${finding.message}\n    id: ${finding.id}`);
      } else if (!entry.securityException && !majorBumped) {
        failures.push(
          `BREAKING ${finding.message}\n    id: ${finding.id}\n    allowlisted for removal in major ${entry.removedInMajor}, but no pending changeset declares "@opengeni/sdk": major`,
        );
      }
    }
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
      `${JSON.stringify({ base: base?.ref ?? null, findings, failures }, null, 2)}\n`,
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
      "\nBreaking public API changes need a deprecation, Sunset headers, and a new major; see docs/design/api-compatibility-policy.md.\n",
    );
    process.exit(1);
  }
  process.stdout.write("[public-api] passed\n");
}

await main();
