// Codex (ChatGPT) subscription connect / status / usage routes.
//
// Connect uses the device-code flow split into two stateless calls: `start`
// returns a user code + verification URL and an HMAC-signed state carrying the
// device_auth_id; the client opens the URL, authorizes, then drives `poll` on the
// returned interval. No browser redirect and no 15-minute server block, so nothing
// is added to isAuthExempt. Secrets never leave the server: status/usage read the
// decrypted token only to call the codex backend; the token is never returned.

import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  accessTokenExpiry,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  CODEX_MODEL_ID_PREFIX,
  CODEX_PROVIDER_ID,
  CodexDeviceError,
  exchangeDeviceCode,
  fetchCodexModels,
  fetchCodexUsage,
  parseIdToken,
  pollDeviceCode,
  startDeviceCode,
} from "@opengeni/codex";
import {
  deleteCodexSubscriptionCredential,
  encryptEnvironmentValue,
  getCodexCredentialStatus,
  loadCodexCredentialForRun,
  upsertCodexSubscriptionCredential,
} from "@opengeni/db";

// The picker surfaces codex models under their own "no credits" provider group so
// they read distinctly from the platform provider's same-named model.
const CODEX_PROVIDER_LABEL = "Codex subscription · no credits";

function codexModelsForPicker(slugs: string[]): Array<{ id: string; label: string; provider: string; providerLabel: string; api: "responses" }> {
  return slugs
    .filter((slug) => (/^gpt-5/.test(slug) || slug.includes("codex")) && slug !== "codex-auto-review")
    .map((slug) => ({
      id: `${CODEX_MODEL_ID_PREFIX}${slug}`,
      label: slug.replace(/^gpt-/, "GPT-"),
      provider: CODEX_PROVIDER_ID,
      providerLabel: CODEX_PROVIDER_LABEL,
      api: "responses" as const,
    }));
}
import { createSignedState, readSignedState } from "@opengeni/github";
import type { ApiRouteDeps } from "../dependencies";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "../access";

type CodexConnectState = { workspaceId?: string; deviceAuthId?: string; userCode?: string; iat?: number };

const CODEX_DEVICE_EXPIRY_SECONDS = 15 * 60; // the device code expires 15 min after start (spec §1.1)

export function registerCodexRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings, githubStateSecret } = deps;

  // Begin device-code login: returns the user code + verification URL and a
  // signed state that carries the device_auth_id back to `poll`.
  app.post("/v1/workspaces/:workspaceId/codex/connect/start", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    let start: Awaited<ReturnType<typeof startDeviceCode>>;
    try {
      start = await startDeviceCode();
    } catch (error) {
      throw new HTTPException(502, { message: error instanceof CodexDeviceError ? error.message : "failed to start Codex device login" });
    }
    const state = createSignedState(githubStateSecret, { workspaceId, deviceAuthId: start.deviceAuthId, userCode: start.userCode });
    return c.json({ userCode: start.userCode, verificationUri: start.verificationUri, intervalSeconds: start.intervalSeconds, state });
  });

  // Poll for authorization: pending | expired | connected (persists on success).
  app.post("/v1/workspaces/:workspaceId/codex/connect/poll", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const { state } = (await c.req.json()) as { state?: string };
    const payload = (state ? readSignedState(state, githubStateSecret) : null) as unknown as CodexConnectState | null;
    if (!payload || payload.workspaceId !== workspaceId || !payload.deviceAuthId || !payload.userCode) {
      throw new HTTPException(400, { message: "codex connect state is invalid or expired" });
    }
    // The device code itself expires 15 minutes after start; surface that to the
    // client (the 1-hour signed-state TTL is longer than the device window).
    if (typeof payload.iat === "number" && Date.now() / 1000 - payload.iat > CODEX_DEVICE_EXPIRY_SECONDS) {
      return c.json({ status: "expired" });
    }

    let poll: Awaited<ReturnType<typeof pollDeviceCode>>;
    try {
      poll = await pollDeviceCode({ deviceAuthId: payload.deviceAuthId, userCode: payload.userCode });
    } catch (error) {
      throw new HTTPException(502, { message: error instanceof CodexDeviceError ? error.message : "codex device poll failed" });
    }
    if (poll.status === "pending") {
      return c.json({ status: "pending" });
    }
    if (poll.status === "expired") {
      return c.json({ status: "expired" });
    }

    let tokens: Awaited<ReturnType<typeof exchangeDeviceCode>>;
    try {
      tokens = await exchangeDeviceCode({ authorizationCode: poll.authorizationCode, codeVerifier: poll.codeVerifier });
    } catch (error) {
      throw new HTTPException(502, { message: error instanceof CodexDeviceError ? error.message : "codex token exchange failed" });
    }
    const id = parseIdToken(tokens.idToken);
    const key = environmentsEncryptionKeyBytes(settings);
    if (!key) {
      throw new HTTPException(500, { message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured" });
    }
    await upsertCodexSubscriptionCredential(db, {
      accountId: grant.accountId,
      workspaceId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, id_token: tokens.idToken }),
      ),
      chatgptAccountId: id.chatgptAccountId,
      scopes: null, // device grant scopes are discovered at runtime, not asserted here
      planType: id.planType,
      isFedramp: id.isFedramp,
      expiresAt: accessTokenExpiry(tokens.accessToken),
      lastRefreshAt: new Date(),
    });
    return c.json({ status: "connected", plan: id.planType });
  });

  // Connection health: the cheapest real call is GET /codex/models (a 200 proves
  // the token is accepted). Never runs a generation. Never returns the token.
  app.get("/v1/workspaces/:workspaceId/codex/status", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const status = await getCodexCredentialStatus(db, workspaceId);
    if (!status) {
      return c.json({ connected: false });
    }
    let valid = false;
    let models = codexModelsForPicker([...CODEX_FALLBACK_MODEL_SLUGS]); // offline fallback list
    try {
      const cred = await loadCodexCredentialForRun(db, settings, workspaceId);
      if (cred) {
        const live = await fetchCodexModels({
          accessToken: cred.tokens.accessToken,
          chatgptAccountId: cred.chatgptAccountId,
          isFedramp: cred.isFedramp,
          clientVersion: CODEX_CLIENT_VERSION,
        });
        valid = live.ok;
        if (live.ok && live.slugs.length > 0) {
          models = codexModelsForPicker(live.slugs); // prefer the live catalog
        }
      }
    } catch {
      valid = false;
    }
    return c.json({
      connected: status.connected,
      plan: status.planType,
      valid,
      expiresAt: status.expiresAt,
      lastError: status.lastError,
      models, // ClientModel[] the picker surfaces under the "no credits" group
    });
  });

  // Disconnect: remove the workspace's stored credential.
  app.delete("/v1/workspaces/:workspaceId/codex", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const removed = await deleteCodexSubscriptionCredential(db, workspaceId);
    return c.json({ disconnected: removed });
  });

  // Remaining usage / limits from GET /wham/usage. A 404-with-body is a limits state.
  app.get("/v1/workspaces/:workspaceId/codex/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const cred = await loadCodexCredentialForRun(db, settings, workspaceId);
    if (!cred) {
      throw new HTTPException(404, { message: "codex subscription is not connected" });
    }
    const usage = await fetchCodexUsage({
      accessToken: cred.tokens.accessToken,
      chatgptAccountId: cred.chatgptAccountId,
      isFedramp: cred.isFedramp,
      clientVersion: CODEX_CLIENT_VERSION,
    });
    // 404 carries a usage-limit body; 2xx is a normal read; anything else is an error
    // (don't mislabel a 401/500 as "ok").
    const usageStatus = usage.status === 404 ? "limit_reached" : usage.status < 400 ? "ok" : "error";
    return c.json({ status: usageStatus, usage: usage.payload });
  });
}
