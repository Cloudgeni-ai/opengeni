import { afterAll, beforeAll, expect, test } from "bun:test";

import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createDb, getVerifiedSubjectEmail, type DbClient } from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("verified-subject-email");
  if (!shared && requireRealDatabase) throw new Error("verified subject email requires PostgreSQL");
  if (shared) client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

test("only a verified address of a managed user is returned, in lowercase", async () => {
  if (!shared || !client) return;
  const verified = crypto.randomUUID();
  const unverified = crypto.randomUUID();
  await shared.admin`
    insert into auth_users (id, name, email, email_verified) values
      (${verified}, 'Ada', ${`Ada.${verified}@Example.com`}, true),
      (${unverified}, 'Bob', ${`bob.${unverified}@example.com`}, false)`;
  expect(await getVerifiedSubjectEmail(client.db, `user:${verified}`)).toBe(
    `ada.${verified}@example.com`,
  );
  expect(await getVerifiedSubjectEmail(client.db, `user:${unverified}`)).toBeNull();
  // Unknown people, other subject kinds and malformed subjects have none.
  for (const subject of [
    `user:${crypto.randomUUID()}`,
    `external_user:${verified}`,
    verified,
    "user:",
  ])
    expect(await getVerifiedSubjectEmail(client.db, subject)).toBeNull();
});

test("an embedding host's address counts only when the host says it is verified", async () => {
  if (!shared) return;
  const embedded = createDb(shared.appUrl, {
    max: 1,
    userProfileLookup: async (_db, ids) =>
      ids.map((id) => ({
        id,
        name: null,
        email: `${id}@Host.example`,
        ...(id.startsWith("v-") ? { emailVerified: true } : {}),
      })),
  });
  try {
    expect(await getVerifiedSubjectEmail(embedded.db, "user:v-1")).toBe("v-1@host.example");
    expect(await getVerifiedSubjectEmail(embedded.db, "user:u-1")).toBeNull();
  } finally {
    await embedded.close();
  }
});
