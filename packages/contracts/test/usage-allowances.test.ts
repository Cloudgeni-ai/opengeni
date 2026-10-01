import { describe, expect, test } from "bun:test";
import {
  AllowanceExhaustedRefusal,
  ClearWorkspaceAllowanceRequest,
  GetMyUsageRequest,
  GetUsageRequest,
  GrantWorkspaceCreditsRequest,
  MemberAllowanceRule,
  SetWorkspaceAllowanceRequest,
  WorkspaceAllowanceState,
  WorkspaceUsageResponse,
} from "../src/usage-allowances";
import {
  CreateWorkspaceWebhookRequest,
  WorkspaceWebhookEvent,
} from "../src/workspace-integrations";

describe("usage allowance contracts", () => {
  test("integer USD micros and exact-version CAS are required", () => {
    const value = { includedCredits: 1_000_000, period: "monthly" as const, expectedVersion: 0 };
    expect(SetWorkspaceAllowanceRequest.parse(value)).toEqual(value);
    for (const includedCredits of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(SetWorkspaceAllowanceRequest.safeParse({ ...value, includedCredits }).success).toBe(
        false,
      );
    }
    for (const expectedVersion of [-1, 1.5, undefined]) {
      expect(SetWorkspaceAllowanceRequest.safeParse({ ...value, expectedVersion }).success).toBe(
        false,
      );
    }
    for (const anchorDay of [0, 32, 1.5]) {
      expect(SetWorkspaceAllowanceRequest.safeParse({ ...value, anchorDay }).success).toBe(false);
    }
    expect(SetWorkspaceAllowanceRequest.safeParse({ ...value, anchorDay: 31 }).success).toBe(true);
  });

  test("shares oversubscribe but cannot carry conflicting or invalid fields", () => {
    for (const rule of [null, { share: 0 }, { share: 2 }, { credits: 0 }]) {
      expect(MemberAllowanceRule.safeParse(rule).success).toBe(true);
    }
    for (const rule of [
      { share: -1 },
      { share: Infinity },
      { share: 1, credits: 2 },
      {},
      { credits: 1.2 },
    ]) {
      expect(MemberAllowanceRule.safeParse(rule).success).toBe(false);
    }
  });

  test("thresholds are optional and bounded fractions", () => {
    const value = { includedCredits: 0, period: "none", expectedVersion: 0 };
    for (const memberDefault of ["none", "equal_share", { share: 4 }, { credits: 2 }]) {
      expect(SetWorkspaceAllowanceRequest.safeParse({ ...value, memberDefault }).success).toBe(
        true,
      );
    }
    expect(
      SetWorkspaceAllowanceRequest.safeParse({ ...value, thresholds: { member: [0.8, 1] } })
        .success,
    ).toBe(true);
    for (const member of [[0], [1.1], Array(17).fill(0.8)]) {
      expect(
        SetWorkspaceAllowanceRequest.safeParse({ ...value, thresholds: { member } }).success,
      ).toBe(false);
    }
  });

  test("grants preserve opaque operation keys and nullable expiries", () => {
    expect(
      GrantWorkspaceCreditsRequest.parse({ operationId: "host/once", credits: 1, expiresAt: null }),
    ).toEqual({ operationId: "host/once", credits: 1, expiresAt: null });
    for (const request of [
      { operationId: " ", credits: 1 },
      { operationId: "é".repeat(129), credits: 1 },
      { operationId: "once", credits: 0 },
      { operationId: "once", credits: 1, expiresAt: "tomorrow" },
    ])
      expect(GrantWorkspaceCreditsRequest.safeParse(request).success).toBe(false);
  });

  test("lifecycle reads expose cleared versions without changing nullable configuration", () => {
    for (const state of [
      { version: 0, config: null },
      { version: 2, config: null },
      { version: 3, config: { includedCredits: 1, period: "none" as const, version: 3 } },
    ])
      expect(WorkspaceAllowanceState.parse(state)).toEqual(state);
    for (const state of [
      { version: -1, config: null },
      { version: 1.5, config: null },
      { version: 0, config: { includedCredits: 1, period: "none", version: 1 } },
      { version: 3, config: { includedCredits: 1, period: "none", version: 2 } },
    ])
      expect(WorkspaceAllowanceState.safeParse(state).success).toBe(false);
  });

  test("clear operation keys are optional, exact and bounded like grant keys", () => {
    expect(ClearWorkspaceAllowanceRequest.parse({ expectedVersion: 1 })).toEqual({
      expectedVersion: 1,
    });
    const request = { expectedVersion: 1, operationId: "host/clear" };
    expect(ClearWorkspaceAllowanceRequest.parse(request)).toEqual(request);
    for (const operationId of ["", " ", "é".repeat(129), "nul\0", "\uD800"])
      expect(ClearWorkspaceAllowanceRequest.safeParse({ ...request, operationId }).success).toBe(
        false,
      );
  });

  test("own reads cannot select another subject or roster page", () => {
    expect(
      GetUsageRequest.safeParse({ period: "2026-09", limit: 200, cursor: "subject" }).success,
    ).toBe(true);
    for (const request of [{ subjectId: "another" }, { cursor: "other" }, { limit: 2 }]) {
      expect(GetMyUsageRequest.safeParse(request).success).toBe(false);
    }
    for (const period of ["2026-13", "2026-00", "2026-9", "all"]) {
      expect(GetUsageRequest.safeParse({ period }).success).toBe(false);
    }
  });

  test("unconfigured usage is explicitly nullable", () => {
    expect(
      WorkspaceUsageResponse.parse({
        period: { start: null, end: null },
        workspace: {
          limit: null,
          used: 0,
          remaining: null,
          fraction: null,
          includedCredits: 0,
          grantsRemaining: 0,
          status: "ok",
          resetsAt: null,
        },
        members: [],
        nextCursor: null,
      }).workspace.limit,
    ).toBeNull();
    expect(
      AllowanceExhaustedRefusal.parse({
        code: "allowance_exhausted",
        scope: "member",
        subjectId: "user:a",
        resetsAt: null,
        message: "Exhausted",
      }).scope,
    ).toBe("member");
  });

  test("workspace usage webhooks are additive without synthetic session ids", () => {
    for (const type of ["usage.threshold_reached", "usage.exhausted", "usage.period_reset"]) {
      expect(
        CreateWorkspaceWebhookRequest.safeParse({
          url: "https://host.test/webhook",
          eventTypes: [type],
        }).success,
      ).toBe(true);
      expect(
        WorkspaceWebhookEvent.safeParse({
          id: crypto.randomUUID(),
          workspaceId: crypto.randomUUID(),
          type,
          sessionId: null,
          turnId: null,
          sequence: 1,
          occurredAt: "2026-09-01T00:00:00Z",
          data: { scope: "workspace", fraction: 0.8 },
        }).success,
      ).toBe(true);
    }
    expect(
      WorkspaceWebhookEvent.safeParse({
        id: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        type: "turn.completed",
        sessionId: crypto.randomUUID(),
        turnId: null,
        sequence: 1,
        occurredAt: "",
        data: {},
      }).success,
    ).toBe(true);
    expect(
      WorkspaceWebhookEvent.safeParse({
        id: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        type: "usage.period_reset",
        occurredAt: "2026-10-01T00:00:00Z",
        data: { period: "2026-10", resetsAt: "2026-11-01T00:00:00Z" },
      }).success,
    ).toBe(true);
  });
});
