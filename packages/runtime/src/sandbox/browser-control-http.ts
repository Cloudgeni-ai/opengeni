/** One request to an agent-owned browser/computer controller, addressed by its
 * exact authority scope rather than a local port. */
export type BrowserControlHttpCall = {
  scopeId: string;
  scopeGeneration: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Absolute controller path with optional query. */
  path: string;
  bearerToken: string;
  /** JSON request body bytes, when the request has a body. */
  body?: Uint8Array;
  timeoutMs: number;
  maxResponseBytes: number;
};

/** What a placement transport did with one controller request. */
export type BrowserControlHttpOutcome =
  /** The placement cannot serve it natively; nothing was sent. */
  | { kind: "unsupported" }
  /** No controller for that scope and generation accepted it; nothing was
   * delivered, so the caller may ensure the controller and send again. */
  | { kind: "controller_absent" }
  | {
      kind: "response";
      status: number;
      /** Lowercase header names. */
      headers: Map<string, string>;
      body: Uint8Array;
    };

/** Extra time beyond the request's own deadline for the reply to arrive. */
export const BROWSER_CONTROL_HTTP_REPLY_GRACE_MS = 5_000;
