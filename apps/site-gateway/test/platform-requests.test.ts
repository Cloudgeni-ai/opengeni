import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PLATFORM_FLUSH_AT_REQUESTS,
  PLATFORM_REPORT_MAX_HOSTS,
  countSiteRequest,
  flushSiteRequests,
  pendingSiteRequests,
  resetSiteRequestCounts,
} from "../src/platform-requests";
import { TEST_SECRET, verifyGatewaySignature } from "./helpers";

const config = {
  apiOrigin: "https://api.test",
  secret: TEST_SECRET,
  sitesDomain: "sites.test",
  platformReportIntervalMs: 10_000,
};

type Sent = { reportId: string; hosts: { host: string; requests: number }[]; verified: boolean };

const realFetch = globalThis.fetch;
let sent: Sent[] = [];
let answer: () => Response | Promise<Response> = () => Response.json({ counted: 1 });
/** `waitUntil` work, run by the test when it chooses (the delayed sends are left alone). */
let background: Promise<unknown>[] = [];
const ctx = { waitUntil: (promise: Promise<unknown>) => void background.push(promise) };

beforeEach(() => {
  resetSiteRequestCounts();
  sent = [];
  background = [];
  answer = () => Response.json({ counted: 1 });
  globalThis.fetch = (async (input: Request) => {
    const body = new Uint8Array(await input.arrayBuffer());
    const report = JSON.parse(new TextDecoder().decode(body)) as Omit<Sent, "verified">;
    sent.push({ ...report, verified: verifyGatewaySignature(TEST_SECRET, input, body) });
    return await answer();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetSiteRequestCounts();
});

describe("platform request counts", () => {
  test("counts per host and sends one signed report", async () => {
    countSiteRequest(config, ctx, "A.sites.test", 0);
    countSiteRequest(config, ctx, "a.sites.test", 1);
    countSiteRequest(config, ctx, "b.sites.test", 2);
    expect(pendingSiteRequests().hosts).toEqual({ "a.sites.test": 2, "b.sites.test": 1 });
    await flushSiteRequests(config);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.verified).toBe(true);
    expect(sent[0]!.hosts).toEqual([
      { host: "a.sites.test", requests: 2 },
      { host: "b.sites.test", requests: 1 },
    ]);
    expect(pendingSiteRequests().requests).toBe(0);
  });

  test("sends once the interval passes or enough requests wait", async () => {
    countSiteRequest(config, ctx, "a.sites.test", 0);
    // The first count of a window schedules a delayed send.
    expect(background).toHaveLength(1);
    countSiteRequest(config, ctx, "a.sites.test", 5_000);
    expect(background).toHaveLength(1);
    countSiteRequest(config, ctx, "a.sites.test", 10_000);
    expect(background).toHaveLength(2);
    await background[1];
    expect(sent.map((report) => report.hosts[0]!.requests)).toEqual([3]);

    background = [];
    for (let index = 0; index < PLATFORM_FLUSH_AT_REQUESTS; index += 1)
      countSiteRequest(config, ctx, "b.sites.test", 20_000);
    // One delayed send for the new window, one immediate send at the threshold.
    expect(background).toHaveLength(2);
    await background[1];
    expect(sent.at(-1)!.hosts).toEqual([
      { host: "b.sites.test", requests: PLATFORM_FLUSH_AT_REQUESTS },
    ]);
  });

  test("splits large batches and retries a failed report with the same id", async () => {
    for (let index = 0; index < PLATFORM_REPORT_MAX_HOSTS + 1; index += 1)
      countSiteRequest(config, ctx, `s${index}.sites.test`, 0);
    answer = () => new Response(null, { status: 503 });
    await flushSiteRequests(config);
    expect(sent.map((report) => report.hosts.length)).toEqual([PLATFORM_REPORT_MAX_HOSTS, 1]);
    expect(pendingSiteRequests().retries).toBe(2);

    const ids = sent.map((report) => report.reportId);
    sent = [];
    answer = () => Response.json({ counted: 1 });
    countSiteRequest(config, ctx, "new.sites.test", 1);
    await flushSiteRequests(config);
    expect(sent.slice(0, 2).map((report) => report.reportId)).toEqual(ids);
    expect(sent[2]!.hosts).toEqual([{ host: "new.sites.test", requests: 1 }]);
    expect(pendingSiteRequests().retries).toBe(0);
  });

  test("a refused report is dropped, and an unreachable API is retried", async () => {
    countSiteRequest(config, ctx, "a.sites.test", 0);
    answer = () => Response.json({ error: { code: "invalid" } }, { status: 400 });
    await flushSiteRequests(config);
    expect(pendingSiteRequests().retries).toBe(0);

    countSiteRequest(config, ctx, "a.sites.test", 0);
    answer = () => {
      throw new TypeError("network down");
    };
    await flushSiteRequests(config);
    expect(pendingSiteRequests().retries).toBe(1);
  });
});
