import { describe, expect, test } from "bun:test";
import {
  CodemodeClient,
  CodemodeConnectionError,
  CodemodeTransportError,
  createAttemptToolEnvironment,
  describeCodemodeConnectionFailure,
} from "../src";

const baseUrl = "https://api.opengeni.example/v1/workspaces/ws/codemode";

/** What Node's fetch (undici) throws: a generic TypeError with the reason in `cause`. */
function undiciFailure(code: string, message = code): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

/** What Bun's fetch throws: the reason's code on the error itself. */
function bunFailure(code: string, message = code): TypeError {
  return Object.assign(new TypeError(message), { code });
}

function failingClient(error: unknown): CodemodeClient {
  return new CodemodeClient({
    baseUrl,
    token: "bearer",
    fetch: (async () => {
      throw error;
    }) as unknown as typeof fetch,
  });
}

async function catalogError(error: unknown): Promise<unknown> {
  try {
    await failingClient(error).catalog();
  } catch (caught) {
    return caught;
  }
  throw new Error("catalog unexpectedly succeeded");
}

describe("Codemode connection failures name their cause", () => {
  for (const [runtime, failure] of [
    ["node", undiciFailure],
    ["bun", bunFailure],
  ] as const) {
    test(`${runtime}: a failed DNS lookup names the host and resolv.conf`, async () => {
      const original = failure("ENOTFOUND", "getaddrinfo ENOTFOUND api.opengeni.example");
      const error = await catalogError(original);
      expect(error).toBeInstanceOf(CodemodeConnectionError);
      expect((error as Error).message).toBe(
        "Can't reach Opengeni: DNS lookup for api.opengeni.example failed (ENOTFOUND). Check /etc/resolv.conf.",
      );
      expect((error as CodemodeConnectionError).networkCode).toBe("ENOTFOUND");
      expect((error as Error).cause).toBe(original);
      // Not an HTTP answer: submission recovery still treats it as ambiguous.
      expect(error).not.toBeInstanceOf(CodemodeTransportError);
    });

    test(`${runtime}: an early-dated certificate points at the machine clock`, async () => {
      const error = await catalogError(
        failure("CERT_NOT_YET_VALID", "certificate is not yet valid"),
      );
      expect((error as Error).message).toMatch(
        /^Can't reach Opengeni: TLS certificate not yet valid\. This machine's clock says \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC, so it is probably wrong\.$/u,
      );
    });

    test(`${runtime}: a refused connection names the host and port`, async () => {
      const error = await catalogError(failure("ECONNREFUSED"));
      expect((error as Error).message).toBe(
        "Can't reach Opengeni: the connection to api.opengeni.example was refused (ECONNREFUSED). Check this machine's network, firewall and proxy settings.",
      );
    });
  }

  test("an aggregate of refused addresses is still a refused connection", async () => {
    const aggregate = Object.assign(new AggregateError([], ""), { code: undefined });
    aggregate.errors.push(
      Object.assign(new Error("connect ECONNREFUSED ::1:9"), { code: "ECONNREFUSED" }),
    );
    const error = await catalogError(new TypeError("fetch failed", { cause: aggregate }));
    expect((error as CodemodeConnectionError).networkCode).toBe("ECONNREFUSED");
  });

  test("unknown causes and aborts keep the transport's own error", async () => {
    const unknown = new TypeError("fetch failed", { cause: new Error("something new") });
    expect(await catalogError(unknown)).toBe(unknown);
    const abort = new DOMException("The operation was aborted.", "AbortError");
    expect(await catalogError(abort)).toBe(abort);
  });

  test("every known cause has a plain sentence", () => {
    const now = new Date("2001-01-01T00:00:07.000Z");
    const cases: Array<[string, string]> = [
      [
        "EAI_AGAIN",
        "DNS lookup for api.opengeni.example failed (EAI_AGAIN). Check /etc/resolv.conf.",
      ],
      [
        "CERT_NOT_YET_VALID",
        "TLS certificate not yet valid. This machine's clock says 2001-01-01 00:00:07 UTC, so it is probably wrong.",
      ],
      [
        "CERT_HAS_EXPIRED",
        "the TLS certificate for api.opengeni.example has expired by this machine's clock (2001-01-01 00:00:07 UTC). If that time is wrong, fix the clock; otherwise the server's certificate has expired.",
      ],
      [
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "the TLS certificate of api.opengeni.example could not be verified (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). Check this machine's CA certificates and any HTTPS proxy.",
      ],
      [
        "UND_ERR_CONNECT_TIMEOUT",
        "the connection to api.opengeni.example timed out (UND_ERR_CONNECT_TIMEOUT). Check this machine's network, firewall and proxy settings.",
      ],
      [
        "ECONNRESET",
        "the connection to api.opengeni.example closed unexpectedly (ECONNRESET). If it keeps happening, check this machine's network and proxy settings.",
      ],
      [
        "UND_ERR_HEADERS_TIMEOUT",
        "api.opengeni.example did not answer in time (UND_ERR_HEADERS_TIMEOUT).",
      ],
      [
        "ENETUNREACH",
        "no network route to api.opengeni.example (ENETUNREACH). Check this machine's network settings.",
      ],
    ];
    for (const [code, sentence] of cases) {
      expect(describeCodemodeConnectionFailure(undiciFailure(code), baseUrl, now, "linux")).toEqual(
        {
          message: `Can't reach Opengeni: ${sentence}`,
          networkCode: code,
        },
      );
    }
  });

  test("off Linux a failed DNS lookup points at the machine's DNS settings", () => {
    expect(
      describeCodemodeConnectionFailure(undiciFailure("ENOTFOUND"), baseUrl, new Date(), "darwin")
        ?.message,
    ).toBe(
      "Can't reach Opengeni: DNS lookup for api.opengeni.example failed (ENOTFOUND). Check this machine's DNS settings.",
    );
  });

  test("an aborted request keeps the abort's own reason, even with a known code", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("caller gave up"), { code: "ETIMEDOUT" });
    controller.abort(reason);
    const client = new CodemodeClient({
      baseUrl,
      token: "bearer",
      fetch: (async () => {
        throw reason;
      }) as unknown as typeof fetch,
    });
    const error = await client
      .catalog({ signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error).toBe(reason);
  });

  test("a connection lost while reading the answer names its cause", async () => {
    const client = new CodemodeClient({
      baseUrl,
      token: "bearer",
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"partial":'));
              controller.error(
                new TypeError("terminated", {
                  cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
                }),
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    const error = await client.catalog().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodemodeConnectionError);
    expect((error as Error).message).toStartWith(
      "Can't reach Opengeni: the connection to api.opengeni.example closed unexpectedly (UND_ERR_SOCKET).",
    );
  });

  test("a failed recovery read after a lost submission carries the cause", async () => {
    const catalog = createAttemptToolEnvironment({
      scope: {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
      },
      generation: 1,
      definitions: [
        {
          identity: { serverId: "docs", toolName: "search" },
          modelName: "docs__search",
          inputSchema: { type: "object", properties: {} },
          source: "docs",
          approval: "none",
          execute: async () => ({ content: [] }),
        },
      ],
    }).catalog;
    let calls = 0;
    const client = new CodemodeClient({
      baseUrl,
      token: "bearer",
      fetch: (async (input: string | URL | Request) => {
        calls += 1;
        if (String(input).endsWith("/catalog")) return Response.json(catalog);
        throw undiciFailure("EAI_AGAIN", "getaddrinfo EAI_AGAIN api.opengeni.example");
      }) as unknown as typeof fetch,
    });
    const tools = await client.tools();
    const error = await (tools as unknown as { docs: { search: () => Promise<unknown> } }).docs
      .search()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodemodeTransportError);
    expect((error as Error).message).toMatch(
      new RegExp(
        `could not be reconciled after its submission response failed\\. Can't reach Opengeni: DNS lookup for api\\.opengeni\\.example failed \\(EAI_AGAIN\\)\\. ${
          process.platform === "linux"
            ? "Check /etc/resolv\\.conf\\."
            : "Check this machine's DNS settings\\."
        } The call may have run; check it with \`ogtool read [0-9a-f-]{36}\` before calling again\\.$`,
        "u",
      ),
    );
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("a failed status read after submission names the submitted call", async () => {
    const definitions = [
      {
        identity: { serverId: "docs", toolName: "search" },
        modelName: "docs__search",
        inputSchema: { type: "object", properties: {} },
        source: "docs" as const,
        approval: "none" as const,
        execute: async () => ({ content: [] }),
      },
    ];
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
      },
      generation: 1,
      definitions,
    });
    let submittedOperation: unknown = null;
    const client = new CodemodeClient({
      baseUrl,
      token: "bearer",
      pollIntervalMs: 1,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/catalog")) return Response.json(environment.catalog);
        if (url.endsWith("/calls") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { operationId: string };
          submittedOperation = body.operationId;
          const now = "2026-08-09T12:00:00.000Z";
          return Response.json({
            operation: {
              version: 1,
              operationId: body.operationId,
              accountId: environment.catalog.accountId,
              workspaceId: environment.catalog.workspaceId,
              sessionId: environment.catalog.sessionId,
              turnId: environment.catalog.turnId,
              attemptId: environment.catalog.attemptId,
              executionGeneration: environment.catalog.executionGeneration,
              catalogDigest: environment.catalog.digest,
              requestDigest: "a".repeat(64),
              identity: definitions[0]!.identity,
              arguments: {},
              caller: { kind: "codemode", subjectId: "agent:test" },
              state: "running",
              result: null,
              errorCode: null,
              errorMessage: null,
              createdAt: now,
              claimedAt: now,
              executionStartedAt: now,
              completedAt: null,
              updatedAt: now,
            },
            dispatch: "accepted",
          });
        }
        throw undiciFailure("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const tools = await client.tools();
    const error = await (tools as unknown as { docs: { search: () => Promise<unknown> } }).docs
      .search()
      .catch((caught: unknown) => caught);
    expect(submittedOperation).not.toBeNull();
    expect(error).toBeInstanceOf(CodemodeConnectionError);
    expect((error as Error).message).toBe(
      `Can't reach Opengeni: the connection to api.opengeni.example was refused (ECONNREFUSED). Check this machine's network, firewall and proxy settings. The call may have run; check it with \`ogtool read ${String(submittedOperation)}\` before calling again.`,
    );
  });
});
