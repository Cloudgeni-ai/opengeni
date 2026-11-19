import { describe, expect, test } from "bun:test";
import {
  SITE_CLIENT_TIMING_METRIC,
  recordSiteTimingReport,
  siteOpLabel,
  siteRuntimeOpLabel,
  statusClass,
} from "../src/site-live/metrics";
import {
  createSiteLiveTicket,
  sendSiteLiveNotice,
  siteLiveConsoleUrl,
  verifySiteLiveTicket,
} from "../src/site-live/service";

const SITE = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SECRET = "test-gateway-secret-0123456789abcdefghij";

describe("Site runtime op labels", () => {
  test("every request maps into a closed set", () => {
    expect(siteRuntimeOpLabel("GET", "/host")).toBe("host");
    expect(siteRuntimeOpLabel("POST", "/tools/call")).toBe("tools.call");
    expect(siteRuntimeOpLabel("POST", "/tools/unknown")).toBe("other");
    expect(siteRuntimeOpLabel("POST", "/live/admit")).toBe("live.admit");
    expect(siteRuntimeOpLabel("POST", "/platform/timings")).toBe("platform.timings");
    expect(siteRuntimeOpLabel("GET", "/versions/abc/html")).toBe("version.html");
    expect(siteRuntimeOpLabel("DELETE", "/nothing/here")).toBe("other");
    expect(siteOpLabel("https://example.test")).toBe("other");
    expect(statusClass(204)).toBe("2xx");
    expect(statusClass(429)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
  });

  test("timing reports become bounded histogram samples", () => {
    const seen: { labels?: Record<string, string>; value: number; name: string }[] = [];
    const recorded = recordSiteTimingReport((metric) => seen.push(metric), {
      v: 1,
      series: [
        { kind: "bridge", op: "data.read", outcome: "ok", samples: [0.1, 0.2] },
        { kind: "bridge", op: "made-up", outcome: "error", samples: [1] },
        { kind: "gateway", op: "made-up", outcome: "ok", samples: [0.01] },
        { kind: "app_load", op: "anything", outcome: "ok", samples: [0.5] },
      ],
    });
    expect(recorded).toBe(5);
    expect(seen.every((metric) => metric.name === SITE_CLIENT_TIMING_METRIC.name)).toBe(true);
    expect(seen.map((metric) => metric.labels)).toEqual([
      { kind: "bridge", op: "data.read", outcome: "ok" },
      { kind: "bridge", op: "data.read", outcome: "ok" },
      { kind: "bridge", op: "other", outcome: "error" },
      { kind: "gateway", op: "other", outcome: "ok" },
      { kind: "app_load", op: "page", outcome: "ok" },
    ]);
  });
});

describe("console live tickets", () => {
  test("round-trip with the gateway secret and expire", () => {
    const ticket = createSiteLiveTicket(SECRET, {
      siteId: SITE,
      collections: ["todos"],
      seq: 3,
      expiresAt: 2_000,
      ttlSeconds: 900,
    });
    expect(verifySiteLiveTicket([SECRET], ticket, 1_000)).toEqual({
      siteId: SITE,
      collections: ["todos"],
      seq: 3,
      expiresAt: 2_000,
      ttlSeconds: 900,
    });
    expect(verifySiteLiveTicket([SECRET], ticket, 2_001)).toBeNull();
    expect(verifySiteLiveTicket(["another-secret"], ticket, 1_000)).toBeNull();
  });

  test("the console connects to the frame host of an HTTPS Sites domain", () => {
    expect(siteLiveConsoleUrl({ sitesDomain: "opengeni.site" })).toBe(
      "wss://og.opengeni.site/_og/live",
    );
    expect(siteLiveConsoleUrl({ sitesDomain: null } as never)).toBeNull();
  });
});

describe("live notices", () => {
  const settings = {
    sitesGatewayInternalOrigin: "https://gateway.test",
    sitesGatewaySecret: SECRET,
    sitesSqlTimeoutMs: 5_000,
    sitesDomain: "opengeni.site",
  };

  test("are signed requests to the Site's internal live route", async () => {
    const sent: { url: string; body: unknown; headers: Headers }[] = [];
    const ok = await sendSiteLiveNotice(
      settings,
      SITE,
      { type: "data", seq: 5, collections: ["todos"] },
      async (url, init) => {
        sent.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
        return new Response("{}", { status: 200 });
      },
    );
    expect(ok).toBe(true);
    expect(sent[0]!.url).toBe(`https://gateway.test/_og/internal/site-live/${SITE}`);
    expect(sent[0]!.body).toEqual({ type: "data", seq: 5, collections: ["todos"] });
    expect([...sent[0]!.headers.keys()].some((name) => name.includes("signature"))).toBe(true);
  });

  test("never throw: a failing gateway or a missing configuration is just false", async () => {
    expect(
      await sendSiteLiveNotice(settings, SITE, { type: "version", versionId: null }, async () => {
        throw new Error("down");
      }),
    ).toBe(false);
    expect(
      await sendSiteLiveNotice({ ...settings, sitesGatewayInternalOrigin: null } as never, SITE, {
        type: "version",
        versionId: null,
      }),
    ).toBe(false);
  });
});
