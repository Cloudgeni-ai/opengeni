import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import * as database from "../src/database";
import * as root from "../src/index";
import type {
  CreateDbOptions as RootCreateDbOptions,
  Database as RootDatabase,
  DbClient as RootDbClient,
  RlsContext as RootRlsContext,
  RlsStrategy as RootRlsStrategy,
  UserLookup as RootUserLookup,
} from "../src/index";
import type {
  CreateDbOptions as FoundationCreateDbOptions,
  Database as FoundationDatabase,
  DbClient as FoundationDbClient,
  RlsContext as FoundationRlsContext,
  RlsStrategy as FoundationRlsStrategy,
  UserLookup as FoundationUserLookup,
} from "../src/database";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("database foundation boundary", () => {
  test("keeps the existing root runtime and type surface compatible", () => {
    expect(root.createDb).toBe(database.createDb);
    expect(root.registerDbBinding).toBe(database.registerDbBinding);
    expect(root.rlsContextForWorkspace).toBe(database.rlsContextForWorkspace);
    expect(root.rlsStrategyFor).toBe(database.rlsStrategyFor);
    expect(root.setRlsContext).toBe(database.setRlsContext);
    expect(root.setSubjectRlsContext).toBe(database.setSubjectRlsContext);
    expect(root.withAccountRls).toBe(database.withAccountRls);
    expect(root.withDatabaseStatementTimeout).toBe(database.withDatabaseStatementTimeout);
    expect(root.withRlsContext).toBe(database.withRlsContext);
    expect(root.withWorkspaceRls).toBe(database.withWorkspaceRls);
    expect(root.withWorkspaceSubjectRls).toBe(database.withWorkspaceSubjectRls);
    expect(root.withWorkspaceUsageLock).toBe(database.withWorkspaceUsageLock);

    const typeParity: [
      Same<RootDatabase, FoundationDatabase>,
      Same<RootDbClient, FoundationDbClient>,
      Same<RootRlsContext, FoundationRlsContext>,
      Same<RootRlsStrategy, FoundationRlsStrategy>,
      Same<RootUserLookup, FoundationUserLookup>,
      Same<RootCreateDbOptions, FoundationCreateDbOptions>,
    ] = [true, true, true, true, true, true];
    expect(typeParity).toEqual([true, true, true, true, true, true]);

    expect(root).not.toHaveProperty("dbBindingFor");
    expect(root).not.toHaveProperty("rawRows");
    expect(root).not.toHaveProperty("retryRlsPersistence");
    expect(root).not.toHaveProperty("retryWorkspacePersistence");
  });

  test("keeps root-reexported DB modules off the root barrel", async () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const allowedRootConsumers = new Set([
      // Executable entry point; the root does not import it.
      "runtime-posture-cli.ts",
    ]);

    const offenders: string[] = [];
    for (const name of await readdir(srcDir)) {
      if (!name.endsWith(".ts") || name === "index.ts" || allowedRootConsumers.has(name)) {
        continue;
      }
      const source = await readFile(`${srcDir}/${name}`, "utf8");
      if (/from\s+["']\.\/index["']/.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
