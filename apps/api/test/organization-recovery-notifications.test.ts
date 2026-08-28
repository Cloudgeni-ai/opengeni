import { describe, expect, test } from "bun:test";
import type {
  OrganizationRecoveryNotificationClaim,
  OrganizationRecoveryNotificationSettlement,
} from "@opengeni/db";
import {
  dispatchOrganizationRecoveryNotifications,
  InMemoryOrganizationRecoveryNotificationTransport,
  type OrganizationRecoveryNotificationLifecycle,
} from "../src/organization-recovery-notifications";

function claim(overrides: Partial<OrganizationRecoveryNotificationClaim> = {}) {
  return {
    attemptId: crypto.randomUUID(),
    outboxId: crypto.randomUUID(),
    deliveryId: crypto.randomUUID(),
    provider: "fake",
    claimOwner: "acceptance-dispatcher",
    attemptNumber: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: "organization-recovery:operation:recipient",
    recipientCanonicalIdentityId: crypto.randomUUID(),
    notificationType: "recovery_quorum_started" as const,
    payloadDigest: "d".repeat(64),
    payload: { authorityGained: "organization_owner" },
    ...overrides,
  } satisfies OrganizationRecoveryNotificationClaim;
}

function harness(claims: OrganizationRecoveryNotificationClaim[]) {
  const settlements: Array<Record<string, unknown>> = [];
  const lifecycle = {
    prepare: async () => claims,
    settle: async (_db: unknown, input: Record<string, unknown>) => {
      settlements.push(input);
      return {
        ...input,
        attemptNumber: 1,
        providerMessageId: input.providerMessageId ?? null,
        errorClass: input.errorClass ?? null,
        settledAt: new Date().toISOString(),
        replay: false,
      } as OrganizationRecoveryNotificationSettlement;
    },
  } as unknown as OrganizationRecoveryNotificationLifecycle;
  return { lifecycle, settlements };
}

describe("organization recovery fake notification transport", () => {
  test("delivers claims outside persistence with stable provider idempotency", async () => {
    const first = claim();
    const replayedProviderClaim = claim({
      outboxId: first.outboxId,
      idempotencyKey: first.idempotencyKey,
      attemptNumber: 2,
    });
    const { lifecycle, settlements } = harness([first, replayedProviderClaim]);
    const transport = new InMemoryOrganizationRecoveryNotificationTransport();
    const results = await dispatchOrganizationRecoveryNotifications({
      db: {} as never,
      transport,
      claimOwner: "acceptance-dispatcher",
      lifecycle,
    });

    expect(results).toHaveLength(2);
    expect(transport.attempts).toHaveLength(2);
    expect(transport.logicalDeliveryCount()).toBe(1);
    expect(new Set(transport.attempts.map((attempt) => attempt.providerMessageId)).size).toBe(1);
    expect(settlements).toHaveLength(2);
    expect(settlements.every((settlement) => settlement.phase === "sent")).toBe(true);
    expect(
      settlements.every((settlement) => settlement.claimOwner === "acceptance-dispatcher"),
    ).toBe(true);
  });

  test("journals bounded failure and ambiguous transport outcomes without external calls", async () => {
    const failed = claim({ idempotencyKey: "failure" });
    const ambiguous = claim({ idempotencyKey: "ambiguous" });
    const { lifecycle, settlements } = harness([failed, ambiguous]);
    const transport = new InMemoryOrganizationRecoveryNotificationTransport();
    transport.enqueue({ status: "failed", errorClass: "fake_refusal" });
    const originalSend = transport.send.bind(transport);
    let call = 0;
    transport.send = async (delivery) => {
      call += 1;
      if (call === 2) throw new Error("ambiguous fake transport loss");
      return await originalSend(delivery);
    };

    await dispatchOrganizationRecoveryNotifications({
      db: {} as never,
      transport,
      claimOwner: "acceptance-dispatcher",
      lifecycle,
    });

    expect(settlements.map((settlement) => settlement.phase).sort()).toEqual([
      "failed",
      "outcome_unknown",
    ]);
    expect(settlements.find((settlement) => settlement.phase === "failed")).toMatchObject({
      errorClass: "fake_refusal",
    });
    expect(
      settlements.find((settlement) => settlement.phase === "outcome_unknown"),
    ).not.toHaveProperty("errorClass");
    expect(transport.logicalDeliveryCount()).toBe(0);
  });
});
