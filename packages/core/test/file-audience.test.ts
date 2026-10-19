import { describe, expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

import {
  FILE_PERSONAL_WORKSPACE_MESSAGE,
  FILE_PRIVATE_OWNER_MESSAGE,
  changeFileVisibility,
  fileAccessFor,
  fileVisibility,
  resolveNewFileAudience,
} from "../src/domain/file-audience";

// None of these branches reads the database: an Only me chat already is Only
// me, and sharing never needs the organization's Only me setting.
const db = {} as Database;
const settings = {} as Parameters<typeof resolveNewFileAudience>[0]["settings"];
const team = { id: "11111111-1111-4111-8111-111111111111", kind: "shared" } as const;
const personal = { ...team, kind: "personal" } as const;

describe("a new file's audience", () => {
  test("follows the chat by default", async () => {
    expect(
      await resolveNewFileAudience({
        db,
        settings,
        workspace: team,
        chatOwner: "user:ada",
        person: "user:ada",
        requested: undefined,
      }),
    ).toEqual({ privateOwnerSubjectId: "user:ada", ownerSubjectId: "user:ada" });
    expect(
      await resolveNewFileAudience({
        db,
        settings,
        workspace: team,
        chatOwner: null,
        person: "user:ada",
        requested: undefined,
      }),
    ).toEqual({ privateOwnerSubjectId: null, ownerSubjectId: "user:ada" });
  });

  test("an explicit workspace choice shares it on the chat owner's behalf", async () => {
    expect(
      await resolveNewFileAudience({
        db,
        settings,
        workspace: team,
        chatOwner: "user:ada",
        person: "user:ada",
        requested: "workspace",
      }),
    ).toEqual({ privateOwnerSubjectId: null, ownerSubjectId: "user:ada" });
  });

  test("Only me needs a person, and a personal workspace keeps everything private", async () => {
    await expect(
      resolveNewFileAudience({
        db,
        settings,
        workspace: team,
        chatOwner: null,
        person: null,
        requested: "private",
      }),
    ).rejects.toThrow(FILE_PRIVATE_OWNER_MESSAGE);
    expect(
      await resolveNewFileAudience({
        db,
        settings,
        workspace: personal,
        chatOwner: null,
        person: "user:ada",
        requested: "workspace",
      }),
    ).toEqual({ privateOwnerSubjectId: "user:ada", ownerSubjectId: "user:ada" });
  });
});

describe("who can open a file", () => {
  test("says it in one plain sentence for the agent", async () => {
    expect(
      await fileAccessFor(db, {
        workspace: { name: "Design", kind: "shared" },
        file: { scope: "workspace", ownerSubjectId: null },
      }),
    ).toEqual({
      visibility: "workspace",
      whoCanOpen: "Everyone in the workspace “Design” can open this file.",
    });
    expect(
      await fileAccessFor(db, {
        workspace: { name: "Design", kind: "shared" },
        file: { scope: "personal", ownerSubjectId: "service:agent" },
      }),
    ).toEqual({
      visibility: "private",
      whoCanOpen:
        "Only you can open this file. Anyone else who opens its link is told it is private.",
    });
    expect(
      (
        await fileAccessFor(db, {
          workspace: { name: "Mine", kind: "personal" },
          file: { scope: "personal", ownerSubjectId: null },
        })
      ).whoCanOpen,
    ).toBe("Only you can open this file; it is in a personal workspace.");
    expect(fileVisibility({ scope: "personal" })).toBe("private");
    expect(fileVisibility({ scope: "workspace" })).toBe("workspace");
  });
});

test("a personal workspace has nobody to share a file with", async () => {
  const refused = await changeFileVisibility({
    db,
    settings,
    grant: {
      accountId: "a",
      workspaceId: personal.id,
      subjectId: "user:ada",
      permissions: ["files:upload"],
      principalKind: "human_session",
    },
    workspace: personal,
    person: "user:ada",
    fileId: "22222222-2222-4222-8222-222222222222",
    visibility: "workspace",
  }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HTTPException);
  expect((refused as HTTPException).status).toBe(422);
  expect((refused as HTTPException).message).toBe(FILE_PERSONAL_WORKSPACE_MESSAGE);
});
