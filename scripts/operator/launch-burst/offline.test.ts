import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { SessionEvent } from "../../../packages/contracts/src/index";
import {
  coalesceSessionEventDeltasWithCoverage,
  formatSessionEventSse,
} from "../../../packages/events/src/index";
import { Authorization, Cohort, digest, Intent, intentDigest, STAGING_ORIGIN } from "./config";
import { verificationPath } from "./auth";
import { HumanHttp, type FetchLike } from "./http";
import {
  correlateTemporal,
  exactQuantiles,
  summarize,
  TurnObserver,
  type Sample,
} from "./measurements";
import { parseCli } from "./run";
import { runBurst } from "./runner";

const sha = "a".repeat(40);
const parent = "a1234567-1234-4234-8234-123456789abc";
const now = Date.parse("2026-10-03T13:00:00.000Z");
const env = {
  OPENGENI_BURST_PARENT_SESSION_ID: parent,
  OPENGENI_BURST_GATE_TOKEN: "offline-only-test-gate-token-32-characters",
  BURST_COOKIE: "better-auth.session_token=offline-fixture",
  BURST_PASSWORD: "offline-password-not-a-real-credential",
};
async function setup(mode: "plain" | "sandbox" | "fresh" = "plain") {
  const intent = Intent.parse(
    JSON.parse(
      await readFile(
        new URL(mode === "fresh" ? "fresh50.intent.json" : `${mode}.intent.json`, import.meta.url),
        "utf8",
      ),
    ),
  );
  const identities = Array.from({ length: intent.count }, (_, i) =>
    mode === "fresh"
      ? {
          kind: "fresh",
          label: `fresh-${i}`,
          email: `fresh-${i}@example.test`,
          passwordEnv: "BURST_PASSWORD",
          organizationName: `Offline fixture ${i}`,
        }
      : {
          kind: "existing",
          label: `existing-${i}`,
          workspaceId: crypto.randomUUID(),
          cookieEnv: "BURST_COOKIE",
        },
  );
  const cohortText = JSON.stringify(Cohort.parse({ schemaVersion: 1, identities }));
  const authorization = Authorization.parse({
    schemaVersion: 1,
    parentSessionId: parent,
    sourceSha: sha,
    intentDigest: intentDigest(intent),
    cohortDigest: digest(cohortText),
    gateTokenDigest: digest(env.OPENGENI_BURST_GATE_TOKEN),
    reliability: {
      confirmationRef: "offline-fixture-reliability",
      confirmedAt: "2026-10-03T12:58:00.000Z",
      apiMemoryOomFixed: true,
      workerCleanupSelfTerminationFixed: true,
      emptyOutputFixed: true,
      stuckWakesFixed: true,
    },
    monitoring: {
      confirmationRef: "offline-fixture-monitoring",
      confirmedAt: "2026-10-03T12:59:00.000Z",
      launchDashboardLiveOnStaging: true,
    },
    authorizationRef: "offline-fixture-parent-authorization",
    issuedAt: "2026-10-03T13:00:00.000Z",
    expiresAt: "2026-10-03T13:20:00.000Z",
  });
  let mono = 0;
  return {
    intent,
    cohortText,
    authorization,
    env: { ...env },
    sourceSha: sha,
    execute: true,
    confirm: true,
    clock: { now: () => now, wall: () => new Date(now).toISOString(), mono: () => ++mono },
    verificationReader: async (identity: { label: string }) =>
      `${STAGING_ORIGIN}/v1/auth/verify-email?token=${identity.label}`,
  };
}
function sample(): Sample {
  return {
    label: "fixture",
    identityDigest: digest("fixture"),
    requestedSessionId: crypto.randomUUID(),
    sessionId: null,
    workspaceId: null,
    turnId: null,
    attemptIds: [],
    correlationId: crypto.randomUUID(),
    status: "not_started",
    stage: "stream",
    httpStatus: null,
    errorCode: null,
    signupMs: null,
    promptSentAt: null,
    sentMonoMs: 0,
    acceptedMs: null,
    workerStartMs: null,
    firstOutputMs: null,
    completionMs: null,
    receiptToOutputMs: null,
    sandboxEstablishMs: null,
    sandboxEstablishServerMs: null,
    firstCommandMs: null,
    commandCount: 0,
    commandExitCode: null,
    cleanup: "not_requested",
    terminalObservedAt: null,
  };
}
const turnId = "b1234567-1234-4234-8234-123456789abc";
const event = (
  sequence: number,
  type: SessionEvent["type"],
  payload: Record<string, unknown> = {},
  id: string | null = turnId,
) => ({
  id: crypto.randomUUID(),
  workspaceId: parent,
  sessionId: parent,
  sequence,
  type,
  payload,
  turnId: id,
  occurredAt: "2026-10-03T13:00:00.000Z",
});
function sseFrames(frames: string[], chunkBytes = 23) {
  const bytes = new TextEncoder().encode(frames.join(""));
  // Include chunk boundaries through ids and JSON; use the production SDK parser.
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkBytes)
          controller.enqueue(bytes.slice(i, i + chunkBytes));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function sse(events: SessionEvent[], compact = false) {
  const projection = compact ? coalesceSessionEventDeltasWithCoverage(events) : null;
  return sseFrames(
    (projection?.events ?? events).map((value) =>
      formatSessionEventSse(
        value,
        projection?.coveredThroughBySequence.get(value.sequence) ?? value.sequence,
      ),
    ),
  );
}
function fixtureFetch(
  mode: "plain" | "sandbox" | "fresh",
  outcome = "success",
  authMode = "legacy",
  streamResponse: (events: ReturnType<typeof event>[]) => Response = sse,
) {
  const calls: Array<{
    path: string;
    method: string;
    body: Record<string, unknown> | null;
    headers: Headers;
  }> = [];
  const onboarded = new Set<string>();
  const emails = new Map<string, string>();
  const users = new Map<string, string>();
  const sessions = new Map<string, string>();
  const slots = new Map<string, string>();
  const projection = (correlation: string, selected = false) => ({
    mode: authMode,
    generation: selected ? "3" : "1",
    actorEpoch: selected ? "2" : "1",
    csrfToken: "f".repeat(32),
    state: "ready",
    selectedSlotId: selected ? slots.get(correlation) : null,
    slots: slots.has(correlation)
      ? [
          {
            id: slots.get(correlation),
            displayName: "Fixture",
            state: "active",
            verifiedClaim: { kind: "email", value: emails.get(correlation) },
          },
        ]
      : [],
  });
  const fetchImpl = (async (url: URL | Request | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method, body, headers });
    const correlation = headers.get("x-opengeni-correlation-id")!;
    const json = (value: unknown, extra: Record<string, string> = {}) =>
      Response.json(value, { headers: extra });
    if (path === "/v1/config/client")
      return json({
        deploymentRevision: "fixture-release",
        apiContractRevision: "fixture-contract",
        managedAuthSessionSetMode: authMode,
        defaultSandboxBackend: "modal",
        auth: { mode: "managedSession", emailVerificationRequired: true, newSignupsEnabled: true },
      });
    if (path === "/v1/auth/session-set")
      return json(projection(correlation), { "set-cookie": "opengeni.session_set=fixture" });
    if (path === "/v1/auth/session-set/transactions")
      return json(
        {
          id: crypto.randomUUID(),
          kind: "add",
          returnIntentId: null,
          expiresAt: "2026-10-03T13:10:00.000Z",
        },
        { "set-cookie": "opengeni.login_transaction=fixture" },
      );
    if (path === "/v1/auth/session-set/transactions/email-password") {
      slots.set(correlation, crypto.randomUUID());
      return json({ projection: projection(correlation), returnIntent: null });
    }
    if (path === "/v1/auth/session-set/select") return json(projection(correlation, true));
    if (path === "/v1/auth/sign-up/email") {
      emails.set(correlation, body.email);
      users.set(correlation, crypto.randomUUID());
      return json({
        user: {
          id: users.get(correlation),
          email: body.email,
          emailVerified: false,
          createdAt:
            outcome === "old_identity" ? "2000-01-01T00:00:00.000Z" : new Date(now).toISOString(),
        },
      });
    }
    if (path === "/v1/auth/verify-email")
      return new Response(null, { status: 302, headers: { location: "/" } });
    if (path === "/v1/auth/sign-in/email")
      return json({}, { "set-cookie": "better-auth.session_token=fixture" });
    if (path === "/v1/auth/get-session")
      return json({
        user: {
          id: users.get(correlation),
          email: emails.get(correlation),
          emailVerified: true,
          createdAt: new Date(now).toISOString(),
        },
      });
    if (path === "/v1/auth/organization-onboarding") {
      if (method === "GET") return json({ state: "required" });
      onboarded.add(correlation);
      sessions.set(correlation, crypto.randomUUID());
      return json({ organizationId: parent, personalWorkspaceId: sessions.get(correlation) });
    }
    if (path === "/v1/organization-memberships")
      return json({
        memberships: onboarded.has(correlation)
          ? [
              {
                organizationId: parent,
                personalWorkspaceId: sessions.get(correlation),
                status: "active",
              },
            ]
          : [],
      });
    if (path.endsWith("/model-catalog"))
      return json({
        models: [{ id: "gpt-6-luna", cost: "credits", availability: { selectable: true } }],
        defaultSelection: {
          model: "gpt-6-luna",
          reasoningEffort: "xhigh",
          source: outcome === "wrong_default" ? "deployment" : "credits",
        },
      });
    if (path.endsWith("/sessions") && method === "POST")
      return json({
        id: body.requestedSessionId,
        model: "gpt-6-luna",
        reasoningEffort: mode === "fresh" ? "xhigh" : "low",
        sandboxBackend: mode === "plain" ? "none" : "modal",
      });
    if (path.endsWith("/events/stream")) {
      if (outcome === "timeout")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), {
                once: true,
              });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const events = [
        event(1, "user.message", { text: "ignored user prompt" }),
        event(2, "turn.started", {}),
      ];
      if (outcome === "commentary_empty")
        events.push(
          event(events.length + 1, "agent.message.delta", {
            text: "Running /bin/true.",
            phase: "commentary",
          }),
          event(events.length + 2, "agent.message.completed", {
            text: "Running /bin/true.",
            phase: "commentary",
          }),
        );
      if (mode !== "plain")
        events.push(
          event(events.length + 1, "agent.toolCall.created", {
            id: "command",
            name: "exec_command",
            arguments: { cmd: "/bin/true" },
          }),
          event(events.length + 2, "agent.toolCall.output", {
            id: "command",
            output: { type: "text", text: "Process exited with code 0\n\nOutput:\n" },
          }),
        );
      if (outcome === "commentary_empty")
        events.push(event(events.length + 1, "agent.message.completed", { text: "" }));
      else if (outcome !== "empty")
        events.push(
          event(events.length + 1, "agent.message.delta", { text: "O" }),
          event(events.length + 2, "agent.message.delta", { text: "K" }),
        );
      if (outcome !== "closed")
        events.push(
          event(events.length + 1, outcome === "failed" ? "turn.failed" : "turn.completed", {
            output: outcome === "empty" || outcome === "commentary_empty" ? "" : "OK",
            ...(outcome === "commentary_empty" ? { emptyFinalReply: true } : {}),
          }),
        );
      return streamResponse(events);
    }
    if (method === "DELETE") return json({ deletedSessionCount: 1 });
    throw new Error("unexpected fixture request");
  }) as FetchLike;
  return { calls, fetchImpl };
}
describe("offline launch burst safety", () => {
  test("default dry-run invokes no network, credentials, mailbox or checkpoint", async () => {
    const input = await setup();
    let calls = 0;
    const result = await runBurst({
      ...input,
      execute: false,
      cohortText: "not json",
      authorization: {},
      env: {},
      fetchImpl: (async () => {
        calls++;
        throw new Error("network forbidden");
      }) as FetchLike,
      checkpoint: async () => {
        calls++;
      },
      verificationReader: async () => {
        calls++;
        return "";
      },
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ dryRun: true, remoteRequests: 0 });
    expect(parseCli([]).execute).toBe(false);
    expect(() => parseCli(["--execute", "--dry-run"])).toThrow();
    expect(() => parseCli(["--execute"])).toThrow();
    expect(() => parseCli(["--tiny-smoke"])).toThrow();
  });
  test.each([
    "confirm",
    "token",
    "parent",
    "source",
    "intent",
    "cohort",
    "expired",
    "premature",
    "reliability",
    "monitoring",
    "origin",
    "identity",
  ])("premature/invalid %s creates zero remote requests", async (invalid) => {
    const input = await setup();
    if (invalid === "confirm") input.confirm = false;
    if (invalid === "token")
      input.env.OPENGENI_BURST_GATE_TOKEN = "wrong-token-with-more-than-32-characters";
    if (invalid === "parent") input.env.OPENGENI_BURST_PARENT_SESSION_ID = crypto.randomUUID();
    if (invalid === "source") input.sourceSha = "b".repeat(40);
    if (invalid === "intent") input.intent.runId = "changed";
    if (invalid === "cohort") input.cohortText += " ";
    if (invalid === "expired") input.authorization.expiresAt = "2026-10-03T12:59:00.000Z";
    if (invalid === "premature")
      input.authorization.monitoring.confirmedAt = "2026-10-03T13:01:00.000Z";
    if (invalid === "reliability")
      (input.authorization.reliability as Record<string, unknown>).emptyOutputFixed = false;
    if (invalid === "monitoring")
      (input.authorization.monitoring as Record<string, unknown>).launchDashboardLiveOnStaging =
        false;
    if (invalid === "origin")
      (input.intent as Record<string, unknown>).origin = "https://app.opengeni.ai";
    if (invalid === "identity") input.env.BURST_COOKIE = "";
    let calls = 0;
    await expect(
      runBurst({
        ...input,
        fetchImpl: (async () => {
          calls++;
          throw new Error("network forbidden");
        }) as FetchLike,
        checkpoint: async () => {
          calls++;
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test.each(["plain", "sandbox", "fresh"] as const)(
    "%s uses exact separate source policy",
    async (mode) => {
      const fixture = fixtureFetch(mode);
      const result = (await runBurst({ ...(await setup(mode)), fetchImpl: fixture.fetchImpl })) as {
        samples: Sample[];
        summary: { successes: number };
      };
      expect(result.summary.successes).toBe(result.samples.length);
      const creates = fixture.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/sessions"),
      );
      expect(creates).toHaveLength(mode === "fresh" ? 50 : 100);
      for (const call of creates) {
        if (mode === "fresh") {
          expect(call.body).not.toHaveProperty("model");
          expect(call.body).not.toHaveProperty("reasoningEffort");
        } else expect(call.body).toMatchObject({ model: "gpt-6-luna", reasoningEffort: "low" });
        expect(call.body?.firstPartyMcpTools).toEqual(mode === "plain" ? [] : ["exec_command"]);
      }
      if (mode === "fresh") {
        expect(fixture.calls.filter((c) => c.path === "/v1/auth/sign-up/email")).toHaveLength(50);
        expect(result.samples.every((s) => s.signupMs !== null && s.promptSentAt !== null)).toBe(
          true,
        );
      } else expect(fixture.calls.some((c) => c.path.includes("/auth/"))).toBe(false);
      expect(result.samples.every((s) => s.cleanup === "requested")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(env.BURST_PASSWORD);
      expect(JSON.stringify(result)).not.toContain("fresh-0@example.test");
      expect(JSON.stringify(result)).not.toContain("better-auth.session_token");
    },
  );
  test.each(["failed", "empty", "closed"])(
    "%s stays in denominator; unknown cleanup held",
    async (outcome) => {
      const fixture = fixtureFetch("plain", outcome);
      const result = (await runBurst({ ...(await setup()), fetchImpl: fixture.fetchImpl })) as {
        samples: Sample[];
        summary: { denominator: number; failures: number };
      };
      expect(result.summary).toMatchObject({ denominator: 100, failures: 100 });
      if (outcome === "closed") {
        expect(result.samples.every((s) => s.cleanup === "held_unknown")).toBe(true);
        expect(fixture.calls.some((c) => c.method === "DELETE")).toBe(false);
      }
    },
  );
  test("commentary then canonical empty final is not a successful sandbox result", async () => {
    const fixture = fixtureFetch("sandbox", "commentary_empty");
    const result = (await runBurst({
      ...(await setup("sandbox")),
      fetchImpl: fixture.fetchImpl,
    })) as { samples: Sample[]; summary: ReturnType<typeof summarize> };
    expect(result.samples).toHaveLength(100);
    for (const value of result.samples) {
      expect(value).toMatchObject({
        status: "empty_output",
        commandCount: 1,
        commandExitCode: 0,
        cleanup: "requested",
      });
      expect(value.firstOutputMs).not.toBeNull();
      expect(value.completionMs).not.toBeNull();
    }
    expect(result.summary).toMatchObject({
      denominator: 100,
      successes: 0,
      failures: 100,
      outcomes: { empty_output: 100 },
      ttftMsAllUsers: { denominator: 100, observed: 100 },
      completionMsAllUsers: {
        denominator: 100,
        observed: 0,
        missing: 100,
        p95: "unobserved_or_failed",
      },
      successfulOnlyTtftMs: { denominator: 0 },
      verdict: { successRateAtLeast99Percent: false },
    });
  });
  test("fragmented production SSE advances through real coalesced coverage", async () => {
    const fixture = fixtureFetch("plain", "success", "legacy", (events) => {
      const projection = coalesceSessionEventDeltasWithCoverage(events);
      expect(projection.events.map((value) => value.sequence)).toEqual([1, 2, 3, 5]);
      expect(projection.coveredThroughBySequence.get(3)).toBe(4);
      const frames = projection.events.map((value) =>
        formatSessionEventSse(value, projection.coveredThroughBySequence.get(value.sequence)!),
      );
      expect(frames[2]).toStartWith("id: 4\n");
      // Split every byte, including the trusted id and JSON, across chunks.
      return sseFrames(frames, 1);
    });
    const result = (await runBurst({ ...(await setup()), fetchImpl: fixture.fetchImpl })) as {
      samples: Sample[];
      summary: ReturnType<typeof summarize>;
    };
    expect(result.summary).toMatchObject({ denominator: 100, successes: 100, failures: 0 });
    expect(result.summary.completionMsAllUsers.observed).toBe(100);
    expect(result.samples.every((value) => value.cleanup === "requested")).toBe(true);
    expect(fixture.calls.filter((call) => call.path.endsWith("/events/stream"))).toHaveLength(100);
  });
  test.each(["before_coverage", "after_coverage", "forged_producer_coverage"])(
    "%s does not hide a real missing sequence or reconnect",
    async (gap) => {
      const fixture = fixtureFetch("plain", "success", "legacy", (events) => {
        if (gap === "before_coverage")
          return sse(
            events.filter((value) => value.sequence !== 2),
            true,
          );
        if (gap === "after_coverage")
          return sse(
            events.map((value) =>
              value.type === "turn.completed" ? { ...value, sequence: 6 } : value,
            ),
            true,
          );
        return sse(
          events
            .filter((value) => value.sequence !== 4)
            .map((value) =>
              value.sequence === 3
                ? {
                    ...value,
                    coveredThrough: 4,
                    coalescedUntil: 4,
                    payload: { ...value.payload, coalescedUntil: 4 },
                  }
                : value,
            ),
        );
      });
      const result = (await runBurst({ ...(await setup()), fetchImpl: fixture.fetchImpl })) as {
        samples: Sample[];
        summary: ReturnType<typeof summarize>;
      };
      expect(result.summary).toMatchObject({ denominator: 100, successes: 0, failures: 100 });
      expect(result.summary.completionMsAllUsers.missing).toBe(100);
      expect(
        result.samples.every(
          (value) => value.errorCode === "sse_sequence_gap" && value.cleanup === "held_unknown",
        ),
      ).toBe(true);
      expect(fixture.calls.filter((call) => call.path.endsWith("/events/stream"))).toHaveLength(
        100,
      );
      expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
    },
  );
  test.each([
    undefined,
    "",
    "not-a-sequence",
    "4.0",
    "4e0",
    "+4",
    "-4",
    " 4",
    "2",
    "9007199254740992",
  ])("invalid SSE id %s falls back to raw sequence and cannot claim coverage", async (id) => {
    const fixture = fixtureFetch("plain", "success", "legacy", (events) =>
      sseFrames(
        events
          .filter((value) => value.sequence !== 4)
          .map((value) => {
            const frame = formatSessionEventSse(value);
            return value.sequence === 3
              ? frame.replace(/^id: 3\n/, id === undefined ? "" : `id: ${id}\n`)
              : frame;
          }),
      ),
    );
    const result = (await runBurst({ ...(await setup()), fetchImpl: fixture.fetchImpl })) as {
      samples: Sample[];
      summary: ReturnType<typeof summarize>;
    };
    expect(result.summary).toMatchObject({ denominator: 100, successes: 0, failures: 100 });
    expect(result.samples.every((value) => value.errorCode === "sse_sequence_gap")).toBe(true);
    expect(fixture.calls.filter((call) => call.path.endsWith("/events/stream"))).toHaveLength(100);
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
  });
  test.each(["dual", "broker"])(
    "%s fresh auth uses isolated public transaction and selected actor",
    async (authMode) => {
      const fixture = fixtureFetch("fresh", "success", authMode);
      const result = (await runBurst({
        ...(await setup("fresh")),
        fetchImpl: fixture.fetchImpl,
      })) as { summary: { successes: number } };
      expect(result.summary.successes).toBe(50);
      const transactions = fixture.calls.filter(
        (call) => call.path === "/v1/auth/session-set/transactions",
      );
      expect(transactions).toHaveLength(50);
      expect(
        transactions.every(
          (call) => call.headers.get("x-opengeni-session-csrf") === "f".repeat(32),
        ),
      ).toBe(true);
      const catalogs = fixture.calls.filter((call) => call.path.endsWith("/model-catalog"));
      expect(catalogs.every((call) => call.headers.get("x-opengeni-actor-epoch") === "2")).toBe(
        true,
      );
      expect(fixture.calls.some((call) => call.path === "/v1/auth/sign-in/email")).toBe(false);
    },
  );
  test("fresh default mismatch cannot be replaced by an explicit low-effort model", async () => {
    const fixture = fixtureFetch("fresh", "wrong_default");
    const result = (await runBurst({
      ...(await setup("fresh")),
      fetchImpl: fixture.fetchImpl,
    })) as { summary: { denominator: number; failures: number } };
    expect(result.summary).toMatchObject({ denominator: 50, failures: 50 });
    expect(
      fixture.calls.some((call) => call.method === "POST" && call.path.endsWith("/sessions")),
    ).toBe(false);
  });
  test("previously registered identities are not a fresh signup wave", async () => {
    const fixture = fixtureFetch("fresh", "old_identity");
    const result = (await runBurst({
      ...(await setup("fresh")),
      fetchImpl: fixture.fetchImpl,
    })) as { summary: { denominator: number; failures: number } };
    expect(result.summary).toMatchObject({ denominator: 50, failures: 50 });
    expect(fixture.calls.some((c) => c.path === "/v1/auth/organization-onboarding")).toBe(false);
    expect(fixture.calls.some((c) => c.method === "POST" && c.path.endsWith("/sessions"))).toBe(
      false,
    );
  });
  test("stalled-stream deadlines count all users and request no unknown cleanup", async () => {
    const input = await setup();
    input.intent.turnTimeoutMs = 10_000;
    input.authorization.intentDigest = intentDigest(input.intent);
    const fixture = fixtureFetch("plain", "timeout");
    const result = (await runBurst({ ...input, fetchImpl: fixture.fetchImpl })) as {
      summary: { denominator: number; failures: number; outcomes: { timeout: number } };
      samples: Sample[];
    };
    expect(result.summary).toMatchObject({
      denominator: 100,
      failures: 100,
      outcomes: { timeout: 100 },
    });
    expect(result.samples.every((s) => s.cleanup === "held_unknown")).toBe(true);
    expect(fixture.calls.some((c) => c.method === "DELETE")).toBe(false);
  }, 20_000);
  test("no redirects to production, and expiry blocks subsequent requests", async () => {
    let calls = 0;
    const http = new HumanHttp(
      (async (_url, init) => {
        calls++;
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://app.opengeni.ai" },
        });
      }) as FetchLike,
      1_000,
      "fixture",
      now + 1_000,
      "",
      () => now,
    );
    await expect(
      http.request("https://app.opengeni.ai/v1/config/client", "GET", new AbortController().signal),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(
      http.request("/v1/config/client", "GET", new AbortController().signal),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(() =>
      verificationPath("https://app.opengeni.ai/v1/auth/verify-email?token=secret"),
    ).toThrow();
    expect(() =>
      verificationPath(
        `${STAGING_ORIGIN}/v1/auth/verify-email?token=fake&callbackURL=https://app.opengeni.ai`,
      ),
    ).toThrow();
  });
});
describe("honest measurement fixtures", () => {
  test("recovery/resume retains the earliest observed worker start, including zero", () => {
    for (const firstStartMs of [0, 20]) {
      const value = sample();
      value.sentMonoMs = 1_000;
      const observer = new TurnObserver(value, "plain");
      const firstAttempt = crypto.randomUUID();
      const resumedAttempt = crypto.randomUUID();
      observer.observe(event(1, "user.message"), 1_000, "wall");
      observer.observe(
        { ...event(2, "turn.started"), turnAttemptId: firstAttempt },
        1_000 + firstStartMs,
        "wall",
      );
      expect(value.workerStartMs).toBe(firstStartMs);
      observer.observe(
        { ...event(3, "turn.started"), turnAttemptId: resumedAttempt },
        1_200,
        "wall",
      );
      expect(value.workerStartMs).toBe(firstStartMs);
      observer.observe(
        { ...event(4, "turn.started"), turnAttemptId: resumedAttempt },
        1_300,
        "wall",
      );
      expect(value.workerStartMs).toBe(firstStartMs);
      observer.observe(event(5, "agent.message.completed", { text: "OK" }), 1_400, "wall");
      expect(observer.observe(event(6, "turn.completed", { output: "OK" }), 1_500, "wall")).toBe(
        true,
      );
      expect(value).toMatchObject({
        status: "success",
        workerStartMs: firstStartMs,
        firstOutputMs: 400,
        completionMs: 500,
        attemptIds: [firstAttempt, resumedAttempt],
      });
      expect(summarize([value]).workerStartMsAllUsers).toMatchObject({
        denominator: 1,
        observed: 1,
        p50: firstStartMs,
        max: firstStartMs,
      });
    }
  });
  test("status/reasoning/tools/empty frames/other turns cannot be TTFT", () => {
    const value = sample();
    const observer = new TurnObserver(value, "plain");
    observer.observe(event(1, "user.message", { text: "user" }), 1, "wall");
    observer.observe(event(2, "turn.started", {}), 2, "wall");
    observer.observe(event(3, "agent.reasoning.delta", { text: "thinking" }), 3, "wall");
    observer.observe(event(4, "session.status.changed", { text: "working" }), 4, "wall");
    observer.observe(event(5, "agent.message.delta", { text: " " }), 5, "wall");
    observer.observe(
      event(6, "agent.message.delta", { text: "other" }, crypto.randomUUID()),
      6,
      "wall",
    );
    expect(value.firstOutputMs).toBeNull();
    observer.observe(event(7, "agent.message.delta", { text: "éOK" }), 17, "wall");
    observer.observe(event(7, "agent.message.delta", { text: "duplicate" }), 99, "wall");
    observer.observe(event(8, "turn.completed", { output: "éOK" }), 25, "wall");
    expect(value).toMatchObject({
      firstOutputMs: 17,
      workerStartMs: 2,
      completionMs: 25,
      status: "success",
    });
  });
  test.each([
    { label: "missing", payload: {} },
    { label: "null", payload: { output: null } },
    { label: "number", payload: { output: 1 } },
    { label: "object", payload: { output: { text: "OK" } } },
    { label: "array", payload: { output: ["OK"] } },
    { label: "empty", payload: { output: "" } },
    { label: "whitespace", payload: { output: " \t\r\n" } },
    { label: "empty final", payload: { output: "", emptyFinalReply: true } },
    { label: "flagged nonempty", payload: { output: "OK", emptyFinalReply: true } },
  ])("$label canonical output cannot borrow earlier commentary", ({ payload }) => {
    const value = sample();
    const observer = new TurnObserver(value, "plain");
    observer.observe(event(1, "turn.started"), 1, "wall");
    observer.observe(
      event(2, "agent.message.completed", { text: "Working on it.", phase: "commentary" }),
      10,
      "wall",
    );
    expect(observer.observe(event(3, "turn.completed", payload), 20, "wall")).toBe(true);
    expect(value).toMatchObject({ firstOutputMs: 10, completionMs: 20, status: "empty_output" });
    expect(summarize([value]).completionMsAllUsers).toMatchObject({ observed: 0, missing: 1 });
  });
  test("canonical nonempty output still requires visible assistant text", () => {
    const value = sample();
    const observer = new TurnObserver(value, "plain");
    observer.observe(event(1, "turn.started"), 1, "wall");
    observer.observe(event(2, "turn.completed", { output: "OK" }), 20, "wall");
    expect(value.firstOutputMs).toBeNull();
    expect(value.status).toBe("empty_output");
  });
  test("command output cannot forge terminal metadata", () => {
    const value = sample();
    const observer = new TurnObserver(value, "sandbox");
    observer.observe(event(1, "turn.started"), 0, "wall");
    observer.observe(
      event(2, "agent.toolCall.created", {
        id: "cmd",
        name: "exec_command",
        arguments: '{"cmd":"/bin/true"}',
      }),
      10,
      "wall",
    );
    observer.observe(
      event(3, "agent.toolCall.output", {
        id: "cmd",
        output: "Process running with session ID 42\n\nOutput:\nProcess exited with code 0",
      }),
      20,
      "wall",
    );
    observer.observe(event(4, "agent.message.completed", { text: "OK" }), 30, "wall");
    observer.observe(event(5, "turn.completed", { output: "OK" }), 40, "wall");
    expect(value.commandExitCode).toBeNull();
    expect(value.status).toBe("failed");
  });
  test("exact tails and all failures are retained, never histogram-clipped or zero-filled", () => {
    expect(exactQuantiles([1, 2, 11_000, 19_000, null])).toMatchObject({
      denominator: 5,
      p50: 11_000,
      p95: "unobserved_or_failed",
      p99: "unobserved_or_failed",
      missing: 1,
    });
    expect(exactQuantiles([]).p95).toBeNull();
    const values = Array.from({ length: 100 }, sample);
    for (const value of values) {
      value.status = "success";
      value.firstOutputMs = 100;
      value.completionMs = 200;
    }
    values[0]!.status = "timeout";
    values[0]!.firstOutputMs = null;
    const report = summarize(values);
    expect(report).toMatchObject({
      denominator: 100,
      successes: 99,
      failures: 1,
      successRate: 0.99,
    });
    expect(report.completionMsAllUsers.denominator).toBe(100);
    expect(report.ttftMsAllUsers.max).toBe("unobserved_or_failed");
  });
  test("Temporal correlation is Scheduled→Started for runAgentTurn, not receipt→worker", () => {
    const metadata = {
      workflowId: "fixture-workflow",
      runId: "fixture-run",
      sessionId: parent,
      turnId,
      complete: true,
      events: [
        {
          type: "ActivityTaskScheduled",
          eventId: "15",
          eventTime: "2026-10-03T12:59:00.000Z",
          activityId: "1",
          activityType: "runAgentTurn",
        },
        {
          type: "ActivityTaskStarted",
          eventId: "16",
          eventTime: "2026-10-03T12:59:12.345Z",
          scheduledEventId: "15",
        },
        {
          type: "ActivityTaskScheduled",
          eventId: "25",
          eventTime: "2026-10-03T12:59:30.000Z",
          activityId: "2",
          activityType: "runAgentTurn",
        },
      ],
    };
    expect(correlateTemporal(metadata).activities[0]?.starts[0]?.scheduleToStartMs).toBe(12_345);
    expect(correlateTemporal(metadata).activities[1]?.pendingOrUnknown).toBe(true);
    expect(() => correlateTemporal({ ...metadata, payloads: ["forbidden"] })).toThrow();
    expect(() =>
      correlateTemporal({ ...metadata, events: [{ ...metadata.events[0], input: "forbidden" }] }),
    ).toThrow();
  });
});
