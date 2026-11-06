import { afterEach, describe, expect, test } from "bun:test";

import {
  adoptXaiClientVersionFloor,
  classifyXaiSubscriptionClientOutdatedError,
  compareXaiClientVersions,
  currentXaiClientVersion,
  fetchXaiSubscriptionQuota,
  isXaiSubscriptionTransportError,
  parseXaiClientVersionRejection,
  resetXaiClientVersionFloorForTests,
  XAI_CLIENT_VERSION,
  type XaiModelRequestEvent,
  type XaiProviderRequestSettlement,
  XaiSubscriptionClientOutdatedError,
  XaiSubscriptionReloginRequired,
  xaiSubscriptionFetch,
  xaiSubscriptionRequestStorage,
} from "../src";

// The provider's refusal, as observed when it raised its minimum.
const REFUSAL = "Grok CLI version (1.0.3) is outdated, update to 1.0.13";

afterEach(() => resetXaiClientVersionFloorForTests());

function context(overrides: Record<string, unknown> = {}) {
  return {
    clientVersion: "1.0.3",
    sessionId: "session-1",
    turnId: "turn-1",
    getToken: async () => ({ accessToken: "access", userId: "user-1" }),
    refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
    resolveModel: (slug: string) => slug,
    ...overrides,
  };
}

function completed(): Response {
  const payload = JSON.stringify({
    type: "response.completed",
    response: { output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] },
  });
  return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function send(wrapped: ReturnType<typeof xaiSubscriptionFetch>, ctx = context()) {
  return await xaiSubscriptionRequestStorage.run(
    ctx,
    async () =>
      await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "supergrok/grok-4.7", input: "hello" }),
      }),
  );
}

describe("Grok client version", () => {
  test("the pinned version is at least the provider's observed minimum", () => {
    expect(compareXaiClientVersions(XAI_CLIENT_VERSION, "1.0.13")).toBeGreaterThanOrEqual(0);
    expect(currentXaiClientVersion()).toBe(XAI_CLIENT_VERSION);
  });

  test("orders versions numerically, not lexically", () => {
    expect(compareXaiClientVersions("1.0.13", "1.0.3")).toBe(1);
    expect(compareXaiClientVersions("1.0.3", "1.0.13")).toBe(-1);
    expect(compareXaiClientVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareXaiClientVersions("1.0.13", "1.0.13")).toBe(0);
  });

  test("reads the refusal from plain text and JSON bodies", () => {
    expect(parseXaiClientVersionRejection(REFUSAL)).toEqual({ sent: "1.0.3", required: "1.0.13" });
    expect(parseXaiClientVersionRejection(JSON.stringify({ error: REFUSAL }))).toEqual({
      sent: "1.0.3",
      required: "1.0.13",
    });
    expect(
      parseXaiClientVersionRejection(
        JSON.stringify({
          error: { message: "Grok CLI version (v1.0.3) is outdated. Please update to v2.1.0." },
        }),
      ),
    ).toEqual({ sent: "1.0.3", required: "2.1.0" });
    expect(parseXaiClientVersionRejection("Invalid or expired credentials")).toBeNull();
    expect(parseXaiClientVersionRejection("")).toBeNull();
  });

  test("adopts only a higher minimum, monotonically", () => {
    expect(adoptXaiClientVersionFloor(REFUSAL, "1.0.3")).not.toBeNull();
    expect(currentXaiClientVersion("1.0.3")).toBe("1.0.13");
    // A minimum we already present is not adoptable (no retry loop).
    expect(adoptXaiClientVersionFloor(REFUSAL, "1.0.13")).toBeNull();
    // A lower minimum never lowers the floor; a higher pin wins over it.
    adoptXaiClientVersionFloor("Grok CLI version (1.0.1) is outdated, update to 1.0.5", "1.0.1");
    expect(currentXaiClientVersion("1.0.3")).toBe("1.0.13");
    expect(currentXaiClientVersion("9.0.0")).toBe("9.0.0");
  });
});

describe("SuperGrok responses transport", () => {
  test("adopts the required version from a refusal and retries the request once", async () => {
    const versions: string[] = [];
    const agents: string[] = [];
    const events: XaiModelRequestEvent[] = [];
    const settlements: XaiProviderRequestSettlement[] = [];
    const wrapped = xaiSubscriptionFetch(async (_input, init) => {
      const headers = new Headers(init?.headers);
      versions.push(headers.get("x-grok-client-version") ?? "");
      agents.push(headers.get("user-agent") ?? "");
      if (versions.length === 1) return Response.json({ error: REFUSAL }, { status: 426 });
      return completed();
    });
    const response = await send(
      wrapped,
      context({
        onModelRequestEvent: (event: XaiModelRequestEvent) => void events.push(event),
        onProviderRequestSettled: (settlement: XaiProviderRequestSettlement) =>
          void settlements.push(settlement),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
    expect(versions).toEqual(["1.0.3", "1.0.13"]);
    expect(agents).toEqual(["opengeni/1.0.3", "opengeni/1.0.13"]);
    expect(events.find((event) => event.phase === "failed")).toMatchObject({
      transportAttempt: 1,
      status: 426,
      willRetry: true,
    });
    // The refused attempt settles as a definite refusal before the retry.
    expect(settlements.map((settlement) => settlement.outcome)).toEqual([
      "refused",
      "response_received",
    ]);
    // Later requests in this process present the adopted version at once.
    versions.length = 0;
    await (await send(wrapped)).text();
    expect(versions).toEqual(["1.0.13"]);
  });

  test("returns a repeated refusal as a marked error with a clear classification", async () => {
    let calls = 0;
    const wrapped = xaiSubscriptionFetch(async (_input, init) => {
      calls += 1;
      const sent = new Headers(init?.headers).get("x-grok-client-version");
      return Response.json(
        { error: `Grok CLI version (${sent}) is outdated, update to 1.0.13` },
        { status: 403 },
      );
    });
    const response = await send(wrapped, context({ clientVersion: "1.0.13" }));
    expect(calls).toBe(1);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    const apiError = Object.assign(new Error(`403 ${body.error}`), {
      status: 403,
      error: body,
      headers: response.headers,
    });
    expect(isXaiSubscriptionTransportError(apiError)).toBe(true);
    const outdated = classifyXaiSubscriptionClientOutdatedError(apiError);
    expect(outdated).toBeInstanceOf(XaiSubscriptionClientOutdatedError);
    expect(outdated?.message).toContain("requires 1.0.13 or newer");
    expect(outdated?.code).toBe("xai_client_outdated");
  });

  test("passes other error bodies through unchanged and does not retry them", async () => {
    let calls = 0;
    const wrapped = xaiSubscriptionFetch(async () => {
      calls += 1;
      return Response.json({ error: "bad request" }, { status: 400 });
    });
    const response = await send(wrapped);
    expect(calls).toBe(1);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad request" });
  });
});

describe("SuperGrok proxy JSON requests", () => {
  test("adopt the required version and retry once", async () => {
    const versions: string[] = [];
    const result = await fetchXaiSubscriptionQuota({
      context: context(),
      fetch: async (_input, init) => {
        versions.push(new Headers(init?.headers).get("x-grok-client-version") ?? "");
        return versions.length === 1
          ? new Response(REFUSAL, { status: 400 })
          : Response.json({ config: { creditUsagePercent: 10 } });
      },
    });
    expect(result.usedPercent).toBe(10);
    expect(versions).toEqual(["1.0.3", "1.0.13"]);
  });

  test("report a persistent outdated refusal as such, not as a relogin", async () => {
    const error = await fetchXaiSubscriptionQuota({
      context: context({ clientVersion: "1.0.13" }),
      fetch: async () => new Response(REFUSAL.replace("1.0.3", "1.0.13"), { status: 403 }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(XaiSubscriptionClientOutdatedError);
    expect(error).not.toBeInstanceOf(XaiSubscriptionReloginRequired);
  });
});
