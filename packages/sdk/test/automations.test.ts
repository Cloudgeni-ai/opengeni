import { describe, expect, mock, test } from "bun:test";
import { OPENGENI_CORRELATION_HEADER } from "@opengeni/contracts";
import { OpenGeniClient } from "../src/client";
import { OpenGeniApiError } from "../src/errors";
import { OpenGeniAutomationsClient, type OpenGeniAutomationsTransport } from "../src/automations";

describe("automations SDK", () => {
  test("maps source, trigger, run, and manual-event methods to canonical routes", async () => {
    const requests: Request[] = [];
    const transport = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const body = request.url.endsWith("/sources")
          ? '{"sources":[]}'
          : request.url.endsWith("/triggers")
            ? '{"triggers":[]}'
            : request.url.endsWith("/runs")
              ? '{"runs":[]}'
              : '{"accepted":true,"duplicate":false,"ignoredReason":null,"eventId":null,"runIds":[]}';
        return new Response(body, { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const client = new OpenGeniAutomationsClient(transport);
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const sourceId = "22222222-2222-4222-8222-222222222222";

    await client.listSources(workspaceId);
    await client.listTriggers(workspaceId);
    await client.listRuns(workspaceId);
    await client.triggerManually(workspaceId, sourceId, {
      eventType: "build.failed",
      occurrenceKey: "repo:abc",
      payload: {},
      occurredAt: null,
      subject: null,
      resource: null,
    });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `https://api.example.test/v1/workspaces/${workspaceId}/automations/sources`],
      ["GET", `https://api.example.test/v1/workspaces/${workspaceId}/automations/triggers`],
      ["GET", `https://api.example.test/v1/workspaces/${workspaceId}/automations/runs`],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${workspaceId}/automations/sources/${sourceId}/events`,
      ],
    ]);
  });

  for (const resource of ["source", "trigger"] as const) {
    const workspaceId = "workspace /?#%";
    const resourceId = "automation /?#%";
    const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/${resource}s/${encodeURIComponent(resourceId)}${resource === "trigger" ? "?expectedRevision=17" : ""}`;
    const disable = (client: OpenGeniAutomationsClient) =>
      resource === "trigger"
        ? client.disableTrigger(workspaceId, resourceId, 17)
        : client.disableSource(workspaceId, resourceId);

    for (const contentType of [null, "application/json"]) {
      test(`disable ${resource} accepts empty 204 (${contentType ?? "no content type"}) without reading or retrying`, async () => {
        const requests: Request[] = [];
        const response = new Response(null, {
          status: 204,
          ...(contentType ? { headers: { "content-type": contentType } } : {}),
        });
        const unexpectedRead = mock(async () => {
          throw new Error("an empty void response must not be read");
        });
        response.json = unexpectedRead;
        response.text = unexpectedRead;
        response.arrayBuffer = unexpectedRead;
        const transport = new OpenGeniClient({
          baseUrl: "https://api.example.test",
          apiKey: "synthetic",
          fetch: async (input, init) => {
            requests.push(new Request(input, init));
            return response;
          },
        });

        expect(await disable(new OpenGeniAutomationsClient(transport))).toBeUndefined();
        expect(unexpectedRead).not.toHaveBeenCalled();
        expect(requests).toHaveLength(1);
        expect(requests[0]!.method).toBe("DELETE");
        expect(requests[0]!.url).toBe(`https://api.example.test${path}`);
        expect(requests[0]!.headers.get("authorization")).toBe("Bearer synthetic");
        expect(requests[0]!.headers.get("content-type")).toBeNull();
        expect(requests[0]!.body).toBeNull();
      });
    }

    test(`disable ${resource} discards a successful response body without reading it`, async () => {
      const cancel = mock(() => undefined);
      const pull = mock(() => {
        throw new Error("void response must not be streamed");
      });
      const body = new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 });
      const response = new Response(body, { headers: { "content-type": "application/json" } });
      const json = mock(async () => {
        throw new Error("void response must not be parsed");
      });
      response.json = json;
      const fetch = mock(async () => response);
      const client = new OpenGeniAutomationsClient(
        new OpenGeniClient({ baseUrl: "https://api.example.test", fetch }),
      );

      expect(await disable(client)).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(pull).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    });

    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      test(`disable ${resource} preserves ${status} API rejection without retrying`, async () => {
        const envelope = {
          error: {
            code: status === 409 ? "conflict" : "request_rejected",
            message: "The operation was rejected.",
            requestId: `automation-${status}`,
            retryable: status === 429,
            outcomeUnknown: false,
          },
        };
        const fetch = mock(async () => Response.json(envelope, { status }));
        const client = new OpenGeniAutomationsClient(
          new OpenGeniClient({ baseUrl: "https://api.example.test", fetch }),
        );

        const error: unknown = await disable(client).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(OpenGeniApiError);
        expect(error).toMatchObject({
          status,
          code: envelope.error.code,
          correlationId: envelope.error.requestId,
          retryable: envelope.error.retryable,
          outcomeUnknown: false,
          body: JSON.stringify(envelope),
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    }

    test(`disable ${resource} preserves uncertain gateway and transport diagnostics without retrying`, async () => {
      for (const failure of ["gateway", "transport"] as const) {
        let correlationId: string | null = null;
        const fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
          correlationId = new Request(input, init).headers.get(OPENGENI_CORRELATION_HEADER);
          if (failure === "transport") throw new TypeError("PRIVATE transport failure");
          return new Response("PRIVATE gateway response", {
            status: 502,
            headers: {
              "content-type": "text/html",
              [OPENGENI_CORRELATION_HEADER]: "gateway-reference",
            },
          });
        });
        const client = new OpenGeniAutomationsClient(
          new OpenGeniClient({ baseUrl: "https://api.example.test", fetch }),
        );

        const error: unknown = await disable(client).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(OpenGeniApiError);
        expect(error).toMatchObject({
          status: failure === "gateway" ? 502 : 0,
          code: failure === "gateway" ? "upstream_unavailable" : "network_error",
          retryable: true,
          outcomeUnknown: true,
          correlationId: failure === "gateway" ? "gateway-reference" : correlationId,
          body: "",
        });
        expect((error as Error).message).not.toContain("PRIVATE");
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    });

    test(`disable ${resource} retains strict API-contract rejection`, async () => {
      const fetch = mock(
        async () =>
          new Response(null, {
            status: 204,
            headers: { "x-opengeni-api-contract": "future-contract" },
          }),
      );
      const client = new OpenGeniAutomationsClient(
        new OpenGeniClient({ baseUrl: "https://api.example.test", apiContract: "strict", fetch }),
      );
      await expect(disable(client)).rejects.toThrow("API contract mismatch");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    for (const phase of ["before fetch", "during fetch"] as const) {
      test(`disable ${resource} preserves transport-supplied abort ${phase}`, async () => {
        const controller = new AbortController();
        const reason = new DOMException("caller cancelled", "AbortError");
        const fetch = mock(async () => {
          await Promise.resolve();
          controller.abort(reason);
          throw reason;
        });
        const transport = new OpenGeniClient({ baseUrl: "https://api.example.test", fetch });
        const withAbort: OpenGeniAutomationsTransport = {
          requestJson: <T>(...args: Parameters<OpenGeniClient["requestJson"]>) =>
            transport.requestJson<T>(args[0], args[1], args[2], args[3], {
              ...args[4],
              signal: controller.signal,
            }),
        };
        if (phase === "before fetch") controller.abort(reason);
        await expect(disable(new OpenGeniAutomationsClient(withAbort))).rejects.toBe(reason);
        expect(fetch).toHaveBeenCalledTimes(phase === "before fetch" ? 0 : 1);
      });
    }
  }

  test("JSON-required automation operations still reject empty 204", async () => {
    for (const operation of ["read", "mutation"] as const) {
      const fetch = mock(async () => new Response(null, { status: 204 }));
      const client = new OpenGeniAutomationsClient(
        new OpenGeniClient({ baseUrl: "https://api.example.test", fetch }),
      );
      const result =
        operation === "read"
          ? client.listSources("workspace")
          : client.updateSource("workspace", "source", { status: "disabled" });
      const error: unknown = await result.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(OpenGeniApiError);
      expect(error).toMatchObject({
        status: 502,
        code: "upstream_unavailable",
        outcomeUnknown: operation === "mutation",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});
