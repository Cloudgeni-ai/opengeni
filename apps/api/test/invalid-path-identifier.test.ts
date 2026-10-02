import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, createWorkspace, getScheduledTask, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { invalidPathIdentifierHttpError } from "../src/http/path-identifier";

/**
 * A client built against a newer API (for example the SDK's
 * `listScheduledTaskAccessAttention`, `GET .../scheduled-tasks/attention`)
 * talking to a server without that literal route falls through to
 * `.../scheduled-tasks/:taskId`. The non-UUID id reached PostgreSQL and the
 * caller got a 500; it is a 404.
 */

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-invalid-path-identifier");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("invalid path identifier tests require PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

async function realUuidCastFailure(id: string): Promise<unknown> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('path identifier') returning id`;
  const workspace = await createWorkspace(client!.db, { accountId: account!.id, name: "W" });
  const error = await getScheduledTask(client!.db, workspace.id, id).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).not.toBeNull();
  return { error, workspaceId: workspace.id };
}

describe("a non-UUID resource id in the path", () => {
  test("the real PostgreSQL cast failure for a path segment is a 404", async () => {
    if (!client) return;
    const { error, workspaceId } = (await realUuidCastFailure("attention")) as {
      error: unknown;
      workspaceId: string;
    };
    const mapped = invalidPathIdentifierHttpError(
      error,
      `/v1/workspaces/${workspaceId}/scheduled-tasks/attention`,
    );
    expect(mapped?.status).toBe(404);
    expect(mapped).toMatchObject({
      code: "not_found",
      retryable: false,
      details: { code: "invalid_path_identifier" },
    });
    // Nested under another literal (for example `/runs`) it is still the path id.
    expect(
      invalidPathIdentifierHttpError(
        error,
        `/v1/workspaces/${workspaceId}/scheduled-tasks/attention/runs`,
      )?.status,
    ).toBe(404);
  }, 60_000);

  test("a malformed UUID that is not a path segment stays a server error", async () => {
    if (!client) return;
    const { error, workspaceId } = (await realUuidCastFailure("configured:key")) as {
      error: unknown;
      workspaceId: string;
    };
    expect(
      invalidPathIdentifierHttpError(error, `/v1/workspaces/${workspaceId}/scheduled-tasks`),
    ).toBeNull();
  }, 60_000);

  test("other errors are untouched", () => {
    const other = Object.assign(new Error('invalid input syntax for type integer: "x"'), {
      code: "22P02",
    });
    expect(invalidPathIdentifierHttpError(other, "/v1/workspaces/x")).toBeNull();
    expect(invalidPathIdentifierHttpError(new Error("boom"), "/v1/x")).toBeNull();
  });
});
