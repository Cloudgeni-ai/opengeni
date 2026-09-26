import type { BrowserCdpConnection } from "./cdp-driver";

const METADATA_TIMEOUT_MS = 5_000;

export async function navigateBrowserMetadataDocument(
  connection: BrowserCdpConnection,
  sessionId: string,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  const loaded = connection.waitForEvent("Page.loadEventFired", {
    sessionId,
    timeoutMs: METADATA_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  // A load timeout may race the navigation response. Observe rejection at once,
  // while still propagating the original failure through the awaited promise.
  void loaded.catch(() => undefined);
  const navigation = await connection.send<{ errorText?: unknown }>(
    "Page.navigate",
    { url },
    { sessionId, timeoutMs: METADATA_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  if (typeof navigation.errorText === "string" && navigation.errorText) {
    throw new Error(`browser metadata navigation failed: ${navigation.errorText}`);
  }
  await loaded;
}

/** The caller owns a private hidden target and closes it on every outcome. */
export async function navigateToInterceptedMetadataDocument(
  connection: BrowserCdpConnection,
  sessionId: string,
): Promise<void> {
  // Localhost exposes real Client Hints. Every request on this private target
  // pauses before network dispatch; no server, external URL or fabricated UA.
  const url = "http://localhost/__opengeni_browser_metadata__";
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error("browser metadata deadline exceeded")),
    METADATA_TIMEOUT_MS,
  );
  const options = { sessionId, timeoutMs: METADATA_TIMEOUT_MS, signal: abort.signal };
  let navigation: Promise<void> | undefined;
  try {
    await connection.send("Network.setBypassServiceWorker", { bypass: true }, options);
    await connection.send(
      "Fetch.enable",
      {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      },
      options,
    );
    const paused = connection.waitForEvent("Fetch.requestPaused", options);
    void paused.catch(() => undefined);
    navigation = navigateBrowserMetadataDocument(connection, sessionId, url, abort.signal);
    void navigation.catch(() => abort.abort());
    const event = await paused;
    const requestId = event.params.requestId;
    if (typeof requestId !== "string") throw new Error("browser metadata request has no identity");
    const request = event.params.request;
    if (!request || typeof request !== "object" || !("url" in request) || request.url !== url) {
      await connection.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }, options);
      throw new Error("browser metadata target requested an unexpected URL");
    }
    await connection.send(
      "Fetch.fulfillRequest",
      {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: Buffer.from("<!doctype html><title>Browser metadata</title>").toString("base64"),
      },
      options,
    );
    await navigation;
  } finally {
    clearTimeout(timer);
    abort.abort();
    // Cancel pending Page.navigate immediately. Never disable Fetch or continue
    // the request: the caller closes the target with its interception intact.
    await navigation?.catch(() => undefined);
  }
}
