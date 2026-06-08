import { describe, expect, test } from "bun:test";
import { ScheduleNotFoundError, ScheduleOverlapPolicy } from "@temporalio/client";
import { HTTPException } from "hono/http-exception";
import { allowedCorsOrigin, httpStatusForError, normalizeResources, replaySessionEvents, routeLabel, validateGitHubRepositorySelectionShape, workflowIdForSession } from "../src/app";
import { shouldCreateScheduleAfterUpdateError, temporalOverlapPolicy, temporalScheduleSpec } from "../src/index";
import { stripeCheckoutSessionCreateParams } from "../src/routes/billing";
import type { SessionEvent } from "@opengeni/contracts";

describe("API helpers", () => {
  test("normalizes repository resources into sandbox mount paths", () => {
    const [resource] = normalizeResources([{
      kind: "repository",
      uri: "https://github.com/OpenAI/example.git",
      ref: "main",
      subpath: "/infra/",
    }]);

    expect(resource).toEqual({
      kind: "repository",
      uri: "https://github.com/OpenAI/example.git",
      ref: "main",
      subpath: "infra",
      mountPath: "repos/OpenAI/example",
    });
  });

  test("normalizes file resources into sandbox mount paths", () => {
    const fileId = "00000000-0000-4000-8000-000000000010";
    expect(normalizeResources([{ kind: "file", fileId }])).toEqual([{
      kind: "file",
      fileId,
      mountPath: `files/${fileId}`,
    }]);
  });

  test("uses stable workflow ids for sessions", () => {
    expect(workflowIdForSession("abc")).toBe("session-abc");
  });

  test("maps scheduled task schedules into Temporal specs", () => {
    expect(temporalScheduleSpec({ type: "interval", everySeconds: 90, startAt: "2026-05-08T10:00:00.000Z", endAt: "2026-05-08T11:00:00.000Z" })).toEqual({
      intervals: [{ every: "90s" }],
      startAt: new Date("2026-05-08T10:00:00.000Z"),
      endAt: new Date("2026-05-08T11:00:00.000Z"),
    });
    expect(temporalScheduleSpec({ type: "calendar", timeZone: "Europe/Oslo", hour: 9, minute: 30, daysOfWeek: ["MONDAY"] })).toEqual({
      calendars: [{ hour: 9, minute: 30, second: 0, dayOfWeek: ["MONDAY"] }],
      timezone: "Europe/Oslo",
    });
    expect(temporalScheduleSpec({ type: "once", runAt: "2026-05-08T12:34:56.000+02:00", timeZone: "Europe/Oslo" })).toEqual({
      calendars: [{ year: 2026, month: "MAY", dayOfMonth: 8, hour: 10, minute: 34, second: 56 }],
      timezone: "UTC",
    });
  });

  test("maps scheduled task overlap policies into Temporal policies", () => {
    expect(temporalOverlapPolicy("allow_concurrent")).toBe(ScheduleOverlapPolicy.ALLOW_ALL);
    expect(temporalOverlapPolicy("skip")).toBe(ScheduleOverlapPolicy.SKIP);
    expect(temporalOverlapPolicy("buffer_one")).toBe(ScheduleOverlapPolicy.BUFFER_ONE);
  });

  test("only creates a schedule after update when Temporal reports not found", () => {
    expect(shouldCreateScheduleAfterUpdateError(new ScheduleNotFoundError("missing", "schedule-1"))).toBe(true);
    expect(shouldCreateScheduleAfterUpdateError(new Error("network unavailable"))).toBe(false);
  });

  test("rejects selected GitHub App repos from multiple installations", () => {
    expect(() => validateGitHubRepositorySelectionShape([
      {
        kind: "repository",
        uri: "https://github.com/a/one.git",
        ref: "main",
        githubInstallationId: 1,
        githubRepositoryId: 11,
      },
      {
        kind: "repository",
        uri: "https://github.com/b/two.git",
        ref: "main",
        githubInstallationId: 2,
        githubRepositoryId: 22,
      },
    ])).toThrow("one installation");
  });

  test("rejects incomplete GitHub App repository metadata", () => {
    expect(() => validateGitHubRepositorySelectionShape([
      {
        kind: "repository",
        uri: "https://github.com/a/one.git",
        ref: "main",
        githubInstallationId: 1,
      },
    ])).toThrow("positive github_installation_id");
  });

  test("matches CORS origins against the full origin string", () => {
    const pattern = String.raw`https?://(localhost|127\.0\.0\.1)(:\d+)?`;

    expect(allowedCorsOrigin(pattern, "http://localhost:3000")).toBe(true);
    expect(allowedCorsOrigin(pattern, "http://127.0.0.1:3000")).toBe(true);
    expect(allowedCorsOrigin(pattern, "http://localhost.evil.com")).toBe(false);
    expect(allowedCorsOrigin(pattern, "https://evil.com/http://localhost:3000")).toBe(false);
  });

  test("normalizes dynamic route labels for metrics", () => {
    const workspace = "00000000-0000-4000-8000-000000000001";
    expect(routeLabel(`/v1/workspaces/${workspace}/sessions/session-1/events/stream`)).toBe("/v1/workspaces/:workspaceId/sessions/:id/events/stream");
    expect(routeLabel(`/v1/workspaces/${workspace}/sessions/session-1/turns/turn-1`)).toBe("/v1/workspaces/:workspaceId/sessions/:id/turns/:turnId");
    expect(routeLabel(`/v1/workspaces/${workspace}/files/uploads/upload-1/complete`)).toBe("/v1/workspaces/:workspaceId/files/uploads/:id/complete");
    expect(routeLabel(`/v1/workspaces/${workspace}/document-bases/base-1/documents`)).toBe("/v1/workspaces/:workspaceId/document-bases/:id/documents");
    expect(routeLabel(`/v1/workspaces/${workspace}/document-bases/base-1/documents/document-1/reindex`)).toBe("/v1/workspaces/:workspaceId/document-bases/:id/documents/:documentId/reindex");
    expect(routeLabel(`/v1/workspaces/${workspace}/scheduled-tasks/task-1/runs`)).toBe("/v1/workspaces/:workspaceId/scheduled-tasks/:id/runs");
    expect(routeLabel(legacyRoute("sessions", "session-1", "events", "stream"))).toBe("/v1/unknown");
    expect(routeLabel("/v1/unregistered/resource-1")).toBe("/v1/unknown");
  });

  test("preserves HTTPException status codes in error metrics", () => {
    expect(httpStatusForError(new HTTPException(401))).toBe(401);
    expect(httpStatusForError(new Error("boom"))).toBe(500);
  });

  test("builds Stripe Checkout sessions that can collect tax addresses for existing customers", () => {
    const params = stripeCheckoutSessionCreateParams({
      accountId: "00000000-0000-4000-8000-000000000001",
      customerId: "cus_test",
      packageId: "topup_25",
      packageLabel: "$25 OpenGeni credits",
      amountMicros: 25_000_000,
      publicBaseUrl: "https://app.opengeni.ai",
      idempotencyKey: "checkout:test",
    });

    expect(params.mode).toBe("payment");
    expect(params.customer).toBe("cus_test");
    expect(params.customer_update).toEqual({ address: "auto", name: "auto" });
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(2500);
    expect(params.metadata?.opengeni_credit_idempotency_key).toBe("checkout:test");
    expect(params.payment_intent_data?.metadata?.opengeni_account_id).toBe("00000000-0000-4000-8000-000000000001");
  });

  test("replays SSE history across all pages", async () => {
    const events = Array.from({ length: 1005 }, (_, index) => ({
      id: `event-${index + 1}`,
      sessionId: "session-1",
      sequence: index + 1,
      type: "agent.message.delta",
      payload: { text: String(index + 1) },
      occurredAt: "2026-05-07T00:00:00.000Z",
    } satisfies SessionEvent));
    const sent: number[] = [];
    const pageRequests: Array<{ after: number; limit: number }> = [];

    await replaySessionEvents(
      async (after, limit) => {
        pageRequests.push({ after, limit });
        return events.filter((event) => event.sequence > after).slice(0, limit);
      },
      async (event) => {
        sent.push(event.sequence);
      },
      0,
      1000,
    );

    expect(sent).toHaveLength(1005);
    expect(sent[0]).toBe(1);
    expect(sent.at(-1)).toBe(1005);
    expect(pageRequests).toEqual([
      { after: 0, limit: 1000 },
      { after: 1000, limit: 1000 },
    ]);
  });
});

function legacyRoute(...segments: string[]): string {
  return ["", "v1", ...segments].join("/");
}
