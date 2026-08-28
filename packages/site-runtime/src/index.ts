/** A durable OpenGeni session admitted for this exact Site release. */
export type SiteRuntimeSessionReceipt = {
  runtimeSession: { id: string };
  sessionId: string;
  eventsPath: string;
};

export type SiteRuntimeEvent = {
  type: "event";
  sessionId: string;
  event: unknown;
};

export type SiteRuntime = Readonly<{
  ai: Readonly<{
    start(input: {
      message: string;
      model?: string;
      modelContext?: string;
    }): Promise<SiteRuntimeSessionReceipt>;
    send(input: { runtimeSessionId: string; text: string }): Promise<unknown>;
    cancel(input: { sessionId: string }): Promise<unknown>;
  }>;
  onEvent(listener: (event: SiteRuntimeEvent) => void): () => void;
}>;

type SiteRuntimeBridge = Readonly<{ connect(): Promise<SiteRuntime> }>;

/**
 * Connect to the page-lifetime bridge injected by the authenticated OpenGeni
 * Site shell. The bridge transports typed requests only; it contains no API
 * key, cookie, Connection credential, Variable Set value, or generic fetch.
 */
export async function connect(): Promise<SiteRuntime> {
  const bridge = (globalThis as typeof globalThis & { OpenGeniSite?: SiteRuntimeBridge })
    .OpenGeniSite;
  if (!bridge) {
    throw new Error("OpenGeni Site Runtime is available only inside an authenticated Site shell");
  }
  return await bridge.connect();
}
