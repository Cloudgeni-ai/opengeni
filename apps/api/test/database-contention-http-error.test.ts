import { describe, expect, test } from "bun:test";
import { SessionEventPersistenceError } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import {
  ApiHttpError,
  DATABASE_CONTENTION_ERROR_DETAIL_CODE,
  databaseContentionHttpError,
} from "../src/http/api-error";

function driverError(code: string) {
  return Object.assign(new Error("deadlock detected"), { code, severity: "ERROR" });
}

describe("databaseContentionHttpError", () => {
  test("a deadlock victim wrapped in an opaque 500 becomes a typed retryable 503", () => {
    const error = new HTTPException(500, {
      message: "Codemode request failed",
      cause: new Error("Failed query", { cause: driverError("40P01") }),
    });
    const mapped = databaseContentionHttpError(error, "POST", { outcomeUnknown: false });
    expect(mapped).toBeInstanceOf(ApiHttpError);
    expect(mapped?.status).toBe(503);
    expect(mapped?.code).toBe("upstream_unavailable");
    expect(mapped?.retryable).toBe(true);
    expect(mapped?.outcomeUnknown).toBe(false);
    expect(mapped?.details).toEqual({
      code: DATABASE_CONTENTION_ERROR_DETAIL_CODE,
      sqlState: "40P01",
    });
  });

  test("an exhausted in-process retry keeps its SQLSTATE through the persistence wrapper", () => {
    const exhausted = new SessionEventPersistenceError(
      {
        code: "db_serialization_failure",
        sqlState: "40001",
        stage: "codemode.operation.submit",
        eventTypes: [],
        correlationId: crypto.randomUUID(),
        attempts: 3,
        retryOutcome: "exhausted",
        database: {},
      } as unknown as ConstructorParameters<typeof SessionEventPersistenceError>[0],
      driverError("40001"),
    );
    expect(databaseContentionHttpError(exhausted, "GET")?.details?.sqlState).toBe("40001");
  });

  test("a mutation defaults to outcome-unknown; a read does not", () => {
    const error = driverError("40P01");
    expect(databaseContentionHttpError(error, "POST")?.outcomeUnknown).toBe(true);
    expect(databaseContentionHttpError(error, "GET")?.outcomeUnknown).toBe(false);
  });

  test("leaves other failures and client errors alone", () => {
    expect(databaseContentionHttpError(driverError("23505"), "POST")).toBeNull();
    expect(databaseContentionHttpError(new Error("boom"), "POST")).toBeNull();
    expect(
      databaseContentionHttpError(
        new HTTPException(409, { message: "conflict", cause: driverError("40P01") }),
        "POST",
      ),
    ).toBeNull();
  });
});
