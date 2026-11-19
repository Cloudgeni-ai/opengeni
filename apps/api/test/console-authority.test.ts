import { describe, expect, test } from "bun:test";
import type { AccessContext } from "@opengeni/contracts";
import { consoleWindow, requireConsoleAdministratorContext } from "../src/routes/console";
import {
  CONSOLE_ACCESS_CLEANUP_FAILED,
  consoleAccessCovers,
  requireConsoleAccessForContext,
  revokeConsoleTestAccessAfterMembershipChange,
  resolveConsoleAccess,
  revokeConsoleTestWorkspaceAccess,
} from "../src/routes/console-roles";

const organizationId = "11111111-1111-4111-8111-111111111111";

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
  test("an organization administrator may open Console", () => {
    const admin = requireConsoleAdministratorContext(
      context("user:admin", ["account:admin"]),
      organizationId,
    );
    expect(admin.subjectId).toBe("user:admin");
  });

  test("API keys and a product's end users never may, even with admin permissions", () => {
    for (const subjectId of [
      "api_key:22222222-2222-4222-8222-222222222222",
      "external_user:33333333-3333-4333-8333-333333333333",
    ]) {
      expect(() =>
        requireConsoleAdministratorContext(context(subjectId, ["account:admin"]), organizationId),
      ).toThrow("owners and admins");
    }
  });

  test("members and other organizations are refused", () => {
    expect(() =>
      requireConsoleAdministratorContext(context("user:member", ["account:read"]), organizationId),
    ).toThrow("owners and admins");
    expect(() =>
      requireConsoleAdministratorContext(
        context("user:admin", ["account:admin"]),
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toThrow("owners and admins");
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
      expect(await resolveConsoleAccess({ db }, caller, organizationId)).toBe("none");
      for (const needed of ["viewer", "editor", "full"] as const) {
        await expect(
          requireConsoleAccessForContext({ db }, caller, organizationId, needed),
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

  test("a Console test workspace access removal that fails is a retryable 503, never silent", async () => {
    const failing = new Proxy(
      {},
      {
        get() {
          throw new Error("database unavailable");
        },
      },
    );
    const errors: string[] = [];
    const deps = {
      db: failing,
      observability: { error: (message: string) => errors.push(message), warn: () => undefined },
    } as unknown as Parameters<typeof revokeConsoleTestWorkspaceAccess>[0];
    const expected = {
      status: 503,
      retryable: true,
      details: { code: CONSOLE_ACCESS_CLEANUP_FAILED },
    };
    await expect(
      revokeConsoleTestWorkspaceAccess(deps, {
        organizationId,
        subjectId: "user:someone",
        actorSubjectId: "user:admin",
      }),
    ).rejects.toMatchObject(expected);
    await expect(
      revokeConsoleTestAccessAfterMembershipChange(deps, {
        organizationId,
        subjectId: "user:someone",
        actorSubjectId: "user:admin",
        reason: "organization_role_changed",
        organizationRole: "member",
      }),
    ).rejects.toMatchObject(expected);
    expect(errors.length).toBe(2);
  });
});
