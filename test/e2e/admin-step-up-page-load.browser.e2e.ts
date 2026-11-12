import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } from "@opengeni/contracts/managed-sign-in-methods";
import { type ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import {
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import { freePort } from "@opengeni/testing/compose";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { chromium, type Browser, type Page } from "playwright";

import { createApp } from "../../apps/api/src/app";
import { createManagedAuth, hashManagedAuthPassword } from "../../apps/api/src/auth/managed-auth";
import { createBetterAuthSessionAdapter } from "../../apps/api/src/auth/managed-auth-session-adapter";
import { apiRequestBindingsForTransportPeer } from "../../apps/api/src/http/request-source";

/*
 * An owner signed in with a password (a session never confirmed with a
 * passkey) opens the admin pages of a shared workspace with the admin passkey
 * step-up required. Opening and viewing a page must never ask for the passkey
 * or be refused: only a change to who has access does.
 */

const repoRoot = new URL("../..", import.meta.url).pathname;
const EVIDENCE_DIR =
  process.env.OPENGENI_STEP_UP_EVIDENCE_DIR ?? "/tmp/opengeni-admin-step-up-evidence";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

let shared: SharedTestDatabase | undefined;
let client: DbClient | undefined;
let browser: Browser | undefined;
let edge: ReturnType<typeof Bun.serve> | undefined;
let origin = "";
let cookies: { name: string; value: string }[] = [];
let workspaceId = "";

type Refusal = { method: string; path: string; status: number; code: unknown };

beforeAll(async () => {
  shared = (await acquireSharedTestDatabase("admin-step-up-page-load")) ?? undefined;
  if (!shared) throw new Error("Admin step-up page-load acceptance requires PostgreSQL");
  client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
  // localhost: passkeys (and so the step-up) are offered only on https or localhost.
  origin = `http://localhost:${await freePort()}`;
  const transport: ManagedEmailTransport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:admin-step-up-page-load", retentionSeconds: 86400 },
    send: async () => ({ status: "sent" as const, providerMessageId: null }),
  };
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "managed",
    managedAuthSessionSetMode: "legacy",
    publicBaseUrl: origin,
    betterAuthSecret: "admin-step-up-page-load-secret-at-least-32-bytes",
    managedAuthRequireEmailVerification: false,
    managedAuthPasskeySignUpEnabled: true,
    adminPasskeyStepUp: "required",
    integrationsEnabled: true,
    environmentsEncryptionKey: ENCRYPTION_KEY,
    apiTrustedProxyHops: 1,
    sandboxBackend: "none",
  });
  const auth = createManagedAuth(settings, client.db, transport)!;
  const adapter = createBetterAuthSessionAdapter(auth, client.db);
  const api = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    managedAuthSessionAdapter: adapter,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });

  // The console bundles the browser extension archive.
  const extensionBuild = Bun.spawn(["bun", "run", "build"], {
    cwd: `${repoRoot}/apps/browser-extension`,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await extensionBuild.exited) !== 0) {
    throw new Error(await new Response(extensionBuild.stderr).text());
  }
  const webBuild = Bun.spawn(["bun", "run", "vite", "build"], {
    cwd: `${repoRoot}/apps/web`,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", VITE_API_BASE_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await webBuild.exited) !== 0) throw new Error(await new Response(webBuild.stderr).text());
  const webDist = `${repoRoot}/apps/web/dist`;
  edge = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(new URL(origin).port),
    idleTimeout: 60,
    fetch: async (request, server) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
        return await api.fetch(
          request,
          apiRequestBindingsForTransportPeer(server.requestIP(request)?.address),
        );
      }
      const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const requested = safePath.includes("..") ? null : Bun.file(`${webDist}/${safePath}`);
      const asset =
        requested && (await requested.exists()) ? requested : Bun.file(`${webDist}/index.html`);
      return new Response(asset, { headers: { "content-type": asset.type } });
    },
  });

  // An owner who signed in with a password: their session is never confirmed.
  const userId = crypto.randomUUID();
  const email = `owner-${userId}@example.test`;
  await shared.admin`insert into auth_users(id,name,email,email_verified)
    values(${userId},'Password Owner',${email},true)`;
  await shared.admin`insert into auth_identities(id,user_id,provider_id,account_id,password,created_at,updated_at)
    values(${crypto.randomUUID()},${userId},'credential',${userId},${await hashManagedAuthPassword("fixture-password-123")},now(),now())`;
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding =
    projection.loginBindings.find((candidate) => candidate.providerId === "credential") ??
    projection.loginBindings[0]!;
  const token = crypto.randomUUID();
  await shared.admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
    values(${crypto.randomUUID()},${userId},${token},now()+interval '1 hour',${projection.activeIdentity.id},${projection.activeIdentity.identityRevision},${projection.activeIdentity.authRevision},${binding.id},${binding.revision})`;
  const setCookies = await adapter.createLegacySelectedSessionCookies({ token } as never, null);
  const cookieHeader = setCookies
    .map((cookie: string) => cookie.split(";", 1)[0]!)
    .filter((cookie: string) => !cookie.endsWith("="))
    .join("; ");
  cookies = cookieHeader.split("; ").map((pair) => {
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1) };
  });

  // Set up with the API itself: an organization, its shared workspace and a
  // shared connection. Creating these isn't asked, except the connection,
  // which goes in directly.
  const call = async (method: string, path: string, body: unknown) => {
    const response = await api.request(path, {
      method,
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: cookieHeader,
      },
      body: JSON.stringify(body),
    });
    expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBeLessThan(
      300,
    );
    return (await response.json()) as Record<string, unknown>;
  };
  const created = (await call("POST", "/v1/organizations", {
    name: "Step-up Page Load",
    operationId: crypto.randomUUID(),
  })) as { organization: { id: string } };
  const workspace = (await call("POST", "/v1/workspaces", {
    accountId: created.organization.id,
    name: "Shared",
  })) as { id?: string; workspace?: { id: string } };
  workspaceId = (workspace.workspace?.id ?? workspace.id)!;
  await shared.admin`update auth_sessions set mfa_verified_at = now() where token = ${token}`;
  await call("POST", `/v1/workspaces/${workspaceId}/connections`, {
    providerDomain: "page-load.example.test",
    kind: "api_key",
    credential: { headers: { "X-Api-Key": "fixture-key" } },
  });
  await shared.admin`update auth_sessions set mfa_verified_at = null where token = ${token}`;

  browser = await chromium.launch(
    process.env.OPENGENI_BROWSER_BIN
      ? { executablePath: process.env.OPENGENI_BROWSER_BIN }
      : undefined,
  );
  await mkdir(EVIDENCE_DIR, { recursive: true });
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await edge?.stop(true);
  await client?.close();
  await shared?.release();
}, 180_000);

/** Open a page, wait for it to settle, and return what the API refused meanwhile. */
async function open(
  page: Page,
  path: string,
  then?: (page: Page) => Promise<void>,
): Promise<{ refusals: Refusal[]; prompted: number }> {
  const refusals: Refusal[] = [];
  const pending: Promise<void>[] = [];
  const listener = (response: import("playwright").Response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/v1/") || response.status() !== 403) return;
    pending.push(
      response
        .json()
        .catch(() => null)
        .then((body: { error?: { details?: { code?: unknown } } } | null) => {
          refusals.push({
            method: response.request().method(),
            path: url.pathname,
            status: response.status(),
            code: body?.error?.details?.code,
          });
        }),
    );
  };
  page.on("response", listener);
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  if (then) {
    await then(page);
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(1_500);
  page.off("response", listener);
  await Promise.all(pending);
  const prompted = await page
    .getByRole("dialog")
    .filter({ hasText: /Confirm it's you|Add a passkey|Confirm in your browser/u })
    .count();
  return { refusals, prompted };
}

describe("admin pages with the passkey step-up required", () => {
  test("a password-only owner opens connections, members, settings and billing without a prompt or a refusal", async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 960 } });
    await context.addCookies(
      cookies.map((cookie) => ({ ...cookie, url: origin, httpOnly: true, sameSite: "Lax" })),
    );
    const page = await context.newPage();
    const results: Record<string, { refusals: Refusal[]; prompted: number }> = {};
    const connectionsTab = async (target: Page) => {
      await target.getByRole("tab", { name: "Connections", exact: true }).click();
    };
    for (const [name, path, then] of [
      ["capabilities", `/workspaces/${workspaceId}/capabilities`, undefined],
      ["connections", `/workspaces/${workspaceId}/capabilities`, connectionsTab],
      ["integrations", `/workspaces/${workspaceId}/integrations`, undefined],
      ["members", `/workspaces/${workspaceId}/settings?section=members`, undefined],
      ["settings", `/workspaces/${workspaceId}/settings`, undefined],
      ["organization", `/workspaces/${workspaceId}/organization`, undefined],
      ["billing", `/workspaces/${workspaceId}/billing`, undefined],
    ] as const) {
      results[name] = await open(page, path, then);
      if (name === "connections") {
        await page.screenshot({ path: `${EVIDENCE_DIR}/connections.png` });
      }
    }
    console.log("admin step-up page load", JSON.stringify(results));
    for (const [name, result] of Object.entries(results)) {
      expect(
        result.refusals.filter((refusal) => refusal.code === ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE),
        `${name}: step-up refusals`,
      ).toEqual([]);
      expect(result.refusals, `${name}: refusals`).toEqual([]);
      expect(result.prompted, `${name}: passkey prompt`).toBe(0);
    }
    await context.close();
  }, 300_000);
});
