import { describe, expect, test } from "bun:test";
import type { AccessContext } from "@opengeni/contracts";
import { consoleWindow, requireConsoleAdministratorContext } from "../src/routes/console";

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
});
