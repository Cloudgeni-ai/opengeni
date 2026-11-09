import { expect, test } from "bun:test";
import type { Database } from "../src/database";
import { runtimeDatabaseReadyCheck } from "../src/runtime-posture";

function fakeDatabase() {
  const inspections: { reject: (error: Error) => void }[] = [];
  const db = {
    // Every inspection runs in one database transaction. Hold it open until
    // the test settles it, as a slow or stalled database would.
    transaction: () =>
      new Promise<never>((_resolve, reject) => {
        inspections.push({ reject });
      }),
  } as unknown as Database;
  return { db, inspections };
}

test("concurrent readiness probes share one outstanding posture inspection", async () => {
  const { db, inspections } = fakeDatabase();
  const check = runtimeDatabaseReadyCheck(db, { rlsStrategy: "force" });
  const first = check();
  const second = check();
  const third = check();
  expect(second).toBe(first);
  expect(third).toBe(first);
  expect(inspections).toHaveLength(1);

  const failure = new Error("database unavailable");
  inspections[0]!.reject(failure);
  for (const probe of [first, second, third]) await expect(probe).rejects.toBe(failure);
});

test("the next probe after a settled inspection inspects again", async () => {
  const { db, inspections } = fakeDatabase();
  const check = runtimeDatabaseReadyCheck(db, { rlsStrategy: "force" });
  const failed = check();
  inspections[0]!.reject(new Error("first"));
  await expect(failed).rejects.toThrow("first");

  const retried = check();
  expect(retried).not.toBe(failed);
  expect(inspections).toHaveLength(2);
  inspections[1]!.reject(new Error("second"));
  await expect(retried).rejects.toThrow("second");

  check().catch(() => {});
  expect(inspections).toHaveLength(3);
  inspections[2]!.reject(new Error("third"));
});
