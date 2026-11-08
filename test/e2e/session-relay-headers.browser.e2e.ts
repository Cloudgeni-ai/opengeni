import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import {
  OPENGENI_BROWSER_REQUEST_HEADERS,
  OPENGENI_BROWSER_RESPONSE_HEADERS,
} from "../../packages/sdk/src/types";

let browser: Browser;
let api: ReturnType<typeof Bun.serve>;
let web: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("../../packages/sdk/src/browser.ts", import.meta.url).pathname],
    target: "browser",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Browser SDK build failed");
  const javascript = await bundle.outputs[0]!.text();
  api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const headers = new Headers({
        "Access-Control-Allow-Origin": web.url.origin,
        "Access-Control-Allow-Headers": OPENGENI_BROWSER_REQUEST_HEADERS.join(", "),
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (!new URL(request.url).pathname.startsWith("/hidden/")) {
        headers.set("Access-Control-Expose-Headers", OPENGENI_BROWSER_RESPONSE_HEADERS.join(", "));
      }
      for (const [name, value] of Object.entries({
        "X-OpenGeni-Has-More": "true",
        "X-OpenGeni-Next-Before": "42",
        "X-OpenGeni-Covered-First": "42",
        "X-OpenGeni-Covered-Last": "42",
        "X-OpenGeni-Page-Bytes": "200",
        "X-OpenGeni-Page-Max-Bytes": "1048576",
        "X-OpenGeni-Page-Truncated": "true",
        "X-OpenGeni-Event-Mode": "forensic",
        "X-OpenGeni-Event-Direction": "before",
        "X-OpenGeni-Payload-Mode": "full",
        "X-OpenGeni-Forensic-Exact": "false",
        "X-OpenGeni-Conversation-Filter": "2",
      }))
        headers.set(name, value);
      return Response.json([{ sequence: 42, type: "user.message", payload: { text: "Hello" } }], {
        headers,
      });
    },
  });
  web = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/sdk.js")
        return new Response(javascript, { headers: { "Content-Type": "text/javascript" } });
      return new Response(
        `<!doctype html><html><body><script type="module">
      import { OpenGeniBrowserClient } from '/sdk.js';
      window.runCase = async (mode) => {
        const client = new OpenGeniBrowserClient({ baseUrl: ${JSON.stringify(api.url.origin)} + '/' + mode });
        const options = { before: 100, presentedToolCalls: 'include' };
        const page = await client.listEventPage('workspace', 'session', options);
        await client.listEventPage('workspace', 'session', options);
        return page;
      };
    </script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined),
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  api?.stop(true);
  web?.stop(true);
});

test("real browser CORS filtering warns once; the exported exposure list restores paging", async () => {
  const page = await browser.newPage();
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  try {
    await page.goto(web.url.origin, { waitUntil: "networkidle" });
    const hidden = await page.evaluate(() => (window as any).runCase("hidden"));
    expect(hidden.hasMore).toBe(false);
    expect(hidden.conversationFilter).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Access-Control-Expose-Headers");
    const exposed = await page.evaluate(() => (window as any).runCase("exposed"));
    expect(exposed).toMatchObject({
      hasMore: true,
      nextBefore: 42,
      coveredSequence: { first: 42, last: 42 },
      conversationFilter: 2,
      bytes: 200,
    });
    expect(warnings).toHaveLength(1);
  } finally {
    await page.close();
  }
}, 30_000);
