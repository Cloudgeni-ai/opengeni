import { describe, expect, test } from "bun:test";
import {
  CodemodeAuthorityError,
  CodemodeCatalogNotReadyError,
  requireMatchingCodemodeCatalog,
  type CodemodeGrantAuthority,
} from "../src/codemode";
import type { AttemptToolCatalog } from "@opengeni/contracts";

function authority(): CodemodeGrantAuthority {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 3,
    subjectId: "sandbox:test-session",
  };
}

function catalog(scope: CodemodeGrantAuthority): AttemptToolCatalog {
  return {
    version: 1,
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    attemptId: scope.attemptId,
    executionGeneration: scope.executionGeneration,
    generation: 1,
    digest: "0".repeat(64),
    createdAt: new Date().toISOString(),
    entries: [],
  };
}

describe("Codemode attempt catalog authority", () => {
  test("reports an active attempt whose catalog is not ready without blaming bearer authority", () => {
    const scope = authority();

    expect(() => requireMatchingCodemodeCatalog(scope, null)).toThrow(CodemodeCatalogNotReadyError);
    try {
      requireMatchingCodemodeCatalog(scope, null);
      throw new Error("expected catalog readiness failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "codemode_catalog_not_ready",
        message: "Codemode tool catalog is not ready for the active execution attempt",
      });
    }
  });

  test("retains a distinct fail-closed error for a mismatched catalog", () => {
    const scope = authority();
    const mismatched = {
      ...catalog(scope),
      executionGeneration: scope.executionGeneration + 1,
    };

    expect(() => requireMatchingCodemodeCatalog(scope, mismatched)).toThrow(CodemodeAuthorityError);
    try {
      requireMatchingCodemodeCatalog(scope, mismatched);
      throw new Error("expected catalog authority failure");
    } catch (error) {
      expect(error).toMatchObject({
        reason: "catalog_mismatch",
        code: "codemode_catalog_mismatch",
        message: "Codemode tool catalog does not match the active execution attempt",
      });
    }
  });

  test("returns the exact catalog when every attempt authority field matches", () => {
    const scope = authority();
    const exact = catalog(scope);

    expect(requireMatchingCodemodeCatalog(scope, exact)).toBe(exact);
  });
});
