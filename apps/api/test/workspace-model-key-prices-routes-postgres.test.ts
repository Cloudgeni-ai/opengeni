import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { connectedModelPriceBasisModelIds } from "@opengeni/config";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import type { Hono } from "hono";
import { createApp } from "../src/app";

// A workspace's own OpenAI, Azure OpenAI and OpenAI-compatible model keys
// carry a price like an organization's models, over real PostgreSQL through
// the full application: a new Azure key is priced from the base model Azure
// reports serving, an administrator can set or clear its price in place
// (its version, and so its model's id, never change), and the workspace's
// connection list says whether each key's usage is priced.

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ORIGIN = "http://opengeni.test";
const ENDPOINT = "https://contoso.openai.azure.com";
const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: ORIGIN,
  sandboxBackend: "none",
  integrationsEnabled: true,
  betterAuthSecret: "workspace-model-key-price-secret-at-least-32-bytes",
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
/** The model id the fake provider answers with, as Azure reports a deployment's base model. */
let reportedModel: string | undefined;
const signedIn = new Map<string, { authSessionId: string; userId: string; email: string }>();

function fullApp(): Hono {
  const noop = async () => undefined;
  return createApp({
    db: client!.db,
    bus: new MemoryEventBus(),
    settings,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "workspace-model-key-price-state-secret",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    directModelFetch: (async () =>
      Response.json({
        status: "completed",
        output: [],
        choices: [{ message: { role: "assistant", content: "OK" } }],
        ...(reportedModel === undefined ? {} : { model: reportedModel }),
      })) as unknown as typeof fetch,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const record = signedIn.get(headers.get("cookie") ?? "");
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: { id: record.userId, email: record.email, name: "Managed human" },
            },
          };
        },
      },
    } as never,
  } as unknown as ApiRouteDeps) as unknown as Hono;
}

type Human = { cookie: string; workspaceId: string };

async function signIn(label: string): Promise<Human> {
  const userId = `model-key-price-${label}-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  await shared!.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${label}, ${email}, true)`;
  await shared!.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const access = await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId,
    email,
    name: label,
    emailVerified: true,
  });
  const identity = await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  await shared!.admin`insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  const cookie = `session=${authSessionId}`;
  signedIn.set(cookie, { authSessionId, userId, email });
  return { cookie, workspaceId: access.accessContext.workspaceGrants[0]!.workspaceId! };
}

async function call(
  who: Human,
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await app!.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: who.cookie,
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

/** Connect a workspace key as the web app does, after the API's test request. */
async function connectKey(
  who: Human,
  directModelProvider: Record<string, unknown>,
  providerDomain: string,
) {
  const response = await call(who, "POST", `/v1/workspaces/${who.workspaceId}/connections`, {
    providerDomain,
    kind: "api_key",
    subjectId: null,
    credential: { apiKey: "sk-workspace-key" },
    grantedScopes: [],
    metadata: {
      credentialRole: `direct_${directModelProvider.provider as string}`,
      credentialLabel: "Key",
      directModelProvider,
    },
    operationId: crypto.randomUUID(),
    verifyModelAccess: true,
  });
  expect(response.status).toBe(201);
  return response.json.connection as Record<string, any>;
}

const listed = async (who: Human, id: string) =>
  (
    (await call(who, "GET", `/v1/workspaces/${who.workspaceId}/connections`)).json.connections as {
      id: string;
    }[]
  ).find((connection) => connection.id === id);

let owner: Human;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("api-workspace-model-key-prices");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
  app = fullApp();
  owner = await signIn("owner");
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe.skipIf(!realDb)("workspace model key prices", () => {
  test("a new Azure key is priced from the base model Azure reports serving", async () => {
    reportedModel = "gpt-6-astra-2026-03-05";
    const connection = await connectKey(
      owner,
      { provider: "azure_openai", model: "team-reasoning", endpoint: ENDPOINT },
      "contoso.openai.azure.com",
    );
    expect(connection.listPrice).toEqual({ basis: "model", modelId: "gpt-6-astra" });
    expect(await listed(owner, connection.id)).toMatchObject({
      listPrice: { basis: "model", modelId: "gpt-6-astra" },
      listPriceKnown: true,
    });
  });

  test("a key whose model has no known price stays unpriced, and an admin prices it in place", async () => {
    reportedModel = "in-house-model";
    const connection = await connectKey(
      owner,
      { provider: "azure_openai", model: "team-in-house", endpoint: ENDPOINT },
      "contoso.openai.azure.com",
    );
    expect(connection.listPrice).toBeNull();
    expect(await listed(owner, connection.id)).toMatchObject({
      listPrice: null,
      listPriceKnown: false,
    });

    const path = `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/list-price`;
    const custom = await call(owner, "PUT", path, {
      listPrice: {
        basis: "custom",
        pricing: {
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 4_000_000,
        },
      },
    });
    expect(custom.status).toBe(200);
    expect(custom.json.connection).toMatchObject({
      version: connection.version,
      listPrice: { basis: "custom" },
      listPriceKnown: true,
    });

    // A base model must have a known price, or the key would silently stay unpriced.
    const unknownBase = await call(owner, "PUT", path, {
      listPrice: { basis: "model", modelId: "in-house-model" },
    });
    expect(unknownBase.status).toBe(422);

    const cleared = await call(owner, "PUT", path, { listPrice: null });
    expect(cleared.json.connection).toMatchObject({ listPrice: null, listPriceKnown: false });
  });

  test("an OpenAI-compatible endpoint's own answer is not trusted as its price", async () => {
    reportedModel = "gpt-6-astra";
    const connection = await connectKey(
      owner,
      {
        provider: "openai_compatible",
        model: "acme/fast-1",
        baseUrl: "https://inference.example.com/v1",
      },
      "inference.example.com",
    );
    expect(connection.listPrice).toBeNull();
    const priced = await call(
      owner,
      "PUT",
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/list-price`,
      { listPrice: { basis: "model", modelId: "gpt-6-astra" } },
    );
    expect(priced.json.connection).toMatchObject({ listPriceKnown: true });
  });

  test("only a model key has a price, and the price choices are the catalogue's", async () => {
    const missing = await call(
      owner,
      "PUT",
      `/v1/workspaces/${owner.workspaceId}/connections/${crypto.randomUUID()}/list-price`,
      { listPrice: null },
    );
    expect(missing.status).toBe(404);
    const bases = await call(
      owner,
      "GET",
      `/v1/workspaces/${owner.workspaceId}/model-price-basis-models`,
    );
    expect(bases.status).toBe(200);
    expect(bases.json.priceBasisModelIds).toEqual(connectedModelPriceBasisModelIds(settings));
    expect(bases.json.priceBasisModelIds).toContain("gpt-6-astra");
  });
});
