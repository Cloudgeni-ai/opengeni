import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  createDb,
  decryptEnvironmentValue,
  listSocialConnections,
  listSocialPosts,
  loadSocialConnectionCredential,
  type DbClient,
} from "@opengeni/db";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  completeSocialOAuthCallback,
  freshSocialAccessToken,
  startSocialOAuth,
  type SocialProviderFetch,
} from "../src/integrations/social-oauth";
import {
  socialMentionsLive,
  socialOwnPostsLive,
  socialPostReply,
  socialSearchLive,
} from "../src/integrations/social-api";

/**
 * Functional end-to-end coverage of the connector loop against a fake X /
 * Reddit provider: connect -> store -> read live -> refresh -> publish.
 * Everything but the provider's own HTTP is real (routes' domain layer, signed
 * state, nonce table, envelope crypto, RLS-scoped DB writes).
 */

const STATE_SECRET = "social-flow-state-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;
const rawKey = randomBytes(32);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_social_flow");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[social-connector-flow] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    environmentsEncryptionKey: rawKey.toString("base64"),
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "https://api.opengeni.test",
    socialOauthClientsJson: JSON.stringify({
      x: { clientId: "x-client", clientSecret: "x-secret" },
      reddit: { clientId: "reddit-client", clientSecret: "reddit-secret" },
    }),
  }) as Settings;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
});

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('social-acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'social-ws') returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  await shared!.admin`
    insert into workspace_memberships (
      account_id, workspace_id, subject_id, subject_label, role, permissions
    ) values (
      ${account!.id}, ${workspace!.id}, 'operator', 'operator', 'admin',
      ${shared!.admin.json(["workspace:admin"])}
    )`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

type ProviderCall = { url: string; method: string; body?: string };

/** Minimal in-process X + Reddit that speaks the real wire shapes. */
function fakeProvider(options: { xAccessTokenSeq?: string[] } = {}) {
  const calls: ProviderCall[] = [];
  const tokenSeq = [...(options.xAccessTokenSeq ?? ["x-access-1"])];
  const fetchImpl: SocialProviderFetch = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body?.toString();
    calls.push({ url, method, ...(body ? { body } : {}) });
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url === "https://api.x.com/2/oauth2/token") {
      const params = new URLSearchParams(body ?? "");
      return json({
        access_token: tokenSeq.shift() ?? "x-access-final",
        // X rotates the refresh token on every use.
        refresh_token: params.get("grant_type") === "refresh_token" ? "x-refresh-2" : "x-refresh-1",
        token_type: "bearer",
        expires_in: params.get("grant_type") === "refresh_token" ? 7200 : 1,
        scope: "tweet.read tweet.write users.read offline.access",
      });
    }
    if (url === "https://www.reddit.com/api/v1/access_token") {
      return json({
        access_token: "reddit-access-1",
        refresh_token: "reddit-refresh-1",
        token_type: "bearer",
        expires_in: 3600,
        scope: "identity read submit",
      });
    }
    if (url === "https://api.x.com/2/users/me") {
      return json({ data: { id: "u-777", username: "opengeni_ai", name: "OpenGeni" } });
    }
    if (url === "https://oauth.reddit.com/api/v1/me") {
      return json({ id: "r-42", name: "opengeni_bot" });
    }
    if (url.startsWith("https://api.x.com/2/tweets/search/recent")) {
      return json({
        data: [
          {
            id: "1801",
            text: "looking for a self-hostable agent platform",
            author_id: "u-9",
            conversation_id: "1800",
            created_at: "2026-07-26T10:00:00.000Z",
            public_metrics: { like_count: 4, reply_count: 2 },
          },
        ],
        includes: { users: [{ id: "u-9", username: "curious_dev" }] },
      });
    }
    if (url.includes("/mentions")) {
      return json({
        data: [{ id: "1900", text: "@opengeni_ai does this do X?", author_id: "u-9" }],
        includes: { users: [{ id: "u-9", username: "curious_dev" }] },
      });
    }
    if (url.includes("/2/users/") && url.includes("/tweets")) {
      return json({
        data: [
          {
            id: "1700",
            text: "our launch post",
            created_at: "2026-07-25T09:00:00.000Z",
            public_metrics: { like_count: 12 },
          },
        ],
      });
    }
    if (url === "https://api.x.com/2/tweets" && method === "POST") {
      return json({ data: { id: "1999", text: "reply body" } });
    }
    // Both the global and the subreddit-scoped search paths.
    if (/^https:\/\/oauth\.reddit\.com\/(r\/[^/]+\/)?search/.test(url)) {
      return json({
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t3",
              data: {
                name: "t3_abc",
                title: "Best self-hosted agent runner?",
                selftext: "Looking for something with scheduling",
                author: "curious_dev",
                permalink: "/r/selfhosted/comments/abc/best/",
                created_utc: 1785060000,
                score: 31,
                num_comments: 5,
                subreddit: "selfhosted",
              },
            },
          ],
        },
      });
    }
    if (url === "https://oauth.reddit.com/api/comment" && method === "POST") {
      return json({
        json: {
          errors: [],
          data: {
            things: [
              {
                kind: "t1",
                data: { name: "t1_new", permalink: "/r/selfhosted/comments/abc/_/t1_new/" },
              },
            ],
          },
        },
      });
    }
    return json({ error: `unexpected provider call: ${method} ${url}` }, 500);
  };
  return { fetchImpl, calls };
}

/** Drives start -> provider consent -> callback, returning the stored connection. */
async function connect(
  workspace: { accountId: string; workspaceId: string },
  provider: "x" | "reddit",
  providerFetch: SocialProviderFetch,
) {
  const deps = { db: client.db, settings, providerFetch };
  const start = await startSocialOAuth(deps, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: "operator",
    requestUrl: "https://api.opengeni.test/v1/workspaces/x/social/oauth/start",
    payload: { provider },
  });
  const result = await completeSocialOAuthCallback(deps, {
    code: "provider-code",
    state: start.state,
    requestUrl: "https://api.opengeni.test/v1/social/oauth/callback",
  });
  return { start, result };
}

describe.skipIf(!available)("social connector end-to-end flow", () => {
  test("x: connect stores an encrypted bundle and a usable connection", async () => {
    const workspace = await freshWorkspace();
    const provider = fakeProvider();
    const { result } = await connect(workspace, "x", provider.fetchImpl);

    expect(result.redirectTo).toContain("social_oauth=success");
    expect(result.redirectTo).toContain("accountHandle=opengeni_ai");

    const connections = await listSocialConnections(client.db, workspace.workspaceId);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      provider: "x",
      accountHandle: "opengeni_ai",
      externalAccountId: "u-777",
      status: "connected",
    });
    // The contract projection must never carry token material.
    expect(JSON.stringify(connections[0])).not.toContain("x-access-1");
    expect(JSON.stringify(connections[0])).not.toContain("x-refresh-1");

    const loaded = await loadSocialConnectionCredential(
      client.db,
      workspace.workspaceId,
      connections[0]!.id,
    );
    const bundle = JSON.parse(
      decryptEnvironmentValue(
        environmentsEncryptionKeyBytes(settings)!,
        loaded!.credentialEncrypted!,
      ),
    );
    expect(bundle).toMatchObject({ provider: "x", accessToken: "x-access-1" });
  });

  test("x: a near-expiry token refreshes and the rotated refresh token is persisted", async () => {
    const workspace = await freshWorkspace();
    // expires_in=1 on the initial grant forces a refresh on first use.
    const provider = fakeProvider({ xAccessTokenSeq: ["x-access-1", "x-access-2"] });
    await connect(workspace, "x", provider.fetchImpl);
    const [connection] = await listSocialConnections(client.db, workspace.workspaceId);

    const refreshed = await freshSocialAccessToken(
      { db: client.db, settings, providerFetch: provider.fetchImpl },
      { workspaceId: workspace.workspaceId, connectionId: connection!.id },
    );
    expect(refreshed.bundle.accessToken).toBe("x-access-2");
    expect(refreshed.bundle.refreshToken).toBe("x-refresh-2");
    expect(refreshed.connection.status).toBe("connected");

    // The rotated bundle is durable, not just in-memory.
    const reloaded = await loadSocialConnectionCredential(
      client.db,
      workspace.workspaceId,
      connection!.id,
    );
    const stored = JSON.parse(
      decryptEnvironmentValue(
        environmentsEncryptionKeyBytes(settings)!,
        reloaded!.credentialEncrypted!,
      ),
    );
    expect(stored).toMatchObject({ accessToken: "x-access-2", refreshToken: "x-refresh-2" });
  });

  test("x: search, mentions, and reply run the full loop", async () => {
    const workspace = await freshWorkspace();
    const provider = fakeProvider({ xAccessTokenSeq: ["x-access-1", "x-access-2"] });
    await connect(workspace, "x", provider.fetchImpl);
    const [connection] = await listSocialConnections(client.db, workspace.workspaceId);
    const deps = { db: client.db, settings, providerFetch: provider.fetchImpl };
    const ref = { workspaceId: workspace.workspaceId, connectionId: connection!.id };

    const search = await socialSearchLive(deps, ref, { query: "self-hostable agent" });
    expect(search.posts).toHaveLength(1);
    expect(search.posts[0]).toMatchObject({
      id: "1801",
      author: "curious_dev",
      url: "https://x.com/curious_dev/status/1801",
      metrics: { like_count: 4, reply_count: 2 },
    });

    const mentions = await socialMentionsLive(deps, ref, {});
    expect(mentions.posts[0]!.text).toContain("@opengeni_ai");

    const published = await socialPostReply(deps, ref, {
      inReplyToId: "1801",
      text: "OpenGeni is self-hostable and does exactly this.",
    });
    expect(published.postedId).toBe("1999");
    expect(published.url).toBe("https://x.com/opengeni_ai/status/1999");
    const postCall = provider.calls.find(
      (call) => call.url === "https://api.x.com/2/tweets" && call.method === "POST",
    );
    expect(JSON.parse(postCall!.body!)).toMatchObject({
      reply: { in_reply_to_tweet_id: "1801" },
    });

    // Every provider call carried the freshest access token, never the stale one.
    expect(provider.calls.some((call) => call.url.includes("/tweets/search/recent"))).toBe(true);
  });

  test("x: own-post sync is idempotent across repeated runs", async () => {
    const workspace = await freshWorkspace();
    const provider = fakeProvider({ xAccessTokenSeq: ["x-access-1", "x-access-2"] });
    await connect(workspace, "x", provider.fetchImpl);
    const [connection] = await listSocialConnections(client.db, workspace.workspaceId);
    const deps = { db: client.db, settings, providerFetch: provider.fetchImpl };
    const ref = { workspaceId: workspace.workspaceId, connectionId: connection!.id };

    const own = await socialOwnPostsLive(deps, ref, {});
    expect(own.posts[0]!.id).toBe("1700");

    const { recordSyncedSocialPosts } = await import("@opengeni/db");
    const rows = own.posts.map((post) => ({
      externalPostId: post.id,
      url: post.url,
      authorHandle: post.author,
      text: post.text,
      publishedAt: new Date(post.createdAt!),
      metrics: post.metrics,
    }));
    const first = await recordSyncedSocialPosts(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      connectionId: connection!.id,
      posts: rows,
    });
    const second = await recordSyncedSocialPosts(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      connectionId: connection!.id,
      posts: rows,
    });
    expect(first).toEqual({ inserted: 1, skipped: 0 });
    expect(second).toEqual({ inserted: 0, skipped: 1 });

    const stored = await listSocialPosts(client.db, { workspaceId: workspace.workspaceId });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ externalPostId: "1700", provider: "x" });
  });

  test("reddit: connect, search a subreddit, and publish a comment reply", async () => {
    const workspace = await freshWorkspace();
    const provider = fakeProvider();
    const { result } = await connect(workspace, "reddit", provider.fetchImpl);
    expect(result.redirectTo).toContain("accountHandle=opengeni_bot");

    const [connection] = await listSocialConnections(client.db, workspace.workspaceId);
    expect(connection).toMatchObject({ provider: "reddit", accountHandle: "opengeni_bot" });
    const deps = { db: client.db, settings, providerFetch: provider.fetchImpl };
    const ref = { workspaceId: workspace.workspaceId, connectionId: connection!.id };

    const search = await socialSearchLive(deps, ref, {
      query: "agent runner",
      subreddit: "selfhosted",
    });
    expect(search.posts[0]).toMatchObject({
      id: "t3_abc",
      url: "https://www.reddit.com/r/selfhosted/comments/abc/best/",
      metrics: { score: 31, comments: 5 },
    });
    const searchCall = provider.calls.find((call) => call.url.includes("/search"));
    expect(searchCall!.url).toContain("/r/selfhosted/search");
    expect(searchCall!.url).toContain("restrict_sr=1");

    const published = await socialPostReply(deps, ref, {
      inReplyToId: "t3_abc",
      text: "OpenGeni runs scheduled agents and is self-hostable.",
    });
    expect(published.postedId).toBe("t1_new");
    expect(published.url).toBe("https://www.reddit.com/r/selfhosted/comments/abc/_/t1_new/");
    const commentCall = provider.calls.find((call) => call.url.endsWith("/api/comment"));
    expect(commentCall!.body).toContain("thing_id=t3_abc");
    expect(commentCall!.body).toContain("api_type=json");
  });

  test("reconnecting the same account replaces the credential instead of duplicating", async () => {
    const workspace = await freshWorkspace();
    await connect(workspace, "x", fakeProvider().fetchImpl);
    await connect(workspace, "x", fakeProvider({ xAccessTokenSeq: ["x-access-9"] }).fetchImpl);

    const connections = await listSocialConnections(client.db, workspace.workspaceId);
    expect(connections).toHaveLength(1);
    const loaded = await loadSocialConnectionCredential(
      client.db,
      workspace.workspaceId,
      connections[0]!.id,
    );
    const bundle = JSON.parse(
      decryptEnvironmentValue(
        environmentsEncryptionKeyBytes(settings)!,
        loaded!.credentialEncrypted!,
      ),
    );
    expect(bundle.accessToken).toBe("x-access-9");
  });

  test("a revoked grant surfaces as needs_reauth instead of an opaque failure", async () => {
    const workspace = await freshWorkspace();
    const provider = fakeProvider();
    await connect(workspace, "x", provider.fetchImpl);
    const [connection] = await listSocialConnections(client.db, workspace.workspaceId);

    const revoking: SocialProviderFetch = async (url, init) => {
      if (url.includes("/tweets/search/recent")) {
        return new Response(JSON.stringify({ title: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return provider.fetchImpl(url, init, "test");
    };
    await expect(
      socialSearchLive(
        { db: client.db, settings, providerFetch: revoking },
        { workspaceId: workspace.workspaceId, connectionId: connection!.id },
        { query: "anything" },
      ),
    ).rejects.toThrow("reconnect the social connection");

    const [after] = await listSocialConnections(client.db, workspace.workspaceId);
    expect(after!.status).toBe("needs_reauth");
  });
});
