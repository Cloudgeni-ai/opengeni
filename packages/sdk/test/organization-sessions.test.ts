import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import type { OrganizationSessionListResponse, Session } from "../src/types";

type RecordedRequest = { method: string; url: string; body: string | null };

function makeClient(responder: (request: RecordedRequest) => Response): {
  client: OpenGeniClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : null,
    };
    requests.push(request);
    return responder(request);
  };
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_test_key",
    fetch: fetch as never,
  });
  return { client, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeSession(id: string, workspaceId: string): Session {
  return { id, workspaceId, status: "idle" } as unknown as Session;
}

describe("OpenGeniClient organization sessions", () => {
  test("createOrganizationApiKey forwards the access tier and keeps the old shape", async () => {
    const { client, requests } = makeClient(() =>
      jsonResponse(
        { apiKey: { id: "key-1", name: "reader", access: "read" }, token: "ogk_secret" },
        201,
      ),
    );
    const created = await client.createOrganizationApiKey("org-1", {
      name: "reader",
      access: "read",
    });
    expect(created.apiKey.access).toBe("read");
    expect(JSON.parse(requests[0]!.body!)).toEqual({ name: "reader", access: "read" });
    await client.createOrganizationApiKey("org-1", { name: "admin" });
    expect(JSON.parse(requests[1]!.body!)).toEqual({ name: "admin" });
  });

  test("listOrganizationSessions encodes limit, cursor, end user, and status", async () => {
    const page: OrganizationSessionListResponse = {
      sessions: [fakeSession("s-1", "ws-a")],
      nextCursor: "next",
    };
    const { client, requests } = makeClient(() => jsonResponse(page));
    const result = await client.listOrganizationSessions("org-1", {
      limit: 25,
      cursor: "cur",
      endUser: { source: "acme", id: "u 42" },
      status: "idle",
    });
    expect(result).toEqual(page);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/v1/organizations/org-1/sessions");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "25",
      cursor: "cur",
      endUserSource: "acme",
      endUserId: "u 42",
      status: "idle",
    });

    await client.listOrganizationSessions("org-1");
    expect(new URL(requests[1]!.url).search).toBe("");
  });

  test("iterateOrganizationSessions follows nextCursor through short pages", async () => {
    const pages: OrganizationSessionListResponse[] = [
      { sessions: [fakeSession("s-1", "ws-a"), fakeSession("s-2", "ws-a")], nextCursor: "c1" },
      // A short page with a cursor still set must not end the iteration.
      { sessions: [], nextCursor: "c2" },
      { sessions: [fakeSession("s-3", "ws-b")], nextCursor: null },
    ];
    const { client, requests } = makeClient((request) => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      const index = cursor === null ? 0 : cursor === "c1" ? 1 : 2;
      return jsonResponse(pages[index]);
    });
    const seen: string[] = [];
    for await (const session of client.iterateOrganizationSessions("org-1", { limit: 2 })) {
      seen.push(session.id);
    }
    expect(seen).toEqual(["s-1", "s-2", "s-3"]);
    expect(requests.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual([
      null,
      "c1",
      "c2",
    ]);
    expect(
      requests.every((request) => new URL(request.url).searchParams.get("limit") === "2"),
    ).toBe(true);
  });
});
