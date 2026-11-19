#!/usr/bin/env bun
/**
 * Publish the unscoped `opengeni` CLI, best-effort, before the `@opengeni/*`
 * packages (part of `bun run release:publish` and `publish-stable.ts`).
 *
 * The CLI is outside the release contract (see `isBestEffortPublication`): the
 * release must not fail because of it. If npm refuses the write, for example
 * because NPM_TOKEN may only write the `@opengeni` scope, this step prints a
 * GitHub Actions warning and a step-summary line, marks the CLI private in the
 * ephemeral CI checkout so `changeset publish` skips it, and exits 0. A version
 * that is already on npm is left alone, so reruns are idempotent.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPENGENI_CLI_PACKAGE_NAME,
  publishableWorkspacePackages,
  repoRoot,
  type WorkspacePackage,
} from "./publishable-workspaces";

export type UnscopedPublication = "absent" | "already-published" | "published" | "skipped";

export type UnscopedPublisher = {
  packages(): readonly Pick<WorkspacePackage, "name" | "version" | "dir">[];
  published(name: string, version: string): boolean;
  /** Publish the package in `directory`; throw when npm refuses it. */
  publish(directory: string): void;
  /** Keep a later `changeset publish` from trying the package in `directory`. */
  exclude(directory: string): void;
  log(message: string): void;
  warn(message: string): void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function npmVersionPublished(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--silent"], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

function npmPublish(directory: string): void {
  // Same transport as `changeset publish`: npm honors publishConfig
  // (access public, provenance) and runs the prepublishOnly release guard.
  const result = spawnSync("npm", ["publish", "--access", "public", "--tag", "latest"], {
    cwd: directory,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`npm publish exited ${result.status ?? `on ${result.signal}`}`);
  }
}

/** Mark the package private in this (ephemeral, never committed) checkout. */
export function markPrivate(directory: string): void {
  const path = join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  manifest.private = true;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function githubWarning(message: string): void {
  const annotation = message.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
  process.stdout.write(
    `::warning title=${OPENGENI_CLI_PACKAGE_NAME} not published::${annotation}\n`,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, `- :warning: ${message}\n`);
    } catch {
      // The annotation above already carries the warning.
    }
  }
}

const npmPublisher: UnscopedPublisher = {
  packages: () => publishableWorkspacePackages(),
  published: npmVersionPublished,
  publish: npmPublish,
  exclude: markPrivate,
  log: (message) => process.stdout.write(`${message}\n`),
  warn: githubWarning,
};

/** Publish the CLI if it is publishable and not on npm yet; never throws. */
export function publishUnscopedFirst(
  publisher: UnscopedPublisher = npmPublisher,
): UnscopedPublication {
  let cli: Pick<WorkspacePackage, "name" | "version" | "dir"> | undefined;
  try {
    cli = publisher.packages().find((pkg) => pkg.name === OPENGENI_CLI_PACKAGE_NAME);
  } catch (error) {
    publisher.warn(
      `Could not read the ${OPENGENI_CLI_PACKAGE_NAME} package (${errorMessage(error)}); ` +
        "the @opengeni packages publish without it.",
    );
    return "skipped";
  }
  if (!cli) {
    publisher.log(`${OPENGENI_CLI_PACKAGE_NAME} is not in the publishable set; nothing to do`);
    return "absent";
  }
  const directory = join(repoRoot, cli.dir);
  try {
    if (publisher.published(cli.name, cli.version)) {
      publisher.log(`${cli.name}@${cli.version} is already published`);
      return "already-published";
    }
    publisher.log(
      `Publishing ${cli.name}@${cli.version} (best-effort) before the @opengeni packages`,
    );
    publisher.publish(directory);
    return "published";
  } catch (error) {
    publisher.warn(
      `${cli.name}@${cli.version} was not published: ${errorMessage(error)}. ` +
        `The release continues with the @opengeni packages. Check that NPM_TOKEN may create and ` +
        `publish the unscoped npm package "${cli.name}" (a token limited to the @opengeni scope cannot).`,
    );
    try {
      publisher.exclude(directory);
    } catch (excludeError) {
      publisher.warn(
        `Could not exclude ${cli.name} from changeset publish: ${errorMessage(excludeError)}`,
      );
    }
    return "skipped";
  }
}

if (import.meta.main) publishUnscopedFirst();
