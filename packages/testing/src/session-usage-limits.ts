/**
 * Unit-test support for per-task usage limits (OPE-798).
 *
 * Model admission and settlement read and write the task root's usage counter
 * synchronously through `@opengeni/db`. Unit tests that drive those paths with
 * a fake `{}` database (no Postgres) call `useNoSessionUsageLimitForFakeDatabases()`
 * once at file scope: for a fake database every session reads as having no
 * root row (no limit, nothing recorded), which is the same answer a real
 * database gives for a task without usage-limit state. A real drizzle database
 * or transaction always goes through the real functions, so Postgres-backed
 * tests keep the real fail-closed behavior.
 */
import { afterEach, beforeEach, spyOn } from "bun:test";
import * as opengeniDb from "@opengeni/db";

const realCheck = opengeniDb.checkSessionUsageLimitAdmission;
const realSettle = opengeniDb.settleSessionUsageReceipt;
const realRead = opengeniDb.readSessionUsageLimit;

/** True for a drizzle database or transaction (both carry `_.session`). */
export function isRealDrizzleDatabase(db: unknown): boolean {
  const internals = (db as { _?: { session?: unknown } } | null | undefined)?._;
  return typeof internals?.session === "object" && internals.session !== null;
}

export function useNoSessionUsageLimitForFakeDatabases(): void {
  const restores: Array<() => void> = [];
  beforeEach(() => {
    const check = spyOn(opengeniDb, "checkSessionUsageLimitAdmission").mockImplementation(
      async (db, input) =>
        isRealDrizzleDatabase(db) ? await realCheck(db, input) : { allowed: true, state: null },
    );
    const settle = spyOn(opengeniDb, "settleSessionUsageReceipt").mockImplementation(
      async (db, input) =>
        isRealDrizzleDatabase(db)
          ? await realSettle(db, input)
          : { outcome: "source_gone" as const, state: null },
    );
    const read = spyOn(opengeniDb, "readSessionUsageLimit").mockImplementation(async (db, input) =>
      isRealDrizzleDatabase(db) ? await realRead(db, input) : { outcome: "not_found" as const },
    );
    restores.push(
      () => check.mockRestore(),
      () => settle.mockRestore(),
      () => read.mockRestore(),
    );
  });
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });
}
