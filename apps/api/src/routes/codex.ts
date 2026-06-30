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
  buildCodexUsageWindowFromCache,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  CODEX_FIVE_HOUR_WINDOW_SECONDS,
  CODEX_MODEL_ID_PREFIX,
  CODEX_PROVIDER_ID,
  CODEX_WEEKLY_WINDOW_SECONDS,
  CodexDeviceError,
  exchangeDeviceCode,
  fetchCodexModels,
  parseIdToken,
  pollDeviceCode,
  startDeviceCode,
  type CodexUsagePayload,
} from "@opengeni/codex";
import {
  disconnectAllCodexAccounts,
  disconnectCodexAccount,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  fetchCodexUsageForAccount,
  getCodexCredentialStatus,
  getCodexRotationSettings,
  listCodexAccountStatuses,
  loadCodexCredentialForRun,
  renameCodexAccount,
  setActiveCodexCredential,
  updateCodexRotationSettings,
  upsertCodexSubscriptionCredential,
  CODEX_ROTATION_STRATEGIES,
  type CodexAccountStatus,
  type CodexRotationStrategy,
} from "@opengeni/db";

// The picker surfaces codex models under their own "no credits" provider group so
// they read distinctly from the platform provider's same-named model.
const CODEX_PROVIDER_LABEL = "Codex subscription · no credits";

// The wire shape for one Codex account (metadata only; never the secret column).
// P2: fiveHour/weekly ride along, built from the CACHED usage columns (zero
// provider calls, zero decrypts) so the bars render instantly off this read.
function codexAccountJson(row: CodexAccountStatus) {
  return {
    id: row.id,
    chatgptAccountId: row.chatgptAccountId,
    label: row.label,
    email: row.accountEmail,
    plan: row.planType,
    status: row.status,
    active: row.isActive,
    expiresAt: row.expiresAt,
    lastRefreshAt: row.lastRefreshAt,
    lastError: row.lastError,
    fiveHour: buildCodexUsageWindowFromCache(row.primaryUsedPercent, row.primaryResetAt, CODEX_FIVE_HOUR_WINDOW_SECONDS),
    weekly: buildCodexUsageWindowFromCache(row.secondaryUsedPercent, row.secondaryResetAt, CODEX_WEEKLY_WINDOW_SECONDS),
    usageCheckedAt: row.usageCheckedAt,
    // P3 rotation cooldown: when set and in the future, this account is cooling-down.
    exhaustedUntil: row.exhaustedUntil,
  };
}

// The /codex/usage{,/refresh,/:id} wire wrapper: the rich normalized payload
// carries its own `status`, surfaced at the top level for back-compat with the
// existing CodexUsage = { status; usage } shape.
function codexUsageJson(payload: CodexUsagePayload): { status: CodexUsagePayload["status"]; usage: CodexUsagePayload } {
  return { status: payload.status, usage: payload };
}

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
    const upserted = await upsertCodexSubscriptionCredential(db, {
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
      accountEmail: id.email ?? null,
      label: id.email ?? id.chatgptAccountId ?? null,
    });
    // Ensure the per-workspace rotation-settings row exists, then auto-activate
    // the FIRST account only. Additional new accounts do NOT auto-activate — a
    // manual switch is required (no auto-rotation in P1). A re-connect of the
    // already-active account is a no-op for the pointer.
    await ensureCodexRotationSettings(db, grant.accountId, workspaceId);
    const rotation = await getCodexRotationSettings(db, workspaceId);
    let isActive = rotation?.activeCredentialId === upserted.id;
    if (!isActive && rotation?.activeCredentialId == null) {
      await setActiveCodexCredential(db, workspaceId, upserted.id);
      isActive = true;
    }
    return c.json({ status: "connected", plan: id.planType, accountId: upserted.id, isActive });
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
    const accounts = await listCodexAccountStatuses(db, workspaceId);
    const activeRow = accounts.find((account) => account.id === status.credentialId) ?? null;
    const activeAccount = activeRow
      ? { id: activeRow.id, label: activeRow.label ?? activeRow.accountEmail ?? activeRow.planType ?? activeRow.chatgptAccountId, chatgptAccountId: activeRow.chatgptAccountId }
      : null;
    let valid = false;
    let models = codexModelsForPicker([...CODEX_FALLBACK_MODEL_SLUGS]); // offline fallback list
    try {
      const cred = status.credentialId ? await loadCodexCredentialForRun(db, settings, workspaceId, status.credentialId) : null;
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
      activeAccount, // the account a session runs on when unpinned (label for the indicator)
      accountCount: accounts.length,
    });
  });

  // List every connected Codex account (metadata only, never decrypts) + the
  // workspace active pointer + rotation settings. Read access.
  app.get("/v1/workspaces/:workspaceId/codex/accounts", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const [accounts, rotation] = await Promise.all([
      listCodexAccountStatuses(db, workspaceId),
      getCodexRotationSettings(db, workspaceId),
    ]);
    const activeAccountId = rotation?.activeCredentialId ?? null;
    return c.json({
      accounts: accounts.map(codexAccountJson),
      activeAccountId,
      settings: {
        rotationEnabled: rotation?.rotationEnabled ?? false,
        rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
        activeCredentialId: activeAccountId,
      },
    });
  });

  // Manually switch the workspace ACTIVE account (the one unpinned sessions use).
  // Pure pointer flip; in-flight turns pick it up on their next token fetch.
  app.post("/v1/workspaces/:workspaceId/codex/accounts/:accountId/activate", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const accountId = c.req.param("accountId");
    const activated = await setActiveCodexCredential(db, workspaceId, accountId);
    if (!activated) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    return c.json({ activated: true, accountId });
  });

  // P3: update rotation settings (enable auto-rotation + pick the strategy). admin access.
  // ensureCodexRotationSettings guarantees the row exists, then a one-cell patch.
  app.patch("/v1/workspaces/:workspaceId/codex/settings", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const body = (await c.req.json().catch(() => ({}))) as { rotationEnabled?: unknown; rotationStrategy?: unknown };
    const patch: { rotationEnabled?: boolean; rotationStrategy?: CodexRotationStrategy } = {};
    if (typeof body.rotationEnabled === "boolean") {
      patch.rotationEnabled = body.rotationEnabled;
    }
    if (typeof body.rotationStrategy === "string") {
      if (!CODEX_ROTATION_STRATEGIES.includes(body.rotationStrategy as CodexRotationStrategy)) {
        throw new HTTPException(400, { message: "invalid rotation strategy" });
      }
      patch.rotationStrategy = body.rotationStrategy as CodexRotationStrategy;
    }
    if (patch.rotationEnabled === undefined && patch.rotationStrategy === undefined) {
      throw new HTTPException(400, { message: "no settings to update" });
    }
    await ensureCodexRotationSettings(db, grant.accountId, workspaceId);
    const updated = await updateCodexRotationSettings(db, workspaceId, patch);
    if (!updated) {
      throw new HTTPException(404, { message: "codex rotation settings not found" });
    }
    return c.json({
      rotationEnabled: updated.rotationEnabled,
      rotationStrategy: updated.rotationStrategy,
      activeCredentialId: updated.activeCredentialId,
    });
  });

  // Rename an account (label only in P1).
  app.patch("/v1/workspaces/:workspaceId/codex/accounts/:accountId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const accountId = c.req.param("accountId");
    const body = (await c.req.json()) as { label?: string | null };
    const label = typeof body.label === "string" ? body.label : null;
    const renamed = await renameCodexAccount(db, workspaceId, accountId, label);
    if (!renamed) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    const accounts = await listCodexAccountStatuses(db, workspaceId);
    const row = accounts.find((account) => account.id === accountId);
    if (!row) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    return c.json(codexAccountJson(row));
  });

  // Disconnect ONE account by id. The accessor re-picks active when the removed
  // row was active (FK ON DELETE SET NULL + re-pick in the same RLS txn).
  app.delete("/v1/workspaces/:workspaceId/codex/accounts/:accountId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const accountId = c.req.param("accountId");
    const result = await disconnectCodexAccount(db, workspaceId, accountId);
    return c.json({ disconnected: result.removed, newActiveId: result.newActiveCredentialId });
  });

  // Legacy "disconnect all" (old workspace-wide behavior), deprecated in favor of
  // the by-id route above.
  app.delete("/v1/workspaces/:workspaceId/codex", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const removed = await disconnectAllCodexAccounts(db, workspaceId);
    return c.json({ disconnected: removed > 0 });
  });

  // Back-compat: remaining usage / limits for the ACTIVE account only. Repointed
  // through the refreshing wrapper (P2) so it no longer 401s on an idle account's
  // stale access token. Deprecated in favor of the /accounts + /usage/refresh pair.
  app.get("/v1/workspaces/:workspaceId/codex/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const status = await getCodexCredentialStatus(db, workspaceId);
    if (!status?.credentialId) {
      throw new HTTPException(404, { message: "codex subscription is not connected" });
    }
    const payload = await fetchCodexUsageForAccount(db, settings, workspaceId, status.credentialId);
    return c.json(codexUsageJson(payload));
  });

  // Single-account LIVE usage read (per-row manual refresh): refresh THIS account's
  // bearer, hit /wham/usage, write the cache columns, return the normalized payload.
  app.get("/v1/workspaces/:workspaceId/codex/accounts/:accountId/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const accountId = c.req.param("accountId");
    // Constrain to a real account in this workspace (RLS already scopes, but a 404
    // for an unknown id is friendlier than an opaque needs_relogin payload).
    const accounts = await listCodexAccountStatuses(db, workspaceId);
    if (!accounts.some((account) => account.id === accountId)) {
      throw new HTTPException(404, { message: "codex account not found" });
    }
    const payload = await fetchCodexUsageForAccount(db, settings, workspaceId, accountId);
    return c.json(codexUsageJson(payload));
  });

  // Batched LIVE refresh across every connected account, keyed by credential id.
  // A small concurrency cap + Promise.allSettled so one account's 401/error/timeout
  // can't sink the batch; each entry is independently statused. Writes the cache
  // columns as a side effect. This is what the "Refresh" button and an on-mount
  // staleness check call — NEVER a browser interval.
  app.post("/v1/workspaces/:workspaceId/codex/usage/refresh", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const accounts = await listCodexAccountStatuses(db, workspaceId);
    const usage: Record<string, { status: CodexUsagePayload["status"]; usage: CodexUsagePayload }> = {};
    const queue = [...accounts];
    const CONCURRENCY = 4;
    const worker = async (): Promise<void> => {
      for (;;) {
        const account = queue.shift();
        if (!account) return;
        const settled = await Promise.allSettled([fetchCodexUsageForAccount(db, settings, workspaceId, account.id)]);
        const result = settled[0];
        usage[account.id] = result.status === "fulfilled"
          ? codexUsageJson(result.value)
          : { status: "error", usage: { status: "error", planType: null, fiveHour: null, weekly: null, limitReached: false, fetchedAt: new Date().toISOString() } };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, accounts.length)) }, () => worker()));
    return c.json({ usage });
  });
}
