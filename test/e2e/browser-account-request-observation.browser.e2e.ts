import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { chromium, type Browser, type Page, type Request } from "playwright";
import { observeChromiumNeutralSessionSetRequestAuthority } from "./browser-account-request-observation";

const engine = process.env.OPENGENI_ACCOUNT_BROWSER_ENGINE ?? "chromium";
if (engine !== "chromium") {
  throw new Error("Chromium request-authority regression must run in the Chromium accounts lane");
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test.each(["firefox", "webkit"])(
  "the Chromium observer leaves %s routing untouched",
  async (name) => {
    let routingTouched = false;
    const page = {
      context: () => ({ browser: () => ({ browserType: () => ({ name: () => name }) }) }),
      route: async () => {
        routingTouched = true;
      },
      unroute: async () => {
        routingTouched = true;
      },
    } as unknown as Page;
    const stop = await observeChromiumNeutralSessionSetRequestAuthority(page, "http://127.0.0.1");
    await stop();
    expect(routingTouched).toBe(false);
  },
);

test("Chromium request authority survives missing response metadata and document replacement", async () => {
  const original = "a".repeat(43);
  const successor = "b".repeat(43);
  let heldResponse: ServerResponse | undefined;
  let resolveRequest!: (request: Request) => void;
  const observedRequest = new Promise<Request>((resolve) => {
    resolveRequest = resolve;
  });
  let resolveServerHash!: (value: string) => void;
  const serverHash = new Promise<string>((resolve) => {
    resolveServerHash = resolve;
  });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, "http://127.0.0.1").pathname;
    if (pathname === "/seed" || pathname === "/replace") {
      response.setHeader(
        "Set-Cookie",
        `acceptance_authority=${pathname === "/seed" ? original : successor}; HttpOnly; Path=/; SameSite=Lax`,
      );
      response.end("ready");
    } else if (pathname === "/v1/auth/session-set") {
      heldResponse = response;
      resolveServerHash(hash(request.headers.cookie ?? ""));
      // Deliberately withhold all response headers until the old document is gone.
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Request authority fixture</title>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch(
      process.env.OPENGENI_BROWSER_BIN ? { executablePath: process.env.OPENGENI_BROWSER_BIN } : {},
    );
    const context = await browser.newContext();
    const page = await context.newPage();
    const sibling = await context.newPage();
    let responseSeen = false;
    let capturedHash: Promise<string> | undefined;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/v1/auth/session-set") return;
      capturedHash = request.headerValue("cookie").then((cookie) => hash(cookie ?? ""));
      resolveRequest(request);
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/v1/auth/session-set") responseSeen = true;
    });
    const stop = await observeChromiumNeutralSessionSetRequestAuthority(page, origin);
    await page.goto(`${origin}/seed`);
    await page.goto(origin);
    await sibling.goto(origin);
    expect(await page.evaluate(() => document.cookie)).toBe("");
    await page.evaluate(() => {
      void fetch("/v1/auth/session-set", { credentials: "include" }).catch(() => undefined);
    });
    const request = await observedRequest;
    expect(request.method()).toBe("GET");
    expect(request.headers()["x-opengeni-actor-epoch"]).toBeUndefined();
    const expectedHash = hash(`acceptance_authority=${original}`);
    expect(hash(request.headers()["cookie"] ?? "")).toBe(expectedHash);
    expect(await serverHash).toBe(expectedHash);
    // Before response metadata exists, the same API used by observeBrowser must
    // already expose the exact request hash. No current-cookie fallback is valid.
    expect(await capturedHash).toBe(expectedHash);
    expect(responseSeen).toBe(false);
    await sibling.evaluate(() => fetch("/replace").then((response) => response.text()));
    expect(
      (await context.cookies(origin)).find(({ name }) => name === "acceptance_authority")?.value,
    ).toBe(successor);
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await capturedHash).toBe(expectedHash);
    expect(hash((await request.headerValue("cookie")) ?? "")).toBe(expectedHash);
    expect(responseSeen).toBe(false);
    await stop();
    await context.close();
  } finally {
    heldResponse?.end("late fixture response");
    try {
      await browser?.close();
    } finally {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    }
  }
}, 30_000);
