import { afterEach, describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import {
  parseDeprecationNotice,
  withDeprecationNotices,
  type OpenGeniDeprecationNotice,
} from "../src/deprecation";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "../src/types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const DEPRECATION_HEADERS = {
  Deprecation: "@1790812800",
  Sunset: "Tue, 01 Jun 2027 00:00:00 GMT",
  Link: '<https://docs.opengeni.ai/changelog/packs>; rel="deprecation"; type="text/html", <https://docs.opengeni.ai/plugins>; rel="successor-version"',
};

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      ...headers,
    },
  });
}

const originalWarn = console.warn;
afterEach(() => {
  console.warn = originalWarn;
});

describe("parseDeprecationNotice", () => {
  test("reads RFC 9745 Deprecation, RFC 8594 Sunset, and deprecation/successor links", () => {
    const notice = parseDeprecationNotice(
      "get",
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/packs?x=1`,
      new Headers(DEPRECATION_HEADERS),
    );
    expect(notice).toEqual({
      method: "GET",
      route: "/v1/workspaces/:id/packs",
      path: `/v1/workspaces/${WORKSPACE_ID}/packs`,
      deprecatedAt: new Date(1790812800 * 1000),
      sunset: new Date("2027-06-01T00:00:00Z"),
      link: "https://docs.opengeni.ai/changelog/packs",
      successor: "https://docs.opengeni.ai/plugins",
    });
  });

  test("returns null without deprecation headers and tolerates a bare Sunset", () => {
    expect(parseDeprecationNotice("GET", "/v1/workspaces", new Headers())).toBeNull();
    const notice = parseDeprecationNotice(
      "DELETE",
      "/v1/workspaces/x",
      new Headers({ Sunset: "Tue, 01 Jun 2027 00:00:00 GMT" }),
    );
    expect(notice?.deprecatedAt).toBeNull();
    expect(notice?.sunset?.toISOString()).toBe("2027-06-01T00:00:00.000Z");
    expect(notice?.link).toBeNull();
  });
});

describe("OpenGeniClient deprecation notices", () => {
  test("onDeprecation fires once per route per client and never affects the response", async () => {
    const notices: OpenGeniDeprecationNotice[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "key",
      fetch: async () => jsonResponse({ id: WORKSPACE_ID, name: "Workspace" }, DEPRECATION_HEADERS),
      onDeprecation: (notice) => notices.push(notice),
    });
    await client.getWorkspace(WORKSPACE_ID);
    await client.getWorkspace(WORKSPACE_ID);
    await client.getWorkspace(OTHER_WORKSPACE_ID);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      method: "GET",
      route: "/v1/workspaces/:id",
      link: "https://docs.opengeni.ai/changelog/packs",
    });
  });

  test("defaults to one console warning per route and can be silenced", async () => {
    const warnings: string[] = [];
    console.warn = (message: unknown) => warnings.push(String(message));
    const fetch = async () =>
      jsonResponse({ id: WORKSPACE_ID, name: "Workspace" }, DEPRECATION_HEADERS);
    const noisy = new OpenGeniClient({ baseUrl: "https://api.example.test", fetch });
    await noisy.deleteWorkspace(WORKSPACE_ID).catch(() => undefined);
    await noisy.deleteWorkspace(OTHER_WORKSPACE_ID).catch(() => undefined);
    // A second client in the same process does not repeat the warning.
    await new OpenGeniClient({ baseUrl: "https://api.example.test", fetch })
      .deleteWorkspace(WORKSPACE_ID)
      .catch(() => undefined);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DELETE /v1/workspaces/:id is deprecated");
    expect(warnings[0]).toContain("2027-06-01T00:00:00.000Z");
    expect(warnings[0]).toContain("https://docs.opengeni.ai/changelog/packs");

    const silent = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch,
      onDeprecation: false,
    });
    await silent.getWorkspace(WORKSPACE_ID);
    expect(warnings).toHaveLength(1);
  });

  test("a throwing handler cannot fail the request", async () => {
    const wrapped = withDeprecationNotices(
      async () => jsonResponse({ ok: true }, DEPRECATION_HEADERS),
      () => {
        throw new Error("handler bug");
      },
    );
    const response = await wrapped("https://api.example.test/v1/workspaces", { method: "GET" });
    expect(await response.json()).toEqual({ ok: true });
  });

  test("responses without deprecation headers produce no notice", async () => {
    const notices: OpenGeniDeprecationNotice[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () => jsonResponse({ id: WORKSPACE_ID, name: "Workspace" }),
      onDeprecation: (notice) => notices.push(notice),
    });
    await client.getWorkspace(WORKSPACE_ID);
    expect(notices).toEqual([]);
  });
});
