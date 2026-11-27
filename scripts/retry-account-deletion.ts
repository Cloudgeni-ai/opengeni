import { dbSearchPath, getSettings } from "@opengeni/config";
import { accountDeletionAvailable, accountDeletionWork, createDb } from "@opengeni/db";
import { z } from "zod";

const requestId = z.uuid().safeParse(process.argv[2]);
if (!requestId.success || process.argv.length !== 3) {
  throw new Error("Usage: bun scripts/retry-account-deletion.ts <request-id>");
}
const settings = getSettings();
const searchPath = dbSearchPath(settings);
const database = createDb(settings.databaseUrl, {
  ...(searchPath ? { searchPath } : {}),
  rlsStrategy: settings.rlsStrategy,
  max: 1,
});
try {
  if (!(await accountDeletionAvailable(database.db)))
    throw new Error("Account deletion is not activated");
  const scope = { requestId: requestId.data };
  const ticket = await accountDeletionWork(database.db, "ticket", scope, z.uuid().nullable());
  if (
    !ticket ||
    !(await accountDeletionWork(database.db, "resume_blocked", { ...scope, ticket }, z.boolean()))
  ) {
    throw new Error("No terminally blocked account deletion matched that request");
  }
  console.log("Account deletion queued for retry");
} finally {
  await database.close();
}
