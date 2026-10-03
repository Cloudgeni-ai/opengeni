import { expect, test } from "bun:test";
import { createObservability } from "../src";

test("the default exporter releases a successful streaming response after its headers", async () => {
  let accepted = 0;
  let cancelled = 0;
  let reportCancellation: () => void = () => {};
  const bodyCancelled = new Promise<void>((resolve) => {
    reportCancellation = resolve;
  });
  const originalFetch = globalThis.fetch;
  let receivedResponse: Response | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.arrayBuffer();
      accepted += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("generated response"));
          },
          cancel() {
            cancelled += 1;
            reportCancellation();
          },
        }),
      );
    },
  });
  const obs = createObservability(
    {
      serviceName: "test",
      environment: "test",
      deploymentRevision: "test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: false,
      observabilityOtlpEndpoint: `http://127.0.0.1:${server.port}`,
      observabilityOtlpHeaders: "",
    },
    { component: "test" },
  );
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    if (response.url.startsWith(`http://127.0.0.1:${server.port}/`)) receivedResponse = response;
    return response;
  }) as typeof fetch;
  try {
    obs.startSpan("generated span").end();
    await obs.flush();
    expect(accepted).toBe(1);
    // Fetch completes at headers; the server body has no EOF. Disposing the
    // ignored response must release it before the transport deadline does.
    expect(receivedResponse?.bodyUsed).toBe(true);
    await bodyCancelled;
    expect(cancelled).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    await receivedResponse?.body?.cancel().catch(() => {});
    server.stop(true);
  }
});
