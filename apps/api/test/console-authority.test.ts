import { describe, expect, test } from "bun:test";
import type { AccessContext } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import { hasPermission } from "@opengeni/core";
import { consoleWindow } from "../src/routes/console";
import {
  consoleAccessCovers,
  requireConsoleAccessForContext,
  resolveConsoleAccess,
} from "../src/routes/console-roles";
import {
  CONSOLE_TEST_CHAT_PERMISSIONS,
  consoleTestChatSubjectId,
} from "../src/routes/organization-agents";

const organizationId = "11111111-1111-4111-8111-111111111111";
// Console agents (and with them members' Console roles) are on for this organization.
const settings = { orgAgentsAccountIds: [organizationId] } as unknown as Settings;

function context(subjectId: string, permissions: string[], role?: string): AccessContext {
  return {
    mode: "local",
    subjectId,
    accountGrants: [
      {
        accountId: organizationId,
        subjectId,
        permissions: permissions as AccessContext["accountGrants"][number]["permissions"],
        ...(role ? { role } : {}),
      } as AccessContext["accountGrants"][number],
    ],
    workspaceGrants: [],
    defaultAccountId: organizationId,
    defaultWorkspaceId: null,
  };
}

describe("Opengeni Console authority", () => {
  // None of these callers needs a stored Console role, so the database is never read.
  const noDb = new Proxy(
    {},
    {
      get() {
        throw new Error("the database must not be read here");
      },
    },
  ) as Parameters<typeof requireConsoleAccessForContext>[0]["db"];

  test("an organization administrator may open Console", async () => {
    const admin = await requireConsoleAccessForContext(
      { db: noDb, settings },
      context("user:admin", ["account:admin"]),
      organizationId,
      "full",
    );
    expect(admin).toMatchObject({ subjectId: "user:admin", access: "full" });
  });

  test("API keys and a product's end users never may, even with admin permissions", async () => {
    for (const subjectId of [
      "api_key:22222222-2222-4222-8222-222222222222",
      "external_user:33333333-3333-4333-8333-333333333333",
    ]) {
      await expect(
        requireConsoleAccessForContext(
          { db: noDb, settings },
          context(subjectId, ["account:admin"]),
          organizationId,
          "viewer",
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  test("people without Console standing and other organizations are refused", async () => {
    await expect(
      requireConsoleAccessForContext(
        { db: noDb, settings },
        context("user:member", ["account:read"]),
        organizationId,
        "viewer",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      requireConsoleAccessForContext(
        { db: noDb, settings },
        context("user:admin", ["account:admin"]),
        "44444444-4444-4444-8444-444444444444",
        "viewer",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("ranges are rolling windows ending now", () => {
    const now = new Date("2026-11-12T12:00:00.000Z");
    expect(consoleWindow("7d", now)).toEqual({
      since: "2026-11-05T12:00:00.000Z",
      until: "2026-11-12T12:00:00.000Z",
    });
  });

  test("API keys and end users hold no Console role and never reach the database", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be read for a key or end user");
        },
      },
    ) as Parameters<typeof resolveConsoleAccess>[0]["db"];
    for (const subjectId of [
      "api_key:22222222-2222-4222-8222-222222222222",
      "external_user:33333333-3333-4333-8333-333333333333",
    ]) {
      const caller = context(subjectId, ["account:admin"]);
      expect(await resolveConsoleAccess({ db, settings }, caller, organizationId)).toBe("none");
      for (const needed of ["viewer", "editor", "full"] as const) {
        await expect(
          requireConsoleAccessForContext({ db, settings }, caller, organizationId, needed),
        ).rejects.toMatchObject({ status: 403 });
      }
    }
  });

  test("Console access levels cover only what is at or below them", () => {
    expect(consoleAccessCovers("none", "viewer")).toBe(false);
    expect(consoleAccessCovers("viewer", "viewer")).toBe(true);
    expect(consoleAccessCovers("viewer", "editor")).toBe(false);
    expect(consoleAccessCovers("editor", "editor")).toBe(true);
    expect(consoleAccessCovers("editor", "full")).toBe(false);
    expect(consoleAccessCovers("full", "full")).toBe(true);
  });

  test("a test chat runs as the tester's own service principal, which never manages anything", () => {
    expect(consoleTestChatSubjectId("user:editor")).toBe("console-test:user:editor");
    expect(consoleTestChatSubjectId("user:editor")).not.toBe(
      consoleTestChatSubjectId("user:other"),
    );
    for (const mode of ["explicit", "legacy"] as const) {
      for (const permission of [
        "agents:manage",
        "workspace:admin",
        "api_keys:manage",
        "members:manage",
      ] as const) {
        expect(hasPermission([...CONSOLE_TEST_CHAT_PERMISSIONS], permission, mode)).toBe(false);
      }
    }
  });
});
