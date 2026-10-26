import { describe, expect, test } from "bun:test";

import {
  formatErrorMessage,
  isMaintenanceError,
  isTransientRequestError,
  OPENGENI_MAINTENANCE_ERROR_CODE,
  OpenGeniApiError,
  OpenGeniClient,
  type FetchLike,
} from "../src";
import {
  isMaintenanceError as browserIsMaintenanceError,
  OPENGENI_MAINTENANCE_ERROR_CODE as browserMaintenanceCode,
} from "../src/browser";
import {
  isMaintenanceError as coreIsMaintenanceError,
  OPENGENI_MAINTENANCE_ERROR_CODE as coreMaintenanceCode,
} from "../src/core";

// Exactly what the parked maintenance responder answers for every API path.
const PARKED_BODY = JSON.stringify({ error: "maintenance" });

function parked(init: ResponseInit = {}): Response {
  return new Response(PARKED_BODY, {
    status: 503,
    ...init,
    headers: {
      "content-type": "application/json",
      "x-request-id": "ingress-request-1",
      ...(init.headers ?? {}),
    },
  });
}

function client(fetch: FetchLike, readRetry: false | { maxAttempts: number } = false) {
  return new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "key",
    fetch,
    onDeprecation: false,
    readRetry: readRetry === false ? false : { ...readRetry, initialDelayMs: 1, maxDelayMs: 2 },
  });
}

describe("maintenance marker", () => {
  test("is one stable code from every SDK entry point", () => {
    expect(OPENGENI_MAINTENANCE_ERROR_CODE).toBe("maintenance");
    expect(browserMaintenanceCode).toBe(OPENGENI_MAINTENANCE_ERROR_CODE);
    expect(coreMaintenanceCode).toBe(OPENGENI_MAINTENANCE_ERROR_CODE);
    expect(browserIsMaintenanceError).toBe(isMaintenanceError);
    expect(coreIsMaintenanceError).toBe(isMaintenanceError);
  });

  test("a parked read decodes to a typed, retryable, transient error", () => {
    const error = new OpenGeniApiError(503, PARKED_BODY, {
      correlationId: "ingress-request-1",
      mutation: false,
    });
    expect(error.code).toBe("maintenance");
    expect(error.retryable).toBe(true);
    expect(error.outcomeUnknown).toBe(false);
    expect(error.body).toBe(PARKED_BODY);
    expect(isMaintenanceError(error)).toBe(true);
    expect(isTransientRequestError(error)).toBe(true);
  });

  test("a parked mutation was definitively not accepted", () => {
    // A bare 503 on a mutation is outcome-unknown; the marker proves the API
    // never ran the request.
    const bare = new OpenGeniApiError(503, "", { mutation: true });
    expect(bare.code).toBe("upstream_unavailable");
    expect(bare.outcomeUnknown).toBe(true);

    const error = new OpenGeniApiError(503, PARKED_BODY, {
      correlationId: "ingress-request-1",
      mutation: true,
    });
    expect(error.code).toBe("maintenance");
    expect(error.outcomeUnknown).toBe(false);
    expect(error.retryable).toBe(true);
    // The parked responder is not the request handler: no reference.
    expect(error.message).toBe("The service is updating. Try again in a moment.");
    expect(error.correlationId).toBe("ingress-request-1");
  });

  test("the friendly message names the update and no reference", () => {
    const error = new OpenGeniApiError(503, PARKED_BODY, {
      correlationId: "ingress-request-1",
      mutation: false,
    });
    expect(formatErrorMessage(error)).toBe("The service is updating. Try again in a moment.");
    // An ordinary 503 keeps its existing copy and reference.
    expect(
      formatErrorMessage(
        new OpenGeniApiError(503, "", { correlationId: "request-2", mutation: false }),
      ),
    ).toBe("The service is temporarily unavailable. Try again later. Reference: request-2.");
  });

  test("only the exact marker is maintenance", () => {
    for (const body of [
      JSON.stringify({ error: "unavailable" }),
      JSON.stringify({ error: { code: "upstream_unavailable", message: "deploying" } }),
      JSON.stringify({ maintenance: true }),
      "maintenance",
      "",
    ]) {
      const error = new OpenGeniApiError(503, body, { mutation: false });
      expect(error.code).not.toBe("maintenance");
      expect(isMaintenanceError(error)).toBe(false);
    }
    expect(isMaintenanceError(new Error("maintenance"))).toBe(false);
    expect(isMaintenanceError({ status: 503, code: "maintenance" })).toBe(true);
    expect(isMaintenanceError(null)).toBe(false);
  });

  test("the client surfaces a parked read and mutation as maintenance", async () => {
    const fetch: FetchLike = async () => parked();
    const read = await client(fetch)
      .getSession("workspace-1", "session-1")
      .catch((cause: unknown) => cause);
    expect(read).toBeInstanceOf(OpenGeniApiError);
    expect(read).toMatchObject({ status: 503, code: "maintenance", outcomeUnknown: false });

    const sent = await client(fetch)
      .sendMessage("workspace-1", "session-1", { text: "hello", clientEventId: "event-1" })
      .catch((cause: unknown) => cause);
    expect(sent).toBeInstanceOf(OpenGeniApiError);
    expect(sent).toMatchObject({ status: 503, code: "maintenance", outcomeUnknown: false });
    expect(isMaintenanceError(sent)).toBe(true);
  });

  test("safe reads retry a short park and recover", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      if (calls < 3) return parked();
      return new Response(JSON.stringify({ id: "session-1", workspaceId: "workspace-1" }), {
        headers: { "content-type": "application/json" },
      });
    };
    const session = await client(fetch, { maxAttempts: 4 }).getSession("workspace-1", "session-1");
    expect(session).toMatchObject({ id: "session-1" });
    expect(calls).toBe(3);
  });
});
