import { describe, expect, test } from "bun:test";
import {
  assertInternalApplicationsEnabled,
  internalApplicationsHttpError,
} from "../src/routes/internal-applications";
import { InternalApplicationProviderError } from "@opengeni/core";
import {
  InternalApplicationIdempotencyError,
  InternalApplicationInvariantError,
  InternalApplicationNotFoundError,
  InternalApplicationVersionConflictError,
} from "@opengeni/db";

describe("internal application route boundary", () => {
  test("is invisible unless the deployment flag is explicitly true", () => {
    for (const settings of [{}, { advancedDeploymentsEnabled: false }]) {
      expect(() => assertInternalApplicationsEnabled(settings)).toThrow();
      try {
        assertInternalApplicationsEnabled(settings);
      } catch (error) {
        expect(error).toMatchObject({ status: 404 });
      }
    }
    expect(() =>
      assertInternalApplicationsEnabled({ advancedDeploymentsEnabled: true }),
    ).not.toThrow();
  });

  test("maps bounded domain conflicts without leaking internal failures", () => {
    expect(
      internalApplicationsHttpError(new InternalApplicationNotFoundError("missing")),
    ).toMatchObject({ status: 404 });
    expect(
      internalApplicationsHttpError(new InternalApplicationVersionConflictError("changed")),
    ).toMatchObject({ status: 409 });
    expect(
      internalApplicationsHttpError(new InternalApplicationIdempotencyError("reused")),
    ).toMatchObject({ status: 409 });
    expect(
      internalApplicationsHttpError(new InternalApplicationInvariantError("blocked")),
    ).toMatchObject({ status: 422 });
    expect(
      internalApplicationsHttpError(
        new InternalApplicationProviderError("policy blocked", "policy_blocked", false),
      ),
    ).toMatchObject({ status: 422 });
    const unknown = internalApplicationsHttpError(new Error("database password leaked"));
    expect(unknown.status).toBe(500);
    expect(unknown.message).not.toContain("password");
  });
});
