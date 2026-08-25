import type { Settings } from "@opengeni/config";
import type {
  ManagedEmailDeliveryResult,
  ManagedEmailMessage,
  ManagedEmailTransport,
} from "@opengeni/core";
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

  constructor(
    private readonly options: {
      maxMessages?: number;
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

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
  async send(): Promise<ManagedEmailDeliveryResult> {
    return { status: "failed", errorClass: "provider_not_configured" };
  }
}

class ResendManagedEmailTransport implements ManagedEmailTransport {
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult> {
    try {
      const result = await this.client.emails.send(
        {
          from: this.from,
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
    return new ResendManagedEmailTransport(settings.resendApiKey, settings.emailFrom);
  }
  if (settings.environment === "local" || settings.environment === "test") {
    return new InMemoryManagedEmailTransport();
  }
  return new UnconfiguredManagedEmailTransport();
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
