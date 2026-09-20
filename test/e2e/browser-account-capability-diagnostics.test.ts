import { expect, test } from "bun:test";
import {
  capabilityMatcherDiagnostics,
  createCapabilityDiagnostics,
} from "./browser-account-capability-diagnostics";

const path =
  "/v1/workspaces/00000000-0000-4000-8000-000000000001/sessions/00000000-0000-4000-8000-000000000002/stream-capabilities";
const url = `https://example.test${path}`;
const phase = "slot-revocation-reauthentication";
const error = "Failed to load resource: the server responded with a status of 404 (Not Found)";

test("pre-arm requests and late console batches remain distinct across a gate clear", () => {
  let clock = 0;
  const ledger = createCapabilityDiagnostics(() => ++clock);
  const request = {};
  ledger.request(request, phase, url, "GET", "7");
  const first = ledger.beginGate(phase);
  ledger.countedGate(phase, first);
  ledger.clearedGate(phase, first);
  ledger.boundary(phase, "resume-arm-begin");
  ledger.boundary(phase, "resume-arm-end");
  ledger.response(request, phase, 404);
  ledger.terminal(request, phase, "finished");
  ledger.console(phase, url, error);
  ledger.console(phase, url, error);
  const second = ledger.beginGate(phase);
  ledger.countedGate(phase, second);
  const trace = ledger.snapshot();
  expect(trace.events.filter((event) => event.kind === "request")).toHaveLength(1);
  expect(
    trace.events.filter((event) => event.kind === "console").map((event) => event.consoleId),
  ).toEqual([1, 2]);
  expect(
    trace.events.filter((event) => event.boundary === "counted").map((event) => event.consoleIds),
  ).toEqual([[], [1, 2]]);
  const dispatch = trace.events.find((event) => event.kind === "request")!;
  const clear = trace.events.find((event) => event.boundary === "cleared")!;
  const arm = trace.events.find((event) => event.boundary === "resume-arm-end")!;
  const response = trace.events.find((event) => event.kind === "response")!;
  expect(dispatch.runnerMs).toBeLessThan(clear.runnerMs);
  expect(clear.runnerMs).toBeLessThan(arm.runnerMs);
  expect(arm.runnerMs).toBeLessThan(response.runnerMs);
  expect(response.requestId).toBe(dispatch.requestId);
  expect(trace.correlation).toBe("console-and-request-ids-are-independent");
  expect(trace.events.map((event) => event.sequence)).toEqual(
    trace.events.map((_, index) => index + 1),
  );
});

test("delayed authority resolution is an event and cannot mutate an earlier snapshot", async () => {
  const ledger = createCapabilityDiagnostics(() => 100);
  const request = {};
  ledger.request(request, "dispatch", url, "GET", "7");
  let resolve!: (value: string | null) => void;
  const authority = new Promise<string | null>((done) => {
    resolve = done;
  });
  const observed = authority.then((value) => ledger.authority(request, "later-phase", value));
  const before = ledger.snapshot();
  const serialized = JSON.stringify(before);
  expect(before.events[0]!.authorityState).toBe("pending");
  resolve("a".repeat(64));
  await observed;
  expect(JSON.stringify(before)).toBe(serialized);
  expect(ledger.snapshot().events[1]).toMatchObject({
    kind: "authority",
    phase: "later-phase",
    authorityState: "resolved",
    authorityHash: "a".repeat(64),
  });
  ledger.authority(request, "unavailable-phase", null);
  expect(ledger.snapshot().events[2]!.authorityState).toBe("unavailable");
});

test("response headers are not a terminal and failures preserve per-event phase", () => {
  const ledger = createCapabilityDiagnostics(() => 100);
  const request = {};
  ledger.request(request, "before", url, "GET", "7");
  ledger.response(request, "headers", 404);
  expect(ledger.snapshot().events.map((event) => event.kind)).toEqual(["request", "response"]);
  ledger.terminal(request, "after", "failed");
  expect(ledger.snapshot().events.map((event) => event.phase)).toEqual([
    "before",
    "headers",
    "after",
  ]);
  expect(ledger.snapshot().events.filter((event) => event.kind === "finished")).toHaveLength(0);
});

test("collection is bounded and reports incomplete evidence instead of silently dropping it", () => {
  const ledger = createCapabilityDiagnostics(() => 100);
  for (let index = 0; index < 700; index++) ledger.console(phase, url, error);
  ledger.countedGate(phase, ledger.beginGate(phase));
  const trace = ledger.snapshot();
  expect(trace.complete).toBe(false);
  expect(trace.dropped.events).toBeGreaterThan(0);
  expect(trace.dropped.bytes).toBeGreaterThan(0);
  expect(trace.dropped.consoleIds).toBeGreaterThan(0);
  expect(trace.events.length).toBeLessThanOrEqual(trace.limits.events);
  expect(Buffer.byteLength(JSON.stringify(trace))).toBeLessThanOrEqual(trace.limits.bytes);
});

test("only endpoint identity and allowlisted fields survive; credentials and query values do not", () => {
  const ledger = createCapabilityDiagnostics(() => 100);
  const request = {};
  const sensitiveUrl = `https://secret-user:secret-password@example.test${path}?token=secret-query#secret-fragment`;
  ledger.request(request, phase, sensitiveUrl, "secret-method", "secret-actor");
  ledger.authority(request, phase, "secret-cookie");
  ledger.console(phase, sensitiveUrl, "secret-console-token");
  ledger.request({}, phase, "https://example.test/irrelevant?secret", "GET", "7");
  const matcher = capabilityMatcherDiagnostics(
    { url: sensitiveUrl, phase, actorEpoch: "secret-actor", authorityHash: "secret-cookie" },
    { requestId: null, reason: "expected-identity" },
  );
  const serialized = JSON.stringify({ trace: ledger.snapshot(), matcher });
  expect(serialized).not.toContain("secret-");
  expect(serialized).not.toContain("token=");
  expect(ledger.snapshot().events[0]).toMatchObject({
    pathname: path,
    queryPresent: true,
    method: "OTHER",
    actorEpoch: null,
  });
  expect(matcher.expected.authorityHash).toBeNull();
  expect(ledger.snapshot().events.filter((event) => event.kind === "request")).toHaveLength(1);
});
