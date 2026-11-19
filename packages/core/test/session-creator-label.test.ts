import { describe, expect, test } from "bun:test";
import { registerDbBinding, type Database } from "@opengeni/db";
import { managedPersonLabel, withPersonCreatorLabel } from "../src/domain/session-creator-label";

function fakeDb(
  profiles: Array<{ id: string; name: string | null; email: string }>,
  options: { fail?: boolean } = {},
): Database {
  const db = {} as Database;
  registerDbBinding(db, {
    userProfileLookup: async (_db, ids) => {
      if (options.fail) throw new Error("lookup down");
      return profiles.filter((profile) => ids.includes(profile.id));
    },
  });
  return db;
}

describe("session creator labels", () => {
  test("a person started from Slack gets the label the app freezes", async () => {
    const db = fakeDb([{ id: "3b9f", name: "Bendik Nyheim", email: "bendik@example.com" }]);
    await expect(
      withPersonCreatorLabel(db, { kind: "subject", subjectId: "user:3b9f" }),
    ).resolves.toEqual({ kind: "subject", subjectId: "user:3b9f", label: "bendik@example.com" });
  });

  test("an existing label, another kind of creator, or an unknown person is unchanged", async () => {
    const db = fakeDb([{ id: "3b9f", name: "Bendik", email: "bendik@example.com" }]);
    const labeled = { kind: "subject", subjectId: "user:3b9f", label: "Bendik" } as const;
    expect(await withPersonCreatorLabel(db, labeled)).toBe(labeled);
    const apiKey = { kind: "subject", subjectId: "api_key:k1" } as const;
    expect(await withPersonCreatorLabel(db, apiKey)).toBe(apiKey);
    expect(await managedPersonLabel(db, "user:missing")).toBeNull();
    expect(await withPersonCreatorLabel(db, undefined)).toBeUndefined();
  });

  test("a lookup failure leaves the creator unlabeled instead of failing the work", async () => {
    const db = fakeDb([], { fail: true });
    const initiator = { kind: "subject", subjectId: "user:3b9f" } as const;
    expect(await withPersonCreatorLabel(db, initiator)).toBe(initiator);
  });
});
