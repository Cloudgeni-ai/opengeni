import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";

type Contract = {
  migration: string;
  phase: "expand" | "contract";
  previousCodeCompatible: boolean;
  previousReaderCompatible: boolean;
  previousWriterCompatible: boolean;
  rollbackMode: "code-only" | "schema-restore-required";
};

describe("cumulative release migration contracts", () => {
  it("binds every retained entry to immutable SQL and explicit reader/writer compatibility", () => {
    const path = new URL("./migration-contracts.json", import.meta.url);
    const contracts = JSON.parse(readFileSync(path, "utf8")) as Contract[];
    const names = contracts.map((contract) => contract.migration);
    const managedMigrations = readdirSync(new URL("../../packages/db/drizzle", import.meta.url))
      .filter((name) => name.endsWith(".sql") && name >= "0049_enrollment_went_offline.sql")
      .sort();
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(managedMigrations);
    for (const contract of contracts) {
      expect(
        existsSync(new URL(`../../packages/db/drizzle/${contract.migration}`, import.meta.url)),
      ).toBe(true);
      expect(contract.phase).toBe("expand");
      expect(contract.previousCodeCompatible).toBe(true);
      expect(contract.previousReaderCompatible).toBe(true);
      expect(contract.previousWriterCompatible).toBe(true);
      expect(contract.rollbackMode).toBe("code-only");
    }
  });
});
