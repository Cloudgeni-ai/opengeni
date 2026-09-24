import { describe, expect, test } from "bun:test";
import { SandboxViewerAdmissionBlockedError } from "@opengeni/db";
import { httpExceptionForSandboxViewerAdmission } from "../src/http/sandbox-viewer-admission-error";

describe("sandbox viewer admission errors", () => {
  test("maps a credit drain to 402", () => {
    const mapped = httpExceptionForSandboxViewerAdmission(
      new SandboxViewerAdmissionBlockedError(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "balance",
      ),
    );
    expect(mapped?.status).toBe(402);
    expect(mapped?.message).toBe("insufficient OpenGeni credits for an idle sandbox viewer");
  });

  test("maps a warm-cap drain to 429", () => {
    const mapped = httpExceptionForSandboxViewerAdmission(
      new SandboxViewerAdmissionBlockedError(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "warm_cap",
      ),
    );
    expect(mapped?.status).toBe(429);
    expect(mapped?.message).toBe("workspace sandbox warm allowance exhausted");
  });

  test("ignores unrelated errors", () => {
    expect(httpExceptionForSandboxViewerAdmission(new Error("nope"))).toBeNull();
  });
});
