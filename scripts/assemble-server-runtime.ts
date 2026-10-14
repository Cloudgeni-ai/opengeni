#!/usr/bin/env bun

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { copyRuntimeDependencies } from "./copy-runtime-dependencies";

// The standalone API always queues Documents parsing through Temporal. Keep
// LiteParse's native closure only in the worker image. The API npm package still
// declares it for embedded createApp compositions that use inline indexing.
// The 1Password SDK stays a real package in both images: its core loads a WASM
// file from beside its own module, which a bundle cannot carry.
export const API_RUNTIME_EXTERNALS = ["sharp", "better-auth", "@1password/sdk"];
export const WORKER_RUNTIME_EXTERNALS = [
  "@llamaindex/liteparse",
  "sharp",
  "@1password/sdk",
  "@temporalio/activity",
  "@temporalio/client",
  "@temporalio/worker",
  "@temporalio/workflow",
];

const databaseCommands = [
  "migrate",
  "provision-roles",
  "runtime-posture-cli",
  "lifecycle-fact-backfill",
  "session-content-compaction",
] as const;

/**
 * Commands whose module is also imported through the DB barrel. With code
 * splitting, their body moves into a shared chunk where `import.meta.main` is
 * false, so the bundled entry must call the exported runner explicitly.
 */
export const DATABASE_COMMAND_RUNNERS: Readonly<Record<string, string>> = {
  migrate: "runMigrateCli",
  "provision-roles": "runProvisionRolesCli",
  "lifecycle-fact-backfill": "runLifecycleFactBackfillCli",
  "session-content-compaction": "runSessionContentCompactionCli",
};

/**
 * Make a bundled command entry run when executed. A source entry guarded by
 * `import.meta.main` either keeps that guard in its own output, or has a
 * registered runner that the entry calls; anything else would silently no-op.
 */
export function finalizeCommandEntry(input: {
  command: string;
  source: string;
  output: string;
  runner?: string;
}): string {
  const guarded = input.source.includes("import.meta.main");
  if (!guarded || input.output.includes("import.meta.main")) return input.output;
  if (!input.runner) {
    throw new Error(
      `Bundled command ${input.command} lost its import.meta.main entry; register an exported runner`,
    );
  }
  const imported = new RegExp(`import\\s*\\{[^}]*\\b${input.runner}\\b[^}]*\\}`);
  if (!imported.test(input.output)) {
    throw new Error(`Bundled command ${input.command} does not import its runner ${input.runner}`);
  }
  // Keep the source's entry-point guard: importing the bundled module (tests,
  // image smoke checks, other tools) must never run the command itself.
  return `${input.output.trimEnd()}\nif (import.meta.main) await ${input.runner}();\n`;
}

const operatorCommands = [
  "inventory-tenancy",
  "check-tenancy-parity",
  "backfill-session-ownership",
  "backfill-organization-memberships",
  "backfill-connection-authority",
  "verify-resource-classification",
  "sweep-organization-retention",
  "admission-settings",
] as const;

export async function assembleServerRuntime(root: string, role: "api" | "worker") {
  const destination = join(root, ".release/server-runtime", role);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const packages = await copyRuntimeDependencies(
    root,
    destination,
    `apps/${role}`,
    role === "api" ? API_RUNTIME_EXTERNALS : WORKER_RUNTIME_EXTERNALS,
  );
  if (role === "api") {
    // The byte-verified native bootstrap uses bare package imports at runtime.
    // Its package graph must remain resolvable independently of the API bundle.
    packages.push(
      ...(await copyRuntimeDependencies(root, destination, ".", ["@opengeni/artifact-tool"])),
    );
  }
  const processDirectory = join(root, `apps/${role}/dist/process`);
  await cp(processDirectory, join(destination, `apps/${role}/dist/process`), {
    recursive: true,
    filter: (source) =>
      role !== "worker" ||
      !["artifact-materializer", "artifact-outbox"].includes(
        relative(processDirectory, source).split(sep)[0]!,
      ),
  });

  // Helm uses the API image for migration/role/posture Jobs. Keep the public
  // command paths and SQL bytes intact, but bundle their source dependency graph.
  if (role === "api") {
    const doctor = await Bun.build({
      entrypoints: [join(root, "packages/artifact-tool/src/runtime-cli-entry.ts")],
      target: "bun",
      format: "esm",
      minify: true,
      sourcemap: "none",
    });
    if (!doctor.success || doctor.outputs.length !== 1) {
      throw new Error(`Artifact runtime doctor build failed: ${doctor.logs.join("\n")}`);
    }
    await writeFile(
      join(destination, "artifact-runtime-doctor.js"),
      new Uint8Array(await doctor.outputs[0]!.arrayBuffer()),
    );
    const commands = await Bun.build({
      entrypoints: [
        ...databaseCommands.map((command) => join(root, `packages/db/src/${command}.ts`)),
        ...operatorCommands.map((command) => join(root, `scripts/${command}.ts`)),
        join(root, "scripts/import-integrations-catalog.ts"),
      ],
      root,
      outdir: destination,
      naming: {
        entry: "[dir]/[name].ts",
        // The DB barrel exports migrate(), so its shared chunk must keep the
        // migrator's relative SQL-ledger lookup beside the original entrypoint.
        chunk: "packages/db/src/runtime-[hash].js",
      },
      splitting: true,
      target: "bun",
      format: "esm",
      minify: { syntax: true, whitespace: true, identifiers: false },
      sourcemap: "none",
    });
    if (!commands.success) {
      throw new Error(`Operator runtime build failed: ${commands.logs.join("\n")}`);
    }
    for (const [command, relativePath] of [
      ...databaseCommands.map((name) => [name, `packages/db/src/${name}.ts`] as const),
      ...operatorCommands.map((name) => [name, `scripts/${name}.ts`] as const),
      ["import-integrations-catalog", "scripts/import-integrations-catalog.ts"] as const,
    ]) {
      const builtPath = join(destination, relativePath);
      await writeFile(
        builtPath,
        finalizeCommandEntry({
          command,
          source: await readFile(join(root, relativePath), "utf8"),
          output: await readFile(builtPath, "utf8"),
          ...(DATABASE_COMMAND_RUNNERS[command]
            ? { runner: DATABASE_COMMAND_RUNNERS[command] }
            : {}),
        }),
      );
    }
    await cp(join(root, "packages/db/drizzle"), join(destination, "packages/db/drizzle"), {
      recursive: true,
    });
    await cp(join(root, "packages/db/package.json"), join(destination, "packages/db/package.json"));
    // The stock Helm catalog-import Job uses the API/migration image too.
    // Its reviewed snapshot and vendored logos stay local; never refetch them.
    await cp(join(root, "data/catalog"), join(destination, "data/catalog"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    // The root is only a runtime command dispatcher, not an install workspace.
    await writeFile(
      join(destination, "package.json"),
      JSON.stringify({
        name: manifest.name,
        type: "module",
        scripts: Object.fromEntries(
          [
            "db:migrate",
            "db:migrate-plan",
            "db:provision-roles",
            "db:assert-runtime-posture",
            "db:backfill-lifecycle-facts",
            ...operatorCommands.map((command) => `db:${command}`),
            "catalog:import",
          ].map((command) => [command, manifest.scripts[command]]),
        ),
      }),
    );
  }
  await writeFile(
    join(destination, "runtime-dependencies.json"),
    JSON.stringify({ role, packages }),
  );
  return destination;
}

if (import.meta.main) {
  const role = process.argv[2];
  if (role !== "api" && role !== "worker") throw new Error("Expected api or worker runtime role");
  console.log(await assembleServerRuntime(resolve(import.meta.dir, ".."), role));
}
