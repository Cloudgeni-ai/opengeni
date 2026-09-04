import { describe, expect, test } from "bun:test";
import { SandboxViewerAdmissionBlockedError } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import {
  httpExceptionForSandboxViewerAdmission,
  sandboxViewerAdmissionInteractionError,
} from "../src/http/sandbox-viewer-admission-error";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SANDBOX_GROUP_ID = "22222222-2222-4222-8222-222222222222";

describe("sandbox viewer admission HTTP mapping", () => {
  test("maps a credit-balance drain to HTTP 402", () => {
    const blocked = new SandboxViewerAdmissionBlockedError(
      WORKSPACE_ID,
      SANDBOX_GROUP_ID,
      "balance",
    );
    const mapped = httpExceptionForSandboxViewerAdmission(blocked);
    expect(mapped).toBeInstanceOf(HTTPException);
    expect(mapped!.status).toBe(402);
    expect(mapped!.message).toBe("insufficient OpenGeni credits for an idle sandbox viewer");
    expect(mapped!.cause).toBe(blocked);
    expect(sandboxViewerAdmissionInteractionError(blocked)).toEqual({
      code: "resource_unavailable",
      message: "insufficient OpenGeni credits for an idle sandbox viewer",
      retryable: false,
    });
  });

  test("maps a warm-allowance drain to HTTP 429", () => {
    const blocked = new SandboxViewerAdmissionBlockedError(
      WORKSPACE_ID,
      SANDBOX_GROUP_ID,
      "warm_cap",
    );
    const mapped = httpExceptionForSandboxViewerAdmission(blocked);
    expect(mapped).toBeInstanceOf(HTTPException);
    expect(mapped!.status).toBe(429);
    expect(mapped!.message).toBe("workspace sandbox warm allowance exhausted");
    expect(sandboxViewerAdmissionInteractionError(blocked)).toEqual({
      code: "resource_unavailable",
      message: "workspace sandbox warm allowance exhausted",
      retryable: false,
    });
  });

  test("leaves unrelated errors unmapped", () => {
    expect(httpExceptionForSandboxViewerAdmission(new Error("lease fenced"))).toBeNull();
    expect(httpExceptionForSandboxViewerAdmission("not an error")).toBeNull();
  });
});
