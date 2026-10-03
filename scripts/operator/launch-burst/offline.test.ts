import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { SessionEvent } from "../../../packages/contracts/src/index";
import {
  coalesceSessionEventDeltasWithCoverage,
  formatSessionEventSse,
} from "../../../packages/events/src/index";
import {
  Authorization,
  Cohort,
  digest,
  FRESH_ENROLLMENT_MIN_GAP_MS,
  Intent,
  intentDigest,
  STAGING_ORIGIN,
} from "./config";
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
async function setup(mode: "plain" | "sandbox" | "fresh" = "plain", freshCount: 50 | 100 = 50) {
  const intent = Intent.parse(
    JSON.parse(
      await readFile(
        new URL(
          mode === "fresh" ? `fresh${freshCount}.intent.json` : `${mode}.intent.json`,
          import.meta.url,
        ),
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
    clock: {
      now: () => now + mono,
      wall: () => new Date(now + mono).toISOString(),
      mono: () => ++mono,
    },
    wait: async (milliseconds: number) => {
      mono += milliseconds;
    },
    advance: (milliseconds: number) => {
      mono += milliseconds;
    },
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
    enrollmentStartedAt: null,
    enrollmentSettledAt: null,
    enrollmentPacingWaitMs: null,
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
  nowMs: () => number = () => now,
) {
  const calls: Array<{
    path: string;
    method: string;
    body: Record<string, unknown> | null;
    headers: Headers;
    atMs: number;
    signal: AbortSignal | null;
  }> = [];
  const onboarded = new Set<string>();
  const emails = new Map<string, string>();
  const users = new Map<string, string>();
  const createdAt = new Map<string, string>();
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
    calls.push({ path, method, body, headers, atMs: nowMs(), signal: init?.signal ?? null });
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
          expiresAt: new Date(nowMs() + 10 * 60_000).toISOString(),
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
      createdAt.set(
        correlation,
        outcome === "old_identity" ? "2000-01-01T00:00:00.000Z" : new Date(nowMs()).toISOString(),
      );
      return json({
        user: {
          id: users.get(correlation),
          email: body.email,
          emailVerified: false,
          createdAt: createdAt.get(correlation),
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
          createdAt: createdAt.get(correlation),
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
type BurstResult = {
  phase: string;
  samples: Sample[];
  summary: ReturnType<typeof summarize>;
  enrollment: {
    concurrency: number;
    gapAfterSettlementMs: number | null;
    startedAt: string | null;
    settledAt: string | null;
    durationMs: number | null;
    pacingWaitMs: number;
    dispatchReleasedAt: string | null;
  };
};
describe("offline serial fresh enrollment and first-turn barrier", () => {
  test("fresh pacing defaults to 3100 ms and never permits a shorter live gap", async () => {
    const input = await setup("fresh");
    const { freshEnrollmentGapMs: _gap, ...withoutGap } = input.intent;
    expect(Intent.parse(withoutGap).freshEnrollmentGapMs).toBe(FRESH_ENROLLMENT_MIN_GAP_MS);
    for (const gap of [0, 3_000, 3_099]) {
      expect(Intent.safeParse({ ...input.intent, freshEnrollmentGapMs: gap }).success).toBe(false);
    }
  });
  test.each([50, 100] as const)(
    "fresh %s dry plan invokes no wait/STOP/mailbox/checkpoint/fetch",
    async (count) => {
      const input = await setup("fresh", count);
      let calls = 0;
      const result = await runBurst({
        ...input,
        execute: false,
        cohortText: "not json",
        authorization: {},
        env: {},
        wait: async () => {
          calls++;
        },
        stopRequested: async () => {
          calls++;
          return true;
        },
        verificationReader: async () => {
          calls++;
          return "";
        },
        checkpoint: async () => {
          calls++;
        },
        fetchImpl: async () => {
          calls++;
          throw new Error("network forbidden");
        },
      });
      expect(calls).toBe(0);
      expect(result).toMatchObject({
        dryRun: true,
        remoteRequests: 0,
        enrollment: {
          concurrency: 1,
          gapAfterSettlementMs: 3_100,
          minimumPacingSpanMs: (count - 1) * 3_100,
          sessionsCreated: 0,
        },
      });
    },
  );
  test.each([
    { count: 50, authMode: "legacy" },
    { count: 100, authMode: "legacy" },
    { count: 50, authMode: "dual" },
    { count: 100, authMode: "dual" },
    { count: 50, authMode: "broker" },
    { count: 100, authMode: "broker" },
  ] as const)(
    "$count $authMode fresh pipelines settle before spaced next enrollment and concurrent first turns",
    async ({ count, authMode }) => {
      const input = await setup("fresh", count);
      input.intent.signupTimeoutMs = 10_000;
      input.authorization.intentDigest = intentDigest(input.intent);
      const fixture = fixtureFetch("fresh", "success", authMode, sse, input.clock.now);
      let barrierSettled = false;
      let activeCreates = 0;
      let maxActiveCreates = 0;
      const result = (await runBurst({
        ...input,
        verificationReader: async (identity, signal) => {
          expect(signal.aborted).toBe(false);
          // Variable mailbox latency is inside the COMPLETE pipeline, not a signup-only gap.
          input.advance((Number(identity.label.split("-")[1]) % 3) * 4_000);
          return input.verificationReader(identity);
        },
        checkpoint: async (snapshot) => {
          const state = snapshot as BurstResult;
          if (state.phase !== "auth_and_defaults_prepared") return;
          expect(state.samples.every((value) => value.enrollmentSettledAt !== null)).toBe(true);
          expect(
            fixture.calls.some((call) => call.method === "POST" && call.path.endsWith("/sessions")),
          ).toBe(false);
          barrierSettled = true;
        },
        fetchImpl: async (url, init) => {
          const create =
            init?.method === "POST" && new URL(String(url)).pathname.endsWith("/sessions");
          if (create) {
            expect(barrierSettled).toBe(true);
            activeCreates++;
            maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
            // Hold each injected request for one microtask to observe real concurrent release.
            await Promise.resolve();
          }
          try {
            return await fixture.fetchImpl(url, init);
          } finally {
            if (create) activeCreates--;
          }
        },
      })) as BurstResult;
      expect(result.phase).toBe("complete");
      expect(result.summary).toMatchObject({
        denominator: count,
        successes: count,
        failures: 0,
        promptSentCount: count,
      });
      expect(maxActiveCreates).toBe(count);
      expect(result.summary.promptLaunchSpreadMs).not.toBeNull();
      expect(result.summary.promptLaunchSpreadMs!).toBeLessThan(1_000);
      expect(result.enrollment).toMatchObject({ concurrency: 1, gapAfterSettlementMs: 3_100 });
      expect(result.enrollment.durationMs!).toBeGreaterThanOrEqual((count - 1) * 3_100);
      expect(Date.parse(result.enrollment.dispatchReleasedAt!)).toBeGreaterThanOrEqual(
        Date.parse(result.enrollment.settledAt!),
      );
      for (let index = 0; index < count; index++) {
        const value = result.samples[index]!;
        expect(value.signupMs!).toBeLessThan(input.intent.signupTimeoutMs);
        expect(value.enrollmentPacingWaitMs).not.toBeNull();
        expect(value.commandCount).toBe(1);
        if (index === 0) continue;
        expect(
          Date.parse(value.enrollmentStartedAt!) -
            Date.parse(result.samples[index - 1]!.enrollmentSettledAt!),
        ).toBeGreaterThanOrEqual(3_100);
      }
      for (const path of [
        "/v1/auth/sign-up/email",
        "/v1/auth/verify-email",
        authMode === "legacy"
          ? "/v1/auth/sign-in/email"
          : "/v1/auth/session-set/transactions/email-password",
      ]) {
        const calls = fixture.calls.filter((call) => call.path === path);
        expect(calls).toHaveLength(count);
        for (let index = 1; index < calls.length; index++)
          expect(calls[index]!.atMs - calls[index - 1]!.atMs).toBeGreaterThanOrEqual(3_100);
        for (const call of calls)
          expect(
            calls.filter((other) => other.atMs >= call.atMs && other.atMs < call.atMs + 60_000)
              .length,
          ).toBeLessThanOrEqual(20);
      }
      const creates = fixture.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/sessions"),
      );
      expect(creates).toHaveLength(count);
      for (const call of creates) {
        expect(call.body).not.toHaveProperty("model");
        expect(call.body).not.toHaveProperty("reasoningEffort");
        expect(call.body).toMatchObject({ sandbox: "new", firstPartyMcpTools: ["exec_command"] });
      }
      expect(fixture.calls.some((call) => /\/messages|\/turns|\/commands/.test(call.path))).toBe(
        false,
      );
      expect(
        fixture.calls.every(
          (call) =>
            !["authorization", "x-forwarded-for", "x-real-ip", "forwarded"].some((name) =>
              call.headers.has(name),
            ),
        ),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(env.BURST_PASSWORD);
      expect(JSON.stringify(result)).not.toContain("better-auth.session_token");
    },
  );
  test.each([50, 100] as const)(
    "fresh %s retains failed enrollment and dispatches only ready first turns",
    async (count) => {
      const input = await setup("fresh", count);
      const fixture = fixtureFetch("fresh", "success", "legacy", sse, input.clock.now);
      let rejected = false;
      let settled = false;
      const result = (await runBurst({
        ...input,
        checkpoint: async (snapshot) => {
          if ((snapshot as BurstResult).phase === "auth_and_defaults_prepared") settled = true;
        },
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (init?.method === "POST" && path.endsWith("/sessions")) expect(settled).toBe(true);
          const response = await fixture.fetchImpl(url, init);
          if (path === "/v1/auth/sign-up/email" && !rejected) {
            rejected = true;
            return Response.json({}, { status: 409 });
          }
          return response;
        },
      })) as BurstResult;
      expect(result.summary).toMatchObject({
        denominator: count,
        failures: 1,
        successes: count - 1,
        promptSentCount: count - 1,
      });
      expect(result.samples[0]).toMatchObject({
        status: "failed",
        errorCode: "http_409",
        signupMs: null,
        promptSentAt: null,
        sessionId: null,
      });
      expect(fixture.calls.filter((call) => call.path === "/v1/auth/sign-up/email")).toHaveLength(
        count,
      );
      expect(
        Date.parse(result.samples[1]!.enrollmentStartedAt!) -
          Date.parse(result.samples[0]!.enrollmentSettledAt!),
      ).toBeGreaterThanOrEqual(3_100);
    },
  );
  test.each([50, 100] as const)(
    "fresh %s signup timeout begins after pacing and an individual timeout stays in denominator",
    async (count) => {
      const input = await setup("fresh", count);
      input.intent.signupTimeoutMs = 10_000;
      input.authorization.intentDigest = intentDigest(input.intent);
      const fixture = fixtureFetch("fresh", "success", "legacy", sse, input.clock.now);
      const result = (await runBurst({
        ...input,
        verificationReader: async (identity) => {
          if (identity.label === "fresh-0") input.advance(10_001);
          return input.verificationReader(identity);
        },
        fetchImpl: fixture.fetchImpl,
      })) as BurstResult;
      expect(result.samples[0]).toMatchObject({
        status: "timeout",
        errorCode: "signup_timeout",
        signupMs: null,
        sessionId: null,
      });
      expect(result.summary).toMatchObject({
        denominator: count,
        failures: 1,
        successes: count - 1,
        promptSentCount: count - 1,
      });
      expect(
        result.samples
          .slice(1)
          .every((value) => value.signupMs !== null && value.signupMs < 10_000),
      ).toBe(true);
      expect(result.enrollment.durationMs!).toBeGreaterThan(10_000 + (count - 1) * 3_100);
    },
  );
  test.each(
    ([50, 100] as const).flatMap((count) =>
      ["pacing", "mailbox", "barrier", "stop_read_failed"].map((where) => ({ count, where })),
    ),
  )(
    "STOP during $count fresh $where blocks all session/model dispatch",
    async ({ count, where }) => {
      const input = await setup("fresh", count);
      const fixture = fixtureFetch("fresh", "success", "legacy", sse, input.clock.now);
      let stop = false;
      const result = (await runBurst({
        ...input,
        wait: async (milliseconds) => {
          await input.wait(milliseconds);
          if (where === "pacing" || where === "stop_read_failed") stop = true;
        },
        stopRequested: async () => {
          if (stop && where === "stop_read_failed") throw new Error("offline STOP read failure");
          return stop;
        },
        verificationReader: async (identity) => {
          if (where === "mailbox") stop = true;
          return input.verificationReader(identity);
        },
        checkpoint: async (snapshot) => {
          if (
            where === "barrier" &&
            (snapshot as BurstResult).phase === "auth_and_defaults_prepared"
          )
            stop = true;
        },
        fetchImpl: fixture.fetchImpl,
      })) as BurstResult;
      expect(result.phase).toBe("dispatch_blocked");
      expect(result.summary).toMatchObject({
        denominator: count,
        successes: 0,
        failures: count,
        promptSentCount: 0,
      });
      expect(
        result.samples.every(
          (value) =>
            value.errorCode ===
            (where === "stop_read_failed" ? "operator_cutoff_read_failed" : "operator_cutoff"),
        ),
      ).toBe(true);
      expect(result.enrollment.dispatchReleasedAt).toBeNull();
      expect(
        fixture.calls.some((call) => call.method === "POST" && call.path.endsWith("/sessions")),
      ).toBe(false);
      if (where === "mailbox")
        expect(
          fixture.calls.some(
            (call) => call.path === "/v1/auth/verify-email" || call.path.endsWith("/model-catalog"),
          ),
        ).toBe(false);
    },
  );
  test.each([50, 100] as const)(
    "fresh %s expiry during pacing blocks every first turn",
    async (count) => {
      const input = await setup("fresh", count);
      input.authorization.expiresAt = new Date(now + 3_100).toISOString();
      const fixture = fixtureFetch("fresh", "success", "legacy", sse, input.clock.now);
      const result = (await runBurst({ ...input, fetchImpl: fixture.fetchImpl })) as BurstResult;
      expect(result.phase).toBe("dispatch_blocked");
      expect(result.summary).toMatchObject({
        denominator: count,
        failures: count,
        successes: 0,
        promptSentCount: 0,
      });
      expect(
        result.samples.every(
          (value) => value.status === "failed" && value.errorCode === "authorization_expired",
        ),
      ).toBe(true);
      expect(fixture.calls.filter((call) => call.path === "/v1/auth/sign-up/email")).toHaveLength(
        1,
      );
      expect(
        fixture.calls.some((call) => call.method === "POST" && call.path.endsWith("/sessions")),
      ).toBe(false);
    },
  );
  test.each(
    ([50, 100] as const).flatMap((count) =>
      ["expiry_at_barrier", "token_drift", "slow_cohort_exceeds_30_minutes"].map((failure) => ({
        count,
        failure,
      })),
    ),
  )(
    "fresh $count $failure revalidates exact gate before releasing any prompt",
    async ({ count, failure }) => {
      const input = await setup("fresh", count);
      input.authorization.expiresAt = new Date(now + 30 * 60_000).toISOString();
      const fixture = fixtureFetch("fresh", "success", "legacy", sse, input.clock.now);
      const result = (await runBurst({
        ...input,
        verificationReader: async (identity) => {
          if (failure === "slow_cohort_exceeds_30_minutes") input.advance(40_000);
          return input.verificationReader(identity);
        },
        checkpoint: async (snapshot) => {
          if ((snapshot as BurstResult).phase !== "auth_and_defaults_prepared") return;
          if (failure === "expiry_at_barrier")
            input.advance(Date.parse(input.authorization.expiresAt) - input.clock.now());
          if (failure === "token_drift")
            input.env.OPENGENI_BURST_GATE_TOKEN =
              "changed-offline-token-with-at-least-32-characters";
        },
        fetchImpl: fixture.fetchImpl,
      })) as BurstResult;
      expect(result.phase).toBe("dispatch_blocked");
      expect(result.summary).toMatchObject({
        denominator: count,
        failures: count,
        successes: 0,
        promptSentCount: 0,
      });
      expect(
        result.samples.every(
          (value) =>
            value.errorCode ===
            (failure === "token_drift"
              ? "authorization_revalidation_failed"
              : "authorization_expired"),
        ),
      ).toBe(true);
      expect(result.enrollment.dispatchReleasedAt).toBeNull();
      expect(
        fixture.calls.some((call) => call.method === "POST" && call.path.endsWith("/sessions")),
      ).toBe(false);
      if (failure === "slow_cohort_exceeds_30_minutes")
        expect(result.enrollment.durationMs!).toBeGreaterThanOrEqual(30 * 60_000);
    },
  );
  test.each([
    { count: 50, reason: "operator_cutoff" },
    { count: 100, reason: "authorization_expired" },
  ] as const)(
    "$count unresolved offline mailbox wait is interrupted by $reason without dispatch",
    async ({ count, reason }) => {
      const input = await setup("fresh", count);
      const fixture = fixtureFetch("fresh", "success", "legacy", sse, input.clock.now);
      let stop = false;
      const result = (await runBurst({
        ...input,
        stopRequested: async () => stop,
        verificationReader: async (_identity, signal) => {
          if (reason === "operator_cutoff") stop = true;
          else input.advance(Date.parse(input.authorization.expiresAt) - input.clock.now());
          return new Promise<string>((_resolve, reject) => {
            signal.throwIfAborted();
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        fetchImpl: fixture.fetchImpl,
      })) as BurstResult;
      expect(result.phase).toBe("dispatch_blocked");
      expect(result.summary).toMatchObject({
        denominator: count,
        failures: count,
        successes: 0,
        promptSentCount: 0,
      });
      expect(
        result.samples.every((value) => value.status === "failed" && value.errorCode === reason),
      ).toBe(true);
      expect(fixture.calls.filter((call) => call.path === "/v1/auth/sign-up/email")).toHaveLength(
        1,
      );
      expect(
        fixture.calls.some(
          (call) => call.path.endsWith("/sessions") || call.path.endsWith("/model-catalog"),
        ),
      ).toBe(false);
    },
    5_000,
  );
});
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
      wait: async () => {
        calls++;
      },
      stopRequested: async () => {
        calls++;
        return true;
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
      const input = await setup(mode);
      const fixture = fixtureFetch(mode, "success", "legacy", sse, input.clock.now);
      const result = (await runBurst({ ...input, fetchImpl: fixture.fetchImpl })) as {
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
      const input = await setup("fresh");
      const fixture = fixtureFetch("fresh", "success", authMode, sse, input.clock.now);
      const result = (await runBurst({
        ...input,
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
    const input = await setup("fresh");
    const fixture = fixtureFetch("fresh", "wrong_default", "legacy", sse, input.clock.now);
    const result = (await runBurst({
      ...input,
      fetchImpl: fixture.fetchImpl,
    })) as { summary: { denominator: number; failures: number } };
    expect(result.summary).toMatchObject({ denominator: 50, failures: 50 });
    expect(
      fixture.calls.some((call) => call.method === "POST" && call.path.endsWith("/sessions")),
    ).toBe(false);
  });
  test("previously registered identities are not a fresh signup wave", async () => {
    const input = await setup("fresh");
    const fixture = fixtureFetch("fresh", "old_identity", "legacy", sse, input.clock.now);
    const result = (await runBurst({
      ...input,
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
