import { expect, test } from "bun:test";
import { createAccountBootstrapDiagnostics } from "./browser-account-bootstrap-diagnostics";

test("active bootstrap evidence survives unrelated traffic and completed-history eviction", () => {
  const diagnostics = createAccountBootstrapDiagnostics();
  const held = {};
  diagnostics.receive(held, "GET", "/v1/auth/session-set");
  diagnostics.dispatch(held);
  for (let index = 0; index < 2048; index += 1) {
    const request = {};
    diagnostics.receive(request, "GET", "/v1/workspaces");
    diagnostics.dispatch(request);
    diagnostics.settle(request, "resolved", 200);
  }
  expect(diagnostics.snapshot().receivedCount).toBe(1);
  for (let index = 0; index < 140; index += 1) {
    const request = {};
    diagnostics.receive(request, "GET", "/v1/auth/session-set");
    diagnostics.dispatch(request);
    diagnostics.settle(request, "resolved", 200);
  }
  const beforeSettlement = diagnostics.snapshot();
  expect(beforeSettlement.pending).toHaveLength(1);
  expect(beforeSettlement.pending[0]).toMatchObject({ sequence: 1, outcome: "pending" });
  expect(beforeSettlement.completed).toHaveLength(128);
  expect(beforeSettlement.discardedCompletedCount).toBe(12);
  diagnostics.settle(held, "rejected", null);
  expect(diagnostics.snapshot().pending).toHaveLength(0);
  expect(diagnostics.snapshot().completed.at(-1)).toMatchObject({
    sequence: 1,
    outcome: "rejected",
    status: null,
  });
  expect(beforeSettlement.pending[0]?.outcome).toBe("pending");
});
