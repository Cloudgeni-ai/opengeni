import type { Database } from "@opengeni/db";
import {
  prepareOrganizationRecoveryNotifications,
  settleOrganizationRecoveryNotification,
  type OrganizationRecoveryNotificationClaim,
  type OrganizationRecoveryNotificationSettlement,
} from "@opengeni/db";

export type OrganizationRecoveryNotificationDeliveryResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; errorClass: string }
  | { status: "outcome_unknown" };

export interface OrganizationRecoveryNotificationTransport {
  readonly provider: string;
  send(
    claim: OrganizationRecoveryNotificationClaim,
  ): Promise<OrganizationRecoveryNotificationDeliveryResult>;
}

export type OrganizationRecoveryNotificationLifecycle = {
  prepare: typeof prepareOrganizationRecoveryNotifications;
  settle: typeof settleOrganizationRecoveryNotification;
};

const productionLifecycle: OrganizationRecoveryNotificationLifecycle = {
  prepare: prepareOrganizationRecoveryNotifications,
  settle: settleOrganizationRecoveryNotification,
};

export async function dispatchOrganizationRecoveryNotifications(input: {
  db: Database;
  transport: OrganizationRecoveryNotificationTransport;
  claimOwner: string;
  limit?: number;
  leaseSeconds?: number;
  lifecycle?: OrganizationRecoveryNotificationLifecycle;
}): Promise<OrganizationRecoveryNotificationSettlement[]> {
  const lifecycle = input.lifecycle ?? productionLifecycle;
  const claims = await lifecycle.prepare(input.db, {
    provider: input.transport.provider,
    claimOwner: input.claimOwner,
    limit: input.limit ?? 25,
    leaseSeconds: input.leaseSeconds ?? 60,
  });
  return await Promise.all(
    claims.map(async (claim) => {
      let result: OrganizationRecoveryNotificationDeliveryResult;
      try {
        result = await input.transport.send(claim);
      } catch {
        // The provider may have accepted the stable idempotency key before the
        // transport failed. Preserve ambiguity for explicit reconciliation.
        result = { status: "outcome_unknown" };
      }
      return await lifecycle.settle(input.db, {
        outboxId: claim.outboxId,
        deliveryId: claim.deliveryId,
        claimOwner: claim.claimOwner,
        phase: result.status,
        ...(result.status === "sent" ? { providerMessageId: result.providerMessageId } : {}),
        ...(result.status === "failed" ? { errorClass: result.errorClass } : {}),
      });
    }),
  );
}

export class InMemoryOrganizationRecoveryNotificationTransport implements OrganizationRecoveryNotificationTransport {
  readonly provider = "fake";
  readonly attempts: Array<{
    idempotencyKey: string;
    payloadDigest: string;
    recipientCanonicalIdentityId: string;
    providerMessageId: string;
  }> = [];
  private readonly deliveries = new Map<string, string>();
  private readonly scripted: OrganizationRecoveryNotificationDeliveryResult[] = [];

  enqueue(...results: OrganizationRecoveryNotificationDeliveryResult[]): void {
    this.scripted.push(...results);
  }

  logicalDeliveryCount(): number {
    return this.deliveries.size;
  }

  async send(
    claim: OrganizationRecoveryNotificationClaim,
  ): Promise<OrganizationRecoveryNotificationDeliveryResult> {
    const scripted = this.scripted.shift();
    if (scripted) return scripted;
    const providerMessageId =
      this.deliveries.get(claim.idempotencyKey) ?? `fake:${crypto.randomUUID()}`;
    this.deliveries.set(claim.idempotencyKey, providerMessageId);
    this.attempts.push({
      idempotencyKey: claim.idempotencyKey,
      payloadDigest: claim.payloadDigest,
      recipientCanonicalIdentityId: claim.recipientCanonicalIdentityId,
      providerMessageId,
    });
    return { status: "sent", providerMessageId };
  }
}
