import { describe, expect, test } from "bun:test";
import { withRlsContext, type Database } from "../src/database";
import { withDatabaseTimingObserver, type DatabaseTimingObservation } from "../src/database-timing";

const context = { accountId: "account-not-a-label", workspaceId: "workspace-not-a-label" };
function fixture(
  options: {
    admissionError?: Error;
    setupError?: Error;
    commitError?: Error;
    nested?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const tx = {
    execute: async () => {
      calls.push("execute");
      if (options.setupError) throw options.setupError;
      return [{ account_id: context.accountId, workspace_id: context.workspaceId }];
    },
  } as unknown as Database;
  const db = {
    ...(options.nested ? { rollback: () => {} } : {}),
    transaction: async (work: (db: Database) => Promise<unknown>, config: unknown) => {
      calls.push("transaction");
      expect(config).toEqual({ isolationLevel: "repeatable read" });
      if (options.admissionError) throw options.admissionError;
      const result = await work(tx);
      calls.push("commit");
      if (options.commitError) throw options.commitError;
      return result;
    },
  } as unknown as Database;
  return { db, calls };
}
const config = { isolationLevel: "repeatable read" } as const;

describe("opt-in scoped DB timing", () => {
  test("admission ends at callback entry, before blocked scoped work completes", async () => {
    let admit!: () => void;
    let finishWork!: () => void;
    let entered!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const workGate = new Promise<void>((resolve) => {
      finishWork = resolve;
    });
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const tx = {
      execute: async () => [{ account_id: context.accountId, workspace_id: context.workspaceId }],
    } as unknown as Database;
    const db = {
      transaction: async (work: (db: Database) => Promise<unknown>) => {
        await admissionGate;
        return work(tx);
      },
    } as unknown as Database;
    const events: DatabaseTimingObservation[] = [];
    const result = withDatabaseTimingObserver(
      (event) => {
        events.push(event);
      },
      () =>
        withRlsContext(db, context, async () => {
          entered();
          await workGate;
          return 7;
        }),
    );
    expect(events).toEqual([]);
    admit();
    await enteredGate;
    expect(events.map((event) => event.stage)).toEqual(["transaction_admission", "rls_setup"]);
    finishWork();
    expect(await result).toBe(7);
    expect(events.map((event) => event.stage)).toEqual([
      "transaction_admission",
      "rls_setup",
      "scoped_callback",
    ]);
  });

  test("records callback entry before RLS setup and work; preserves transaction config/result", async () => {
    const { db, calls } = fixture();
    const observations: DatabaseTimingObservation[] = [];
    const result = {};
    expect(
      await withDatabaseTimingObserver(
        (event) => {
          observations.push(event);
          if (event.stage === "transaction_admission") expect(calls).toEqual(["transaction"]);
        },
        () => withRlsContext(db, context, async () => result, config),
      ),
    ).toBe(result);
    expect(observations.map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ["transaction_admission", "completed"],
      ["rls_setup", "completed"],
      ["scoped_callback", "completed"],
    ]);
    expect(observations.every((event) => event.durationMs >= 0)).toBe(true);
    expect(JSON.stringify(observations)).not.toContain(context.workspaceId);
  });

  test("distinguishes failed admission, setup, work and commit without replacing errors", async () => {
    for (const point of ["admissionError", "setupError", "workError", "commitError"] as const) {
      const error = new Error(point);
      const { db } = fixture(point === "workError" ? {} : { [point]: error });
      const observations: DatabaseTimingObservation[] = [];
      await expect(
        withDatabaseTimingObserver(
          (event) => {
            observations.push(event);
          },
          () =>
            withRlsContext(
              db,
              context,
              async () => {
                if (point === "workError") throw error;
                return 1;
              },
              config,
            ),
        ),
      ).rejects.toBe(error);
      expect(observations.filter((event) => event.stage === "transaction_admission")).toHaveLength(
        1,
      );
      expect(observations[0]?.outcome).toBe(point === "admissionError" ? "failed" : "completed");
      const failed = observations.filter((event) => event.outcome === "failed");
      expect(failed.map((event) => event.stage)).toEqual(
        point === "commitError"
          ? []
          : [
              point === "admissionError"
                ? "transaction_admission"
                : point === "setupError"
                  ? "rls_setup"
                  : "scoped_callback",
            ],
      );
    }
  });

  test("labels nested admission as savepoint, not pool wait", async () => {
    const { db } = fixture({ nested: true });
    const observations: DatabaseTimingObservation[] = [];
    await withDatabaseTimingObserver(
      (event) => {
        observations.push(event);
      },
      () => withRlsContext(db, context, async () => 1, config),
    );
    expect(observations[0]?.stage).toBe("savepoint_admission");
  });

  test("throwing and rejecting observers cannot change database results or errors", async () => {
    for (const observer of [
      () => {
        throw new Error("observer");
      },
      async () => {
        throw new Error("async observer");
      },
    ]) {
      const { db } = fixture();
      expect(
        await withDatabaseTimingObserver(observer, () =>
          withRlsContext(db, context, async () => 42, config),
        ),
      ).toBe(42);
      const error = new Error("original");
      await expect(
        withDatabaseTimingObserver(observer, () =>
          withRlsContext(
            db,
            context,
            async () => {
              throw error;
            },
            config,
          ),
        ),
      ).rejects.toBe(error);
    }
  });
});
