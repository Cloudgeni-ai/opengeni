import { describe, expect, test } from "bun:test";
import {
  federatedAccessToken,
  publishToStore,
  type FetchLike,
  type ItemStatus,
  type PublishOptions,
} from "../scripts/publish-store";

type Call = { method: string; url: string; body?: unknown; authorization?: string };

function fakeStore(
  statuses: ItemStatus[],
  upload: Record<string, unknown> = { uploadState: "SUCCEEDED", crxVersion: "1.2.3" },
) {
  const calls: Call[] = [];
  const queue = [...statuses];
  const fetch: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body,
      authorization: headers.authorization,
    });
    if (url.endsWith(":fetchStatus")) {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return Response.json(next);
    }
    if (url.endsWith(":upload")) return Response.json(upload);
    if (url.endsWith(":publish")) return Response.json({ state: "PENDING_REVIEW" });
    if (url.endsWith(":cancelSubmission")) return Response.json({});
    return new Response("not found", { status: 404 });
  };
  return { calls, fetch };
}

function options(fetch: FetchLike, overrides: Partial<PublishOptions> = {}): PublishOptions {
  return {
    publisherId: "pub",
    itemId: "item",
    version: "1.2.3",
    zip: new Uint8Array([1, 2, 3]),
    accessToken: "token",
    publishType: "DEFAULT_PUBLISH",
    cancelPending: false,
    fetch,
    log: () => {},
    sleep: async () => {},
    ...overrides,
  };
}

const published = (version: string): ItemStatus => ({
  publishedItemRevisionStatus: {
    state: "PUBLISHED",
    distributionChannels: [{ crxVersion: version }],
  },
});
const pending = (version: string, live = "1.2.2"): ItemStatus => ({
  ...published(live),
  submittedItemRevisionStatus: {
    state: "PENDING_REVIEW",
    distributionChannels: [{ crxVersion: version }],
  },
});

describe("publishToStore", () => {
  test("uploads, submits and confirms the new version", async () => {
    const store = fakeStore([published("1.2.2"), pending("1.2.3")]);
    const outcome = await publishToStore(options(store.fetch, { publishType: "STAGED_PUBLISH" }));
    expect(outcome.kind).toBe("submitted");
    expect(store.calls.map((call) => `${call.method} ${call.url.split("/items/")[1]}`)).toEqual([
      "GET item:fetchStatus",
      "POST item:upload",
      "POST item:publish",
      "GET item:fetchStatus",
    ]);
    expect(store.calls[1]!.url).toBe(
      "https://chromewebstore.googleapis.com/upload/v2/publishers/pub/items/item:upload",
    );
    expect(JSON.parse(String(store.calls[2]!.body))).toEqual({ publishType: "STAGED_PUBLISH" });
    expect(store.calls.every((call) => call.authorization === "Bearer token")).toBe(true);
  });

  test("is idempotent when the version is already submitted or published", async () => {
    const submitted = fakeStore([pending("1.2.3")]);
    expect((await publishToStore(options(submitted.fetch))).kind).toBe("already_submitted");
    expect(submitted.calls).toHaveLength(1);
    const live = fakeStore([published("1.2.3")]);
    expect((await publishToStore(options(live.fetch))).kind).toBe("already_published");
    expect(live.calls).toHaveLength(1);
  });

  test("refuses to replace another pending version unless asked", async () => {
    const store = fakeStore([pending("1.2.1"), pending("1.2.3")]);
    await expect(publishToStore(options(store.fetch))).rejects.toThrow(
      /1\.2\.1 is already PENDING_REVIEW/,
    );
    expect(store.calls).toHaveLength(1);
    const replacing = fakeStore([pending("1.2.1"), pending("1.2.3")]);
    expect((await publishToStore(options(replacing.fetch, { cancelPending: true }))).kind).toBe(
      "submitted",
    );
    expect(replacing.calls[1]!.url.endsWith(":cancelSubmission")).toBe(true);
  });

  test("waits for an asynchronous upload and rejects a failed one", async () => {
    const store = fakeStore(
      [
        published("1.2.2"),
        { lastAsyncUploadState: "IN_PROGRESS" },
        { lastAsyncUploadState: "SUCCEEDED" },
        pending("1.2.3"),
      ],
      { uploadState: "IN_PROGRESS" },
    );
    expect((await publishToStore(options(store.fetch))).kind).toBe("submitted");
    const failing = fakeStore([published("1.2.2"), { lastAsyncUploadState: "FAILED" }], {
      uploadState: "IN_PROGRESS",
    });
    await expect(publishToStore(options(failing.fetch))).rejects.toThrow(/state FAILED/);
    expect(failing.calls.some((call) => call.url.endsWith(":publish"))).toBe(false);
  });

  test("rejects a ZIP whose manifest version differs", async () => {
    const store = fakeStore([published("1.2.2")], {
      uploadState: "SUCCEEDED",
      crxVersion: "9.9.9",
    });
    await expect(publishToStore(options(store.fetch))).rejects.toThrow(/parsed version 9\.9\.9/);
    expect(store.calls.some((call) => call.url.endsWith(":publish"))).toBe(false);
  });
});

describe("federatedAccessToken", () => {
  test("exchanges the GitHub OIDC token for a Web Store scoped service account token", async () => {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body,
        authorization: headers.authorization,
      });
      if (url.startsWith("https://github.example/")) return Response.json({ value: "oidc" });
      if (url === "https://sts.googleapis.com/v1/token")
        return Response.json({ access_token: "federated" });
      return Response.json({ accessToken: "cws" });
    };
    const token = await federatedAccessToken({
      fetch,
      idTokenRequestUrl: "https://github.example/token?api-version=2.0",
      idTokenRequestToken: "request",
      workloadIdentityProvider: "projects/1/locations/global/workloadIdentityPools/p/providers/g",
      serviceAccount: "publisher@example.iam.gserviceaccount.com",
    });
    expect(token).toBe("cws");
    const audience =
      "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/g";
    expect(new URL(calls[0]!.url).searchParams.get("audience")).toBe(audience);
    expect(calls[0]!.authorization).toBe("Bearer request");
    expect(JSON.parse(String(calls[1]!.body))).toMatchObject({ audience, subjectToken: "oidc" });
    expect(calls[2]!.url).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/publisher%40example.iam.gserviceaccount.com:generateAccessToken",
    );
    expect(calls[2]!.authorization).toBe("Bearer federated");
    expect(JSON.parse(String(calls[2]!.body)).scope).toEqual([
      "https://www.googleapis.com/auth/chromewebstore",
    ]);
  });
});
