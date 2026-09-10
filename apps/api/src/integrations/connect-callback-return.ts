import type { Hono } from "hono";
import type { ApiRouteDeps } from "@opengeni/core";
import { getConnectAttempt } from "@opengeni/db";
import { readSignedState } from "@opengeni/github";
import { z } from "zod";

const callbacks = new Set([
  "/v1/integrations/slack/callback",
  "/v1/integrations/fiken/callback",
  "/v1/integrations/atlassian/callback",
  "/v1/integrations/google-drive/callback",
  "/v1/integrations/oauth/callback",
  "/v1/integrations/provider-oauth/callback",
  "/v1/integrations/github-personal/oauth/callback",
  "/v1/social/oauth/callback",
  "/v1/github/oauth/callback",
  "/v1/github/setup",
  "/v1/github/install/callback",
  "/v1/pr-review/github/oauth/callback",
  "/v1/pr-review/github/setup",
  "/v1/pr-review/github/install/callback",
]);
const locator = z.object({
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  subjectId: z.string().min(1).max(1024),
  connectAttemptId: z.string().uuid(),
  iat: z.number().int().nonnegative(),
});

/** Navigation-only recovery. Recently expired signed state can identify the host's saved
 * destination, but cannot authorize exchange, persistence, or credential use.
 * Normal callbacks independently enforce current time and live authority. */
export function registerConnectCallbackReturns(app: Hono, deps: ApiRouteDeps) {
  app.use("/v1/*", async (c, next) => {
    if (c.req.method !== "GET" || !callbacks.has(c.req.path)) return next();
    const raw = c.req.query("state");
    if (!raw || raw.length > 32_768) return next();
    let candidate: z.infer<typeof locator>;
    try {
      candidate = locator.parse(
        JSON.parse(Buffer.from(raw.split(".")[0]!, "base64url").toString("utf8")),
      );
    } catch {
      return next();
    }
    const secret =
      c.req.path.startsWith("/v1/github/") || c.req.path.startsWith("/v1/pr-review/github/")
        ? deps.githubStateSecret
        : deps.settings.integrationsStateSecret?.trim();
    // Verify at the signed timestamp ONLY for a read of the immutable return
    // destination. Never pass this timestamp to the actual provider callback.
    // Keep recovery useful after a normal provider timeout, without making a
    // signed callback an indefinitely reusable redirect. This does not change
    // the trusted backend's exact destination or provider exchange expiry.
    const now = Math.floor(Date.now() / 1000);
    const recoveryWindow = candidate.iat <= now + 60 && candidate.iat >= now - 24 * 60 * 60;
    const verified =
      secret && recoveryWindow
        ? locator.safeParse(readSignedState(raw, secret, candidate.iat))
        : null;
    let destination: string | undefined;
    if (verified?.success) {
      try {
        destination = (
          await getConnectAttempt(deps.db, verified.data, verified.data.connectAttemptId)
        ).returnUrl;
      } catch {
        /* Deleted attempts or unavailable storage cannot supply a return. */
      }
    }
    await next();
    c.res = destination
      ? new Response(null, {
          status: 302,
          headers: { location: destination, "cache-control": "no-store" },
        })
      : new Response(
          "Connection setup could not be completed. Return to the application and start again.",
          {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          },
        );
  });
}
