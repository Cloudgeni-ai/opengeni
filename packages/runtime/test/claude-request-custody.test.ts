import { expect, test } from "bun:test";
import {
  withClaudeUsageObserver,
  type PreparedUsageRequest,
} from "../src/claude-subscription-usage";
import { instrumentedModelFetch } from "../src/model-provider-client";

// Request custody for a leased subscription bearer (design 5.3, Claude
// track C1a): admission is the last step before each physical fetch, each
// request settles once, and a 401 renews the bearer and retries at most once.

const URL_MESSAGES = "https://api.anthropic.com/v1/messages";

function custodyPrepare(
  log: string[],
  options: { renewable?: boolean; declineRenewal?: boolean } = {},
) {
  const prepared = (attempt: number, headers: Headers): PreparedUsageRequest => {
    const bearer = new Headers(headers);
    bearer.set("authorization", `Bearer token-${attempt}`);
    return {
      headers: bearer,
      observe: (_provider, response) => log.push(`observe:${attempt}:${response.status}`),
      custody: {
        admit: async () => {
          log.push(`admit:${attempt}`);
        },
        responded: async (response) => {
          log.push(`responded:${attempt}:${response.status}`);
          return response;
        },
        failed: async () => {
          log.push(`failed:${attempt}`);
        },
        ...(attempt === 1 && options.renewable !== false
          ? {
              renew: async () => {
                log.push(`renew:${attempt}`);
                return options.declineRenewal ? null : prepared(2, headers);
              },
            }
          : {}),
      },
    };
  };
  return async (_provider: string, headers: Headers) => prepared(1, headers);
}

test("admission precedes the fetch and the response settles the request", async () => {
  const log: string[] = [];
  const fetcher = instrumentedModelFetch("organization-claude-subscription", (async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    log.push(`fetch:${new Headers(init?.headers).get("authorization")}`);
    return new Response("ok", { status: 200 });
  }) as typeof fetch);
  const response = await withClaudeUsageObserver(
    () => undefined,
    () => fetcher(URL_MESSAGES, { method: "POST", body: "{}" }),
    custodyPrepare(log),
  );
  expect(await response.text()).toBe("ok");
  expect(log).toEqual(["admit:1", "fetch:Bearer token-1", "observe:1:200", "responded:1:200"]);
});

test("a failed fetch after admission settles the request as failed", async () => {
  const log: string[] = [];
  const fetcher = instrumentedModelFetch("organization-claude-subscription", (async () => {
    log.push("fetch");
    throw new Error("socket closed");
  }) as typeof fetch);
  await expect(
    withClaudeUsageObserver(
      () => undefined,
      () => fetcher(URL_MESSAGES, { method: "POST", body: "{}" }),
      custodyPrepare(log),
    ),
  ).rejects.toThrow("socket closed");
  expect(log).toEqual(["admit:1", "fetch", "failed:1"]);
});

test("a refused admission sends nothing", async () => {
  let fetched = 0;
  const fetcher = instrumentedModelFetch("organization-claude-subscription", (async () => {
    fetched += 1;
    return new Response("ok");
  }) as typeof fetch);
  await expect(
    withClaudeUsageObserver(
      () => undefined,
      () => fetcher(URL_MESSAGES, { method: "POST", body: "{}" }),
      async (_provider, headers) => ({
        headers,
        observe: () => undefined,
        custody: {
          admit: async () => {
            throw new Error("lease lost");
          },
          responded: async (response) => response,
          failed: async () => undefined,
        },
      }),
    ),
  ).rejects.toThrow("lease lost");
  expect(fetched).toBe(0);
});

test("a response the custody cannot settle is cancelled, not left open", async () => {
  let cancelled = false;
  const fetcher = instrumentedModelFetch(
    "organization-claude-subscription",
    (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch,
  );
  await expect(
    withClaudeUsageObserver(
      () => undefined,
      () => fetcher(URL_MESSAGES, { method: "POST", body: "{}" }),
      async (_provider, headers) => ({
        headers,
        observe: () => undefined,
        custody: {
          admit: async () => undefined,
          responded: async () => {
            throw new Error("settlement failed");
          },
          failed: async () => undefined,
        },
      }),
    ),
  ).rejects.toThrow("settlement failed");
  expect(cancelled).toBe(true);
});

test("a 401 renews the bearer once and retries the same body as its own request", async () => {
  const log: string[] = [];
  const bodies: string[] = [];
  const fetcher = instrumentedModelFetch("organization-claude-subscription", (async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const authorization = new Headers(init?.headers).get("authorization");
    log.push(`fetch:${authorization}`);
    bodies.push(String(init?.body));
    return new Response("{}", { status: 401 });
  }) as typeof fetch);
  const response = await withClaudeUsageObserver(
    () => undefined,
    () => fetcher(URL_MESSAGES, { method: "POST", body: '{"model":"m"}' }),
    custodyPrepare(log),
  );
  // The renewed request was refused too: it surfaces, with no third try.
  expect(response.status).toBe(401);
  expect(log).toEqual([
    "admit:1",
    "fetch:Bearer token-1",
    "observe:1:401",
    "responded:1:401",
    "renew:1",
    "admit:2",
    "fetch:Bearer token-2",
    "observe:2:401",
    "responded:2:401",
  ]);
  expect(bodies).toEqual(['{"model":"m"}', '{"model":"m"}']);
});

test("a declined renewal, no renewal, or a body that cannot be sent again surfaces the 401", async () => {
  for (const [options, body] of [
    [{ declineRenewal: true }, "{}"],
    [{ renewable: false }, "{}"],
    [{}, new ReadableStream({ start: (controller) => controller.close() })],
  ] as const) {
    const log: string[] = [];
    let fetched = 0;
    const fetcher = instrumentedModelFetch("organization-claude-subscription", (async () => {
      fetched += 1;
      return new Response("refused", { status: 401 });
    }) as typeof fetch);
    const response = await withClaudeUsageObserver(
      () => undefined,
      () =>
        fetcher(URL_MESSAGES, {
          method: "POST",
          body,
          ...(typeof body === "string" ? {} : { duplex: "half" }),
        } as RequestInit),
      custodyPrepare(log, options),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("refused");
    expect(fetched).toBe(1);
  }
});

test("a request without custody is unchanged", async () => {
  const fetcher = instrumentedModelFetch(
    "organization-claude-subscription",
    (async () => new Response("{}", { status: 401 })) as typeof fetch,
  );
  const response = await withClaudeUsageObserver(
    () => undefined,
    () => fetcher(URL_MESSAGES, { method: "POST", body: "{}" }),
  );
  expect(response.status).toBe(401);
});
