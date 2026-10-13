#!/usr/bin/env bun

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { copyRuntimeDependencies } from "./copy-runtime-dependencies";

export const API_RUNTIME_EXTERNALS = ["@llamaindex/liteparse", "sharp", "better-auth"];
export const WORKER_RUNTIME_EXTERNALS = [
  "@llamaindex/liteparse",
  "sharp",
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

const operatorCommands = [
  "inventory-tenancy",
  "check-tenancy-parity",
  "backfill-session-ownership",
  "backfill-organization-memberships",
  "backfill-connection-authority",
  "verify-resource-classification",
  "sweep-organization-retention",
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
      await doctor.outputs[0]!.arrayBuffer(),
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
