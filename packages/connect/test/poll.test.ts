import { expect, test } from "bun:test";
import { pollConnectAttempt } from "../src";
import type { ConnectAttempt } from "../src";

const complete: ConnectAttempt = {
  id: "attempt",
  workspaceId: "workspace",
  providerId: "provider",
  ownership: "personal",
  revision: 1,
  state: "complete",
  credentialsCommitted: true,
  integrationInstalled: false,
  completionRequirement: "connection",
  nextAction: { type: "none" },
  expiresAt: "2030-01-01T00:00:00Z",
};
test("returns backend completion without navigating or mutating", async () => {
  expect(await pollConnectAttempt({ get: async () => complete }, "workspace", "attempt")).toEqual(
    complete,
  );
});
test("rejects another attempt", async () => {
  await expect(
    pollConnectAttempt({ get: async () => ({ ...complete, id: "other" }) }, "workspace", "attempt"),
  ).rejects.toThrow("mismatch");
});
test("deadline settles even when a transport ignores abort", async () => {
  await expect(
    pollConnectAttempt({ get: () => new Promise(() => {}) }, "workspace", "attempt", {
      timeoutMs: 5,
    }),
  ).rejects.toThrow("timed out");
});
test("already cancelled polling makes no request", async () => {
  let calls = 0;
  await expect(
    pollConnectAttempt(
      {
        get: async () => {
          calls++;
          return complete;
        },
      },
      "workspace",
      "attempt",
      { signal: AbortSignal.abort(new Error("stopped")) },
    ),
  ).rejects.toThrow("stopped");
  expect(calls).toBe(0);
});
