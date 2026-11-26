import { createHash } from "node:crypto";
import {
  AI_PROCESSING_CONSENT_REQUIRED,
  AI_PROCESSING_CONSENT_VERSION_MISMATCH,
  GrantAiProcessingConsentRequest,
  type AiProcessingConsentResponse,
  type AiProcessingDisclosure,
} from "@opengeni/contracts";
import {
  managedHumanClientForAccessContext,
  requireAccessContext,
  type ApiRouteDeps,
} from "@opengeni/core";
import { selfAiProcessingConsent } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { ApiHttpError } from "../http/api-error";
import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";
import { parseRequestJson } from "../http/request-body";

// Add a platform when its native client can present and record consent.
export const AI_PROCESSING_CONSENT_ENFORCED_PLATFORMS = ["ios"] as const;

export function aiProcessingDisclosure(settings: ApiRouteDeps["settings"]): AiProcessingDisclosure {
  const providers = [...new Set(settings.aiProcessingConsentProviders)].sort();
  const recipients = providers.length
    ? providers.join(", ")
    : "the AI providers that run your selected features";
  const disclosure = {
    title: "Allow sharing with AI providers?",
    body: `To run AI features, Opengeni sends your messages, attached files, tool results, and voice to third-party AI providers: ${recipients}. If you or your organization connect your own AI subscription or API key, that provider receives this data too. This data can include personal information. You can withdraw permission at any time in Settings.`,
    providers,
    privacyUrl: settings.aiProcessingConsentPrivacyUrl ?? settings.legalPrivacyPolicyUrl ?? null,
  };
  return {
    ...disclosure,
    version: createHash("sha256").update(JSON.stringify(disclosure)).digest("hex"),
  };
}

async function humanClient(c: Context, deps: ApiRouteDeps) {
  return managedHumanClientForAccessContext(await requireAccessContext(c, deps));
}

/** Check before a native request admits new inference or contacts a provider. */
export async function requireAiProcessingConsent(c: Context, deps: ApiRouteDeps): Promise<void> {
  const refusal = await aiProcessingConsentRefusal(c, deps);
  if (refusal) throw refusal;
}

/** Separate the inference refusal from local capture cleanup that must still finish. */
export async function aiProcessingConsentRefusal(
  c: Context,
  deps: ApiRouteDeps,
): Promise<ApiHttpError | null> {
  if (!deps.managedAuth) return null; // Only Better Auth can mint these sessions.
  const client = await humanClient(c, deps);
  if (!client || !AI_PROCESSING_CONSENT_ENFORCED_PLATFORMS.some((p) => p === client.platform)) {
    return null;
  }
  const { version } = aiProcessingDisclosure(deps.settings);
  if (await selfAiProcessingConsent(deps.db, client.authUserId, version)) return null;
  return new ApiHttpError(403, {
    code: "forbidden",
    message: "Allow sharing with AI providers before using this feature.",
    retryable: false,
    details: { code: AI_PROCESSING_CONSENT_REQUIRED },
  });
}

export function registerAiProcessingConsentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const disclosure = aiProcessingDisclosure(deps.settings);
  const state = (consent: AiProcessingConsentResponse["consent"]): AiProcessingConsentResponse => ({
    required: consent === null,
    disclosure,
    consent,
  });
  async function self(c: Context, mutate = false) {
    c.header("cache-control", "private, no-store");
    const client = await humanClient(c, deps);
    if (!client || (client.authMethod === "cookie" && c.req.header("authorization"))) {
      throw new ApiHttpError(403, {
        code: "forbidden",
        message: "Sign in to your Opengeni account.",
      });
    }
    if (mutate && client.authMethod === "cookie") requireSameOriginBrowserMutation(c, deps);
    return client;
  }

  app.get("/v1/me/ai-processing-consent", async (c) => {
    const { authUserId } = await self(c);
    return c.json(state(await selfAiProcessingConsent(deps.db, authUserId, disclosure.version)));
  });
  app.post("/v1/me/ai-processing-consent", async (c) => {
    const { authUserId, platform } = await self(c, true);
    const { version } = await parseRequestJson(c, GrantAiProcessingConsentRequest);
    if (version !== disclosure.version) {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "The AI provider disclosure changed. Review it again before granting permission.",
        retryable: false,
        details: { code: AI_PROCESSING_CONSENT_VERSION_MISMATCH },
      });
    }
    return c.json(
      state(
        await selfAiProcessingConsent(deps.db, authUserId, version, {
          kind: "grant",
          disclosure,
          platform,
        }),
      ),
    );
  });
  app.delete("/v1/me/ai-processing-consent", async (c) => {
    const { authUserId } = await self(c, true);
    return c.json(
      state(
        await selfAiProcessingConsent(deps.db, authUserId, disclosure.version, {
          kind: "withdraw",
        }),
      ),
    );
  });
}
