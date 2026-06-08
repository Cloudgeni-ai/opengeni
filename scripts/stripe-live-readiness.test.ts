import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./stripe-live-readiness.ts", import.meta.url).pathname;

describe("Stripe live readiness preflight", () => {
  it("passes when live account, top-up prices, and webhook endpoint match OpenGeni requirements", async () => {
    const server = fakeStripeServer();
    try {
      const result = await runPreflight(server.url);
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(true);
      expect(payload.account.id).toBe("acct_live_ready");
      expect(payload.results.every((entry: { status: string }) => entry.status === "passed")).toBe(true);
    } finally {
      server.stop();
    }
  });

  it("fails closed without live-mode keys", async () => {
    const server = fakeStripeServer();
    try {
      const result = await runPreflight(server.url, {
        secretKey: "sk_test_wrong",
        publishableKey: "pk_test_wrong",
      });
      expect(result.status).not.toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(false);
      expect(payload.results.find((entry: { id: string }) => entry.id === "live-secret-key").status).toBe("failed");
      expect(payload.results.find((entry: { id: string }) => entry.id === "live-publishable-key").status).toBe("failed");
    } finally {
      server.stop();
    }
  });

  it("fails when a required webhook event is missing", async () => {
    const server = fakeStripeServer({ enabledEvents: ["checkout.session.completed"] });
    try {
      const result = await runPreflight(server.url);
      expect(result.status).not.toBe(0);
      const payload = JSON.parse(result.stdout);
      const webhook = payload.results.find((entry: { id: string }) => entry.id === "webhook-endpoint");
      expect(webhook.status).toBe("failed");
      expect(webhook.detail).toContain("payment_intent.succeeded");
    } finally {
      server.stop();
    }
  });
});

async function runPreflight(apiBaseUrl: string, overrides: { secretKey?: string; publishableKey?: string } = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([
    "bun",
    scriptPath,
    "--api-base-url",
    apiBaseUrl,
    "--secret-key",
    overrides.secretKey ?? "sk_live_test",
    "--publishable-key",
    overrides.publishableKey ?? "pk_live_test",
    "--webhook-url",
    "https://app.opengeni.ai/v1/webhooks/stripe",
    "--price-25",
    "price_live_25",
    "--price-100",
    "price_live_100",
    "--price-500",
    "price_live_500",
    "--price-1000",
    "price_live_1000",
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

function fakeStripeServer(options: { enabledEvents?: string[] } = {}): { url: string; stop: () => void } {
  const enabledEvents = options.enabledEvents ?? ["*"];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/account") {
        return json({
          id: "acct_live_ready",
          object: "account",
          country: "US",
          default_currency: "usd",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        });
      }
      if (url.pathname.startsWith("/v1/prices/")) {
        const priceId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const cents = {
          price_live_25: 2_500,
          price_live_100: 10_000,
          price_live_500: 50_000,
          price_live_1000: 100_000,
        }[priceId];
        if (!cents) {
          return json({ error: { message: "No such price" } }, 404);
        }
        return json({
          id: priceId,
          object: "price",
          active: true,
          currency: "usd",
          type: "one_time",
          unit_amount: cents,
          product: {
            id: `prod_${priceId}`,
            object: "product",
            active: true,
            name: `OpenGeni ${priceId}`,
            metadata: {},
          },
          metadata: {},
        });
      }
      if (url.pathname === "/v1/webhook_endpoints") {
        return json({
          object: "list",
          has_more: false,
          data: [{
            id: "we_live_ready",
            object: "webhook_endpoint",
            url: "https://app.opengeni.ai/v1/webhooks/stripe",
            status: "enabled",
            livemode: true,
            enabled_events: enabledEvents,
          }],
        });
      }
      return json({ error: { message: "not found" } }, 404);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
