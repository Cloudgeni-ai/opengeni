#!/usr/bin/env bun
/**
 * Publish the unscoped `opengeni` CLI before `changeset publish` publishes the
 * `@opengeni/*` packages (part of `bun run release:publish`).
 *
 * `changeset publish` publishes packages concurrently, in no fixed order. The
 * CLI is the only package outside the `@opengeni` scope, so an npm token that
 * may only write that scope would fail on it after other packages were already
 * published. Publishing it first makes that failure happen before anything is
 * published; the release can then be rerun once the token is fixed. A version
 * that is already on npm is skipped, so `changeset publish` and reruns see it
 * as published.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  OPENGENI_CLI_PACKAGE_NAME,
  publishableWorkspacePackages,
  repoRoot,
  type WorkspacePackage,
} from "./publishable-workspaces";

export type UnscopedPublisher = {
  packages(): readonly Pick<WorkspacePackage, "name" | "version" | "dir">[];
  published(name: string, version: string): boolean;
  publish(directory: string): void;
  log(message: string): void;
};

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
    throw new Error(
      `npm publish failed for ${OPENGENI_CLI_PACKAGE_NAME} (exit ${result.status ?? "signal"}). ` +
        "No @opengeni package has been published by this step. If npm refused the write, check " +
        "that NPM_TOKEN may create and publish the unscoped package, then rerun the release.",
    );
  }
}

const npmPublisher: UnscopedPublisher = {
  packages: () => publishableWorkspacePackages(),
  published: npmVersionPublished,
  publish: npmPublish,
  log: (message) => process.stdout.write(`${message}\n`),
};

/** Publish the CLI if it is publishable and its version is not on npm yet. */
export function publishUnscopedFirst(publisher: UnscopedPublisher = npmPublisher): boolean {
  const cli = publisher.packages().find((pkg) => pkg.name === OPENGENI_CLI_PACKAGE_NAME);
  if (!cli) {
    publisher.log(`${OPENGENI_CLI_PACKAGE_NAME} is not in the publishable set; nothing to do`);
    return false;
  }
  if (publisher.published(cli.name, cli.version)) {
    publisher.log(`${cli.name}@${cli.version} is already published`);
    return false;
  }
  publisher.log(`Publishing ${cli.name}@${cli.version} before the @opengeni packages`);
  publisher.publish(join(repoRoot, cli.dir));
  return true;
}

if (import.meta.main) publishUnscopedFirst();
