import { expect, test } from "bun:test";
import { createAccountReadDiagnostics } from "./browser-account-read-diagnostics";

test("server handler resolution never stands in for browser headers or delivery", () => {
  let time = 100;
  const ledger = createAccountReadDiagnostics(() => time);
  const browserBilling = {};
  const serverBilling = {};
  const heldWorkspace = {};
  ledger.start("browser", browserBilling, "GET", "/v1/billing");
  ledger.start("browser", heldWorkspace, "GET", "/v1/workspaces");
  ledger.markHeld(heldWorkspace);
  time = 105;
  ledger.start("server", serverBilling, "GET", "/v1/billing");
  time = 110;
  ledger.response("server", serverBilling, 200);
  ledger.finish("server", serverBilling, "handler-resolved");
  const beforeHeaders = ledger.snapshot();
  expect(beforeHeaders.correlation).toBe("independent-streams");
  expect(beforeHeaders.browser[0]).toMatchObject({
    responseMs: null,
    status: null,
    terminal: "pending",
    intentionallyHeld: false,
  });
  expect(beforeHeaders.browser[1]?.intentionallyHeld).toBe(true);
  expect(beforeHeaders.server[0]).toMatchObject({
    startedMs: 5,
    responseMs: 10,
    status: 200,
    terminal: "handler-resolved",
    terminalMs: 10,
  });
  time = 120;
  ledger.response("browser", browserBilling, 200);
  expect(ledger.snapshot().browser[0]).toMatchObject({ responseMs: 20, terminal: "pending" });
  time = 125;
  ledger.finish("browser", browserBilling, "finished");
  expect(ledger.snapshot().browser[0]).toMatchObject({ terminalMs: 25, terminal: "finished" });
  expect(beforeHeaders.browser[0]?.responseMs).toBeNull();
});

test("read evidence is bounded and rejects arbitrary metadata", () => {
  const ledger = createAccountReadDiagnostics(() => 0);
  const secret = "synthetic-sensitive-account-cookie-error";
  for (let index = 0; index < 40; index += 1) {
    const key = {};
    ledger.start("browser", key, "GET", `/v1/${secret}`);
    ledger.response("browser", key, Number.NaN);
    ledger.finish("browser", key, "failed");
    ledger.start("server", key, "GET", `/v1/workspaces/${secret}/sessions`);
    ledger.finish("server", key, "handler-rejected");
  }
  const evidence = ledger.snapshot();
  expect(evidence.browser).toHaveLength(32);
  expect(evidence.server).toHaveLength(32);
  expect(evidence.dropped).toEqual({ browser: 8, server: 8 });
  expect(
    evidence.browser.every((entry) => entry.status === null && entry.route === "other-api-read"),
  ).toBe(true);
  expect(evidence.server.every((entry) => entry.route === "workspace-read")).toBe(true);
  expect(JSON.stringify(evidence)).not.toContain(secret);
  ledger.finish("server", {}, "handler-rejected");
  ledger.response("browser", {}, 200);
  ledger.markHeld({});
  expect(ledger.snapshot()).toEqual(evidence);
});

test("read diagnostics exclude mutations, assets and streams without altering their owners", () => {
  const ledger = createAccountReadDiagnostics(() => 0);
  ledger.start("browser", {}, "GET", "/assets/app.js");
  ledger.start("browser", {}, "POST", "/v1/auth/session-set/select");
  ledger.start("browser", {}, "secret-method", "/v1/billing");
  ledger.start("browser", {}, "GET", "/v1/workspaces/workspace/live-events/stream");
  ledger.start("browser", {}, "GET", "/v1/workspaces/workspace/events/stream");
  expect(ledger.snapshot().browser).toEqual([]);
  const key = {};
  ledger.start("browser", key, "POST", "/v1/workspaces/workspace/knowledge/entries/search");
  ledger.start("browser", key, "POST", "/v1/workspaces/workspace/knowledge/entries/search");
  expect(ledger.snapshot().browser).toHaveLength(1);
  expect(ledger.snapshot().browser[0]).toMatchObject({ method: "POST", route: "knowledge-search" });
  ledger.start("server", {}, "GET", "/v1/auth/session-set");
  expect(ledger.snapshot().server[0]?.route).toBe("session-set");
});
