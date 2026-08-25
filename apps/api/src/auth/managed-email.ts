import type { Settings } from "@opengeni/config";
import type {
  ManagedEmailDeliveryResult,
  ManagedEmailMessage,
  ManagedEmailTransport,
} from "@opengeni/core";
import { createHmac } from "node:crypto";
import { Resend } from "resend";

const CAPTURE_MAX_MESSAGES = 250;
const CAPTURE_TTL_MS = 15 * 60 * 1000;

export type CapturedManagedEmail = ManagedEmailMessage & {
  capturedAt: string;
};

/**
 * Process-local test/development transport. Captures are count/TTL bounded and
 * one-time readable; there is deliberately no route, disk, database, or log
 * projection for message bodies or setup bearers.
 */
export class InMemoryManagedEmailTransport implements ManagedEmailTransport {
  private readonly messages: CapturedManagedEmail[] = [];
  readonly sender: string;
  readonly idempotency: ManagedEmailTransport["idempotency"];

  constructor(
    private readonly options: {
      maxMessages?: number;
      ttlMs?: number;
      now?: () => number;
      sender?: string;
      idempotency?: ManagedEmailTransport["idempotency"];
    } = {},
  ) {
    this.sender = options.sender ?? "OpenGeni <auth@mail.opengeni.ai>";
    this.idempotency = options.idempotency ?? {
      scope: "opengeni-in-memory-v1",
      retentionSeconds: 86_400,
    };
  }

  async send(message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult> {
    this.prune();
    const maxMessages = this.options.maxMessages ?? CAPTURE_MAX_MESSAGES;
    if (this.messages.length >= maxMessages) this.messages.splice(0, 1);
    this.messages.push({
      ...message,
      capturedAt: new Date(this.now()).toISOString(),
    });
    return { status: "sent", providerMessageId: null };
  }

  take(predicate: (message: CapturedManagedEmail) => boolean): CapturedManagedEmail | null {
    this.prune();
    const index = this.messages.findIndex(predicate);
    if (index < 0) return null;
    return this.messages.splice(index, 1)[0] ?? null;
  }

  size(): number {
    this.prune();
    return this.messages.length;
  }

  private prune(): void {
    const cutoff = this.now() - (this.options.ttlMs ?? CAPTURE_TTL_MS);
    while (this.messages[0] && Date.parse(this.messages[0].capturedAt) <= cutoff) {
      this.messages.shift();
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

class UnconfiguredManagedEmailTransport implements ManagedEmailTransport {
  readonly idempotency = {
    scope: "opengeni-unconfigured-v1",
    retentionSeconds: 0,
  } as const;

  constructor(readonly sender: string) {}

  async send(): Promise<ManagedEmailDeliveryResult> {
    return { status: "failed", errorClass: "provider_not_configured" };
  }
}

class ResendManagedEmailTransport implements ManagedEmailTransport {
  private readonly client: Resend;
  readonly idempotency: ManagedEmailTransport["idempotency"];

  constructor(
    apiKey: string,
    readonly sender: string,
    scopeSecret: string,
  ) {
    this.client = new Resend(apiKey);
    this.idempotency = {
      // The keyed digest binds this delivery to the Resend account without
      // persisting an API-key derivative that can be tested offline.
      scope: `resend-v1-24h:${createHmac("sha256", scopeSecret).update(apiKey).digest("hex")}`,
      retentionSeconds: 86_400,
    };
  }

  async send(message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult> {
    if (message.from !== this.sender) {
      return { status: "failed", errorClass: "sender_changed" };
    }
    try {
      const result = await this.client.emails.send(
        {
          from: message.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
        message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
      );
      if (!result.error) {
        return { status: "sent", providerMessageId: result.data?.id ?? null };
      }
      const statusCode = "statusCode" in result.error ? Number(result.error.statusCode) : NaN;
      return clearProviderRefusal(statusCode)
        ? { status: "failed", errorClass: boundedErrorClass(result.error.name, "provider_refused") }
        : {
            status: "outcome_unknown",
            errorClass: boundedErrorClass(result.error.name, "provider_ambiguous"),
          };
    } catch (error) {
      return {
        status: "outcome_unknown",
        errorClass: boundedErrorClass(
          error instanceof Error ? error.name : "transport_error",
          "transport_error",
        ),
      };
    }
  }
}

export function createManagedEmailTransport(settings: Settings): ManagedEmailTransport {
  if (settings.resendApiKey) {
    if (!settings.betterAuthSecret) {
      throw new Error("OPENGENI_BETTER_AUTH_SECRET is required for managed email delivery");
    }
    return new ResendManagedEmailTransport(
      settings.resendApiKey,
      settings.emailFrom,
      settings.betterAuthSecret,
    );
  }
  if (settings.environment === "local" || settings.environment === "test") {
    return new InMemoryManagedEmailTransport({ sender: settings.emailFrom });
  }
  return new UnconfiguredManagedEmailTransport(settings.emailFrom);
}

function clearProviderRefusal(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500 && ![408, 409, 425, 429].includes(statusCode);
}

function boundedErrorClass(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "_")
    .slice(0, 64);
  return normalized || fallback;
}
