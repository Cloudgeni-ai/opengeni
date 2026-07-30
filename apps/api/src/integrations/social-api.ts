import type { Settings } from "@opengeni/config";
import type { SocialConnection } from "@opengeni/contracts";
import type { Observability } from "@opengeni/observability";
import type { Database } from "@opengeni/db";
import { OAUTH_MAX_RESPONSE_BYTES, pinnedFetch, readResponseJsonBounded } from "@opengeni/network";
import {
  freshSocialAccessToken,
  markNeedsReauth,
  SOCIAL_TIMEOUT_MS,
  SOCIAL_USER_AGENT,
  type SocialCredentialBundle,
} from "./social-oauth";

// One normalized shape across providers so agent prompts do not need
// provider-specific parsing: X tweets and Reddit links/comments both flatten
// into this.
export type SocialLivePost = {
  id: string;
  provider: "x" | "reddit";
  url: string | null;
  author: string | null;
  text: string;
  createdAt: string | null;
  metrics: Record<string, number>;
  // X: conversation_id; Reddit: subreddit + kind. Kept small and provider-tagged.
  context: Record<string, string>;
};

type SocialApiDeps = {
  db: Database;
  settings: Settings;
  observability?: Observability | undefined;
};

type ConnectionRef = { workspaceId: string; connectionId: string };

const MAX_LIVE_RESULTS = 50;

export async function socialSearchLive(
  deps: SocialApiDeps,
  ref: ConnectionRef,
  input: { query: string; limit?: number | undefined; subreddit?: string | undefined },
): Promise<{ connection: SocialConnection; posts: SocialLivePost[] }> {
  const { connection, bundle } = await freshSocialAccessToken(deps, ref);
  const limit = boundedLiveLimit(input.limit);
  if (bundle.provider === "x") {
    // X recent search requires max_results in [10, 100].
    const url = new URL("https://api.x.com/2/tweets/search/recent");
    url.searchParams.set("query", input.query);
    url.searchParams.set("max_results", String(Math.max(10, limit)));
    url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id,conversation_id");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username");
    const payload = await socialApiGet(deps, ref, bundle, url);
    return { connection, posts: mapXTweets(payload).slice(0, limit) };
  }
  const base = input.subreddit
    ? `https://oauth.reddit.com/r/${encodeURIComponent(input.subreddit)}/search`
    : "https://oauth.reddit.com/search";
  const url = new URL(base);
  url.searchParams.set("q", input.query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "new");
  url.searchParams.set("raw_json", "1");
  if (input.subreddit) {
    url.searchParams.set("restrict_sr", "1");
  }
  const payload = await socialApiGet(deps, ref, bundle, url);
  return { connection, posts: mapRedditListing(payload).slice(0, limit) };
}

export async function socialMentionsLive(
  deps: SocialApiDeps,
  ref: ConnectionRef,
  input: { limit?: number | undefined; sinceId?: string | undefined },
): Promise<{ connection: SocialConnection; posts: SocialLivePost[] }> {
  const { connection, bundle } = await freshSocialAccessToken(deps, ref);
  const limit = boundedLiveLimit(input.limit);
  if (bundle.provider === "x") {
    if (!connection.externalAccountId) {
      throw new Error(
        "x connection has no stored account id; reconnect it via the social OAuth flow",
      );
    }
    const url = new URL(
      `https://api.x.com/2/users/${encodeURIComponent(connection.externalAccountId)}/mentions`,
    );
    url.searchParams.set("max_results", String(Math.max(5, limit)));
    url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id,conversation_id");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username");
    if (input.sinceId) {
      url.searchParams.set("since_id", input.sinceId);
    }
    const payload = await socialApiGet(deps, ref, bundle, url);
    return { connection, posts: mapXTweets(payload).slice(0, limit) };
  }
  // Reddit surfaces username mentions and comment replies in the inbox.
  const url = new URL("https://oauth.reddit.com/message/inbox");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("raw_json", "1");
  if (input.sinceId) {
    // Reddit listings page with fullname anchors; `before` returns only items
    // newer than the anchor, matching X's since_id semantics.
    url.searchParams.set("before", input.sinceId);
  }
  const payload = await socialApiGet(deps, ref, bundle, url);
  return { connection, posts: mapRedditListing(payload).slice(0, limit) };
}

export async function socialThreadLive(
  deps: SocialApiDeps,
  ref: ConnectionRef,
  input: { id: string; limit?: number | undefined },
): Promise<{ connection: SocialConnection; posts: SocialLivePost[] }> {
  const { connection, bundle } = await freshSocialAccessToken(deps, ref);
  const limit = boundedLiveLimit(input.limit);
  if (bundle.provider === "x") {
    const url = new URL("https://api.x.com/2/tweets/search/recent");
    url.searchParams.set("query", `conversation_id:${input.id}`);
    url.searchParams.set("max_results", String(Math.max(10, limit)));
    url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id,conversation_id");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username");
    const payload = await socialApiGet(deps, ref, bundle, url);
    return { connection, posts: mapXTweets(payload).slice(0, limit) };
  }
  const article = input.id.replace(/^t3_/, "");
  const url = new URL(`https://oauth.reddit.com/comments/${encodeURIComponent(article)}`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("depth", "2");
  url.searchParams.set("raw_json", "1");
  const payload = await socialApiGet(deps, ref, bundle, url);
  return { connection, posts: mapRedditThread(payload).slice(0, limit + 1) };
}

export async function socialOwnPostsLive(
  deps: SocialApiDeps,
  ref: ConnectionRef,
  input: { limit?: number | undefined },
): Promise<{ connection: SocialConnection; posts: SocialLivePost[] }> {
  const { connection, bundle } = await freshSocialAccessToken(deps, ref);
  const limit = boundedLiveLimit(input.limit);
  if (bundle.provider === "x") {
    if (!connection.externalAccountId) {
      throw new Error(
        "x connection has no stored account id; reconnect it via the social OAuth flow",
      );
    }
    const url = new URL(
      `https://api.x.com/2/users/${encodeURIComponent(connection.externalAccountId)}/tweets`,
    );
    url.searchParams.set("max_results", String(Math.max(5, limit)));
    url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id,conversation_id");
    const payload = await socialApiGet(deps, ref, bundle, url);
    return { connection, posts: mapXTweets(payload, connection.accountHandle).slice(0, limit) };
  }
  const url = new URL(
    `https://oauth.reddit.com/user/${encodeURIComponent(connection.accountHandle)}/submitted`,
  );
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("raw_json", "1");
  const payload = await socialApiGet(deps, ref, bundle, url);
  return { connection, posts: mapRedditListing(payload).slice(0, limit) };
}

export async function socialPostReply(
  deps: SocialApiDeps,
  ref: ConnectionRef,
  input: { inReplyToId: string; text: string },
): Promise<{ connection: SocialConnection; postedId: string | null; url: string | null }> {
  const { connection, bundle } = await freshSocialAccessToken(deps, ref);
  if (bundle.provider === "x") {
    const payload = await socialApiSend(
      deps,
      ref,
      bundle,
      new URL("https://api.x.com/2/tweets"),
      {
        "content-type": "application/json",
      },
      JSON.stringify({
        text: input.text,
        reply: { in_reply_to_tweet_id: input.inReplyToId },
      }),
    );
    const data = payload.data as Record<string, unknown> | undefined;
    const id = typeof data?.id === "string" ? data.id : null;
    return {
      connection,
      postedId: id,
      url: id ? `https://x.com/${connection.accountHandle}/status/${id}` : null,
    };
  }
  const thingId = redditThingId(input.inReplyToId);
  const body = new URLSearchParams({
    api_type: "json",
    thing_id: thingId,
    text: input.text,
  });
  const payload = await socialApiSend(
    deps,
    ref,
    bundle,
    new URL("https://oauth.reddit.com/api/comment"),
    { "content-type": "application/x-www-form-urlencoded" },
    body,
  );
  const posted = redditCommentFromApiJson(payload);
  return { connection, postedId: posted.id, url: posted.url };
}

/**
 * Reddit write endpoints address targets by fullname (t3_xxx post, t1_xxx
 * comment). Bare ids are ambiguous, so require the caller to be explicit.
 */
export function redditThingId(id: string): string {
  if (/^t[1-6]_[a-z0-9]+$/i.test(id)) {
    return id;
  }
  throw new Error(
    `Reddit reply targets must be fullnames like t3_<postid> or t1_<commentid>; got: ${id}`,
  );
}

async function socialApiGet(
  deps: SocialApiDeps,
  ref: ConnectionRef,
  bundle: SocialCredentialBundle,
  url: URL,
): Promise<Record<string, unknown>> {
  return await socialApiRequest(deps, ref, bundle, url, {
    headers: socialApiHeaders(bundle),
  });
}

async function socialApiSend(
  deps: SocialApiDeps,
  ref: ConnectionRef,
  bundle: SocialCredentialBundle,
  url: URL,
  headers: Record<string, string>,
  body: BodyInit,
): Promise<Record<string, unknown>> {
  return await socialApiRequest(deps, ref, bundle, url, {
    method: "POST",
    headers: { ...socialApiHeaders(bundle), ...headers },
    body,
  });
}

function socialApiHeaders(bundle: SocialCredentialBundle): Record<string, string> {
  return {
    authorization: `Bearer ${bundle.accessToken}`,
    accept: "application/json",
    "user-agent": SOCIAL_USER_AGENT,
  };
}

async function socialApiRequest(
  deps: SocialApiDeps,
  ref: ConnectionRef,
  bundle: SocialCredentialBundle,
  url: URL,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await pinnedFetch(
    url.toString(),
    { ...init, signal: AbortSignal.timeout(SOCIAL_TIMEOUT_MS) },
    deps.settings,
    {
      label: `social ${bundle.provider} API`,
      requireHttpsOutsideLocalTest: true,
    },
  );
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    // A 401 after freshSocialAccessToken means the access token the provider
    // just vouched for is no longer honored — the grant itself is gone.
    await markNeedsReauth(deps, ref);
    deps.observability?.warn("social connection marked needs_reauth after provider 401", {
      "opengeni.social.provider": bundle.provider,
      "opengeni.social.connection_id": ref.connectionId,
    });
    throw new Error(
      `${bundle.provider} API rejected the stored credential (HTTP 401); reconnect the social connection`,
    );
  }
  // 403 is NOT a credential failure: X uses it for duplicate content and
  // access-tier limits, Reddit for banned/private subreddits. The grant is
  // healthy — report the rejection without poisoning connection status.
  if (response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `${bundle.provider} API refused this request (HTTP 403) — likely a permissions, content, or access-tier rule for ${url.pathname}; the connection itself is still valid`,
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    await response.body?.cancel().catch(() => undefined);
    deps.observability?.warn("social API rate limited", {
      "opengeni.social.provider": bundle.provider,
      "opengeni.social.connection_id": ref.connectionId,
      "opengeni.social.retry_after": retryAfter ?? undefined,
    });
    throw new Error(
      `${bundle.provider} API rate limit hit${retryAfter ? `; retry after ${retryAfter}s` : ""}. Reduce frequency or limit.`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${bundle.provider} API returned HTTP ${response.status} for ${url.pathname}`);
  }
  return await readResponseJsonBounded<Record<string, unknown>>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    "social API response",
  );
}

function boundedLiveLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 25;
  }
  const floored = Math.floor(limit);
  if (floored <= 0) {
    return 25;
  }
  return Math.min(floored, MAX_LIVE_RESULTS);
}

// --- Pure response mappers (exported for unit tests) ---

export function mapXTweets(
  payload: Record<string, unknown>,
  fallbackAuthor?: string,
): SocialLivePost[] {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const includes = payload.includes as Record<string, unknown> | undefined;
  const users = Array.isArray(includes?.users) ? includes.users : [];
  const usernamesById = new Map<string, string>();
  for (const user of users) {
    const entry = user as Record<string, unknown>;
    if (typeof entry.id === "string" && typeof entry.username === "string") {
      usernamesById.set(entry.id, entry.username);
    }
  }
  const posts: SocialLivePost[] = [];
  for (const item of data) {
    const tweet = item as Record<string, unknown>;
    if (typeof tweet.id !== "string" || typeof tweet.text !== "string") {
      continue;
    }
    const authorId = typeof tweet.author_id === "string" ? tweet.author_id : null;
    const author = (authorId ? usernamesById.get(authorId) : undefined) ?? fallbackAuthor ?? null;
    const publicMetrics = tweet.public_metrics as Record<string, unknown> | undefined;
    const metrics: Record<string, number> = {};
    for (const [name, value] of Object.entries(publicMetrics ?? {})) {
      if (typeof value === "number") {
        metrics[name] = value;
      }
    }
    posts.push({
      id: tweet.id,
      provider: "x",
      url: author ? `https://x.com/${author}/status/${tweet.id}` : null,
      author,
      text: tweet.text,
      createdAt: typeof tweet.created_at === "string" ? tweet.created_at : null,
      metrics,
      context: {
        ...(typeof tweet.conversation_id === "string"
          ? { conversationId: tweet.conversation_id }
          : {}),
      },
    });
  }
  return posts;
}

export function mapRedditListing(payload: Record<string, unknown>): SocialLivePost[] {
  const data = payload.data as Record<string, unknown> | undefined;
  const children = Array.isArray(data?.children) ? data.children : [];
  const posts: SocialLivePost[] = [];
  for (const child of children) {
    const post = mapRedditChild(child as Record<string, unknown>);
    if (post) {
      posts.push(post);
    }
  }
  return posts;
}

/**
 * /comments/{article} returns [post listing, comment listing]; flatten the
 * submission first, then its comment tree in order.
 */
export function mapRedditThread(payload: Record<string, unknown>): SocialLivePost[] {
  if (!Array.isArray(payload)) {
    return mapRedditListing(payload);
  }
  const posts: SocialLivePost[] = [];
  for (const listing of payload) {
    posts.push(...mapRedditListing(listing as Record<string, unknown>));
  }
  return posts;
}

function mapRedditChild(child: Record<string, unknown>): SocialLivePost | null {
  const kind = typeof child.kind === "string" ? child.kind : "";
  const data = child.data as Record<string, unknown> | undefined;
  if (!data || typeof data.name !== "string") {
    return null;
  }
  const title = typeof data.title === "string" ? data.title : "";
  const selftext = typeof data.selftext === "string" ? data.selftext : "";
  const commentBody = typeof data.body === "string" ? data.body : "";
  const text = kind === "t3" ? [title, selftext].filter(Boolean).join("\n\n") : commentBody;
  if (!text) {
    return null;
  }
  const permalink = typeof data.permalink === "string" ? data.permalink : null;
  const context = typeof data.context === "string" && data.context ? data.context : null;
  const createdUtc = typeof data.created_utc === "number" ? data.created_utc : null;
  const metrics: Record<string, number> = {};
  if (typeof data.score === "number") {
    metrics.score = data.score;
  }
  if (typeof data.num_comments === "number") {
    metrics.comments = data.num_comments;
  }
  return {
    id: data.name,
    provider: "reddit",
    url: permalink
      ? `https://www.reddit.com${permalink}`
      : context
        ? `https://www.reddit.com${context}`
        : null,
    author: typeof data.author === "string" ? data.author : null,
    text,
    createdAt: createdUtc ? new Date(createdUtc * 1000).toISOString() : null,
    metrics,
    context: {
      kind,
      ...(typeof data.subreddit === "string" ? { subreddit: data.subreddit } : {}),
      ...(typeof data.type === "string" ? { inboxType: data.type } : {}),
    },
  };
}

export function redditCommentFromApiJson(payload: Record<string, unknown>): {
  id: string | null;
  url: string | null;
} {
  const json = payload.json as Record<string, unknown> | undefined;
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  if (errors.length > 0) {
    throw new Error(`reddit comment failed: ${JSON.stringify(errors[0])}`);
  }
  const jsonData = json?.data as Record<string, unknown> | undefined;
  const things = Array.isArray(jsonData?.things) ? jsonData.things : [];
  const first = things[0] as Record<string, unknown> | undefined;
  const data = first?.data as Record<string, unknown> | undefined;
  const id = typeof data?.name === "string" ? data.name : null;
  const permalink = typeof data?.permalink === "string" ? data.permalink : null;
  return { id, url: permalink ? `https://www.reddit.com${permalink}` : null };
}
