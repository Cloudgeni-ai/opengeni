import { expect, test } from "bun:test";
import type { AppServerStatus } from "@opengeni/contracts";
import { appServerStatusLabel } from "./app-server-status";

const status = (patch: Partial<AppServerStatus>): AppServerStatus => ({
  hasCode: true,
  available: true,
  errorsToday: 0,
  runsToday: 4,
  lastError: null,
  egress: [],
  secrets: [],
  ...patch,
});

test("the server code line shows only when there is something to act on", () => {
  expect(appServerStatusLabel(null)).toBeNull();
  expect(appServerStatusLabel(status({ hasCode: false, errorsToday: 3 }))).toBeNull();
  expect(appServerStatusLabel(status({}))).toBeNull();
  expect(appServerStatusLabel(status({ errorsToday: 1 }))).toBe("Server code: 1 error today");
  expect(appServerStatusLabel(status({ errorsToday: 2 }))).toBe("Server code: 2 errors today");
  expect(appServerStatusLabel(status({ available: false }))).toBe(
    "Server code: not available here",
  );
});
