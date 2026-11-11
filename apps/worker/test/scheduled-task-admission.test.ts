import { expect, test } from "bun:test";
import { retryScheduledTaskAdmission } from "../src/activities/scheduled-task-admission";

const diagnostic = "scheduled agent run task changed before producer admission";
const conflict = () =>
  new Error("query failed", {
    cause: Object.assign(new Error(diagnostic), { code: "40001" }),
  });

test("restarts fresh admission after a wrapped task-head conflict", async () => {
  let attempts = 0;
  expect(
    await retryScheduledTaskAdmission(async () => {
      if (++attempts === 1) throw conflict();
      return "fresh admission";
    }),
  ).toBe("fresh admission");
  expect(attempts).toBe(2);
});

test("bounds task-head retries and preserves the last failure for Temporal", async () => {
  let attempts = 0;
  const error = conflict();
  await expect(
    retryScheduledTaskAdmission(async () => {
      attempts += 1;
      throw error;
    }),
  ).rejects.toBe(error);
  expect(attempts).toBe(3);
});

for (const error of [
  Object.assign(new Error(diagnostic), { code: "42501" }),
  Object.assign(new Error("scheduled reusable-session task changed before materialization"), {
    code: "40001",
  }),
  Object.assign(new Error("could not serialize access due to concurrent update"), {
    code: "40001",
  }),
  new Error(diagnostic),
]) {
  test(`does not retry unrelated failures: ${error.message} / ${"code" in error ? error.code : "no SQLSTATE"}`, async () => {
    let attempts = 0;
    await expect(
      retryScheduledTaskAdmission(async () => {
        attempts += 1;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
}
