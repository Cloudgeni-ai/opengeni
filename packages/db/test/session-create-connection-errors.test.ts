import { expect, test } from "bun:test";
import {
  sessionCreateConnectionSelectionFailure,
  SessionCreateConnectionSelectionUnavailableError,
} from "../src/mcp-account-bindings";

function driver(message = "MCP workspace account identity changed") {
  return Object.assign(new Error(message), {
    code: "42501",
    where: "PL/pgSQL function opengeni_private.fence_mcp_account_bindings() line 132 at RAISE",
    detail: "private-diagnostic",
    query: "private-query",
    parameters: ["private-credential"],
  });
}

test("only known exact connection-fence denials become value-free non-retryable create errors", () => {
  for (const message of [
    "MCP workspace account missing",
    "MCP workspace account identity changed",
  ]) {
    for (const wrapped of [
      driver(message),
      new Error("private-query-wrapper", { cause: driver(message) }),
    ]) {
      const result = sessionCreateConnectionSelectionFailure(wrapped);
      expect(result).toBeInstanceOf(SessionCreateConnectionSelectionUnavailableError);
      expect(result?.cause).toBe(wrapped);
      expect(result?.retryable).toBe(false);
      expect(result?.message).toContain("current authorized connection selection");
      expect(result?.message).not.toContain("private-");
      expect(JSON.stringify(result)).not.toContain("private-");
    }
  }
});

test("unrelated authorization, integrity and transport failures are not relabeled", () => {
  for (const error of [
    new Error("MCP workspace account identity changed"),
    Object.assign(driver(), { code: "40P01" }),
    Object.assign(driver(), { code: "ECONNRESET" }),
    Object.assign(driver(), { where: "PL/pgSQL function unrelated() line 1 at RAISE" }),
    Object.assign(driver(), { message: "accepted MCP account bindings are immutable" }),
    Object.assign(driver(), { message: "MCP workspace account identity changed: private-value" }),
    // Never combine a wrapper's SQLSTATE with a different child's message.
    Object.assign(new Error("outer"), {
      code: "42501",
      cause: Object.assign(driver(), { code: "23514" }),
    }),
    { code: "42501", message: "permission denied", cause: null },
  ]) {
    expect(sessionCreateConnectionSelectionFailure(error)).toBeNull();
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.cause = cyclic;
  expect(sessionCreateConnectionSelectionFailure(cyclic)).toBeNull();
  expect(
    sessionCreateConnectionSelectionFailure({ errors: Array.from({ length: 100 }, () => ({})) }),
  ).toBeNull();
});
