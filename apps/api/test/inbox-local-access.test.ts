import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createApiKey,
  createDb,
  createSession,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerInboxRoutes } from "../src/routes/inbox";

const SECRET = "inbox-local-access-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let local: { accountId: string; workspaceId: string } | null = null;

function inboxApp(productAccessMode: "local" | "configured"): Hono {
  const app = new Hono();
  registerInboxRoutes(app, {
    db: client!.db,
    settings: testSettings({ productAccessMode, delegationSecret: SECRET }),
    managedAuth: null,
  } as ApiRouteDeps);
  return app;
}

async function delegated(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  principalKind: "human_session" | "service";
}): Promise<Record<string, string>> {
  const permissions: Permission[] = ["sessions:read", "sessions:control"];
  return {
    authorization: `Bearer ${await signDelegatedAccessToken(SECRET, {
      ...input,
      permissions,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`,
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-inbox-local-access");
  if (!shared) {
    if (requireRealDatabase) throw new Error("inbox local access tests require PostgreSQL");
    return;
  }
  client = createDb(shared.appUrl);
  // What the local access bootstrap creates on first request.
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:local",
    accountExternalId: "default",
    accountName: "Local",
    workspaceExternalSource: "opengeni:local",
    workspaceExternalId: "default",
    workspaceName: "Local",
    subjectId: "dev",
    subjectLabel: "Local dev",
  });
  local = { accountId: access.defaultAccountId!, workspaceId: access.defaultWorkspaceId! };
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("inbox access on a local install", () => {
  test("the local install's human reads its inbox, with its sessions' questions", async () => {
    if (!client || !local) return;
    const session = await createSession(client.db, {
      ...local,
      initialMessage: "Ask me something",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: "dev", label: "Local dev" },
      createdByContext: { label: "Local dev" },
    });
    await appendSessionEvents(client.db, local.workspaceId, session.id, [
      {
        type: "session.humanInput.requested",
        payload: {
          request: { id: crypto.randomUUID(), questions: [{ prompt: "Which color?" }] },
        },
      },
    ]);

    const response = await inboxApp("local").request("http://x/v1/inbox");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ sessionId: string; kind: string; title: string }>;
      needsYouCount: number;
    };
    expect(body.items.filter((item) => item.sessionId === session.id)).toMatchObject([
      { kind: "question", title: "Which color?" },
    ]);
    expect(body.needsYouCount).toBeGreaterThanOrEqual(1);

    const settings = await inboxApp("local").request("http://x/v1/inbox/settings");
    expect(settings.status).toBe(200);
  });

  test("the local human mutes one session's replies through the session seam", async () => {
    if (!client || !local) return;
    const session = await createSession(client.db, {
      ...local,
      initialMessage: "Mute me",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: "dev", label: "Local dev" },
      createdByContext: { label: "Local dev" },
    });
    const app = inboxApp("local");
    const url = `http://x/v1/workspaces/${local.workspaceId}/sessions/${session.id}/inbox-mute`;
    const muted = await app.request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repliesMuted: true }),
    });
    expect(muted.status).toBe(200);
    expect(await muted.json()).toEqual({ repliesMuted: true });
    const read = await app.request(url);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ repliesMuted: true });

    const missing = await app.request(
      `http://x/v1/workspaces/${local.workspaceId}/sessions/${crypto.randomUUID()}/inbox-mute`,
    );
    expect(missing.status).toBe(404);
  });

  test("a delegated bearer naming `dev` is not the local human", async () => {
    if (!client || !local) return;
    const app = inboxApp("local");
    for (const principalKind of ["human_session", "service"] as const) {
      const response = await app.request("http://x/v1/inbox", {
        headers: await delegated({ ...local, subjectId: "dev", principalKind }),
      });
      expect(response.status).toBe(403);
    }
  });

  test("API keys and configured `dev` subjects have no inbox", async () => {
    if (!client) return;
    const configured = await bootstrapWorkspace(client.db, {
      accountExternalSource: "opengeni:configured",
      accountExternalId: `inbox-${crypto.randomUUID()}`,
      accountName: "Configured",
      workspaceExternalSource: "opengeni:configured",
      workspaceExternalId: `inbox-${crypto.randomUUID()}`,
      workspaceName: "Configured",
      subjectId: "dev",
    });
    const scope = {
      accountId: configured.defaultAccountId!,
      workspaceId: configured.defaultWorkspaceId!,
    };
    const token = `og_${crypto.randomUUID()}`;
    await createApiKey(client.db, {
      ...scope,
      name: "Inbox key",
      prefix: "og_test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["sessions:read"],
    });
    const app = inboxApp("configured");
    const keyed = await app.request("http://x/v1/inbox", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(keyed.status).toBe(403);
    const configuredDev = await app.request("http://x/v1/inbox", {
      headers: await delegated({ ...scope, subjectId: "dev", principalKind: "human_session" }),
    });
    expect(configuredDev.status).toBe(403);
  });
});
