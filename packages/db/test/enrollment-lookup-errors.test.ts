import { expect, test } from "bun:test";
import { getEnrollment, type Database } from "../src/index";
import { WorkspaceNotFoundError } from "../src/database";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const enrollmentId = "00000000-0000-4000-8000-000000000002";

function failingDatabase(error: Error): Database {
  return {
    transaction: async () => {
      throw error;
    },
  } as unknown as Database;
}

test("enrollment lookup treats only the exact missing workspace as absent", async () => {
  expect(
    await getEnrollment(
      failingDatabase(new WorkspaceNotFoundError(workspaceId)),
      workspaceId,
      enrollmentId,
    ),
  ).toBeNull();
});

test("enrollment lookup preserves database failures and does not classify by error text", async () => {
  for (const error of [
    new Error("database unavailable"),
    new Error(`Workspace not found: ${workspaceId}`),
    new WorkspaceNotFoundError("00000000-0000-4000-8000-000000000003"),
  ]) {
    await expect(getEnrollment(failingDatabase(error), workspaceId, enrollmentId)).rejects.toBe(
      error,
    );
  }
});
