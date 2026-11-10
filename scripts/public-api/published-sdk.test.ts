import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishedSdkCalls,
  publishedSdkFindings,
  refreshPublishedPackage,
  resolveCall,
  validatePublishedInventory,
  type PublishedInventory,
} from "./published-sdk";

const registered = [
  { method: "GET", path: "/v1/workspaces/:workspaceId/sessions" },
  { method: "POST", path: "/v1/workspaces/:workspaceId/sessions" },
  { method: "GET", path: "/v1/workspaces/:workspaceId/sessions/:sessionId" },
  { method: "GET", path: "/v1/workspaces/:workspaceId/company-brain/files" },
  {
    method: "DELETE",
    path: "/v1/workspaces/external/:workspaceSource/:workspaceExternalId/allowance",
  },
];

const SESSIONS = "GET /v1/workspaces/:workspaceId/sessions";
const SESSION = "GET /v1/workspaces/:workspaceId/sessions/:sessionId";

function inventory(acceptedGaps: { call: string; reason: string }[] = []): PublishedInventory {
  const gaps = new Set(acceptedGaps.map((gap) => gap.call));
  return {
    schemaVersion: 2,
    packages: [
      {
        name: "@opengeni/sdk",
        version: "4.6.1",
        calls: {
          "GET /v1/workspaces/:p/sessions": {
            sdk: ["Client.listSessions"],
            routes: gaps.has("GET /v1/workspaces/:p/sessions") ? [] : [SESSIONS],
          },
          "GET /v1/workspaces/:p/sessions/:p": { sdk: ["Client.getSession"], routes: [SESSION] },
          "DELETE /v1/workspaces/:p/recordings/:p": {
            sdk: ["Client.discardRecording"],
            routes: [],
          },
        },
        acceptedGaps,
      },
    ],
  };
}

const RECORDING_GAP = {
  call: "DELETE /v1/workspaces/:p/recordings/:p",
  reason: "Removed before the policy.",
};

describe("published SDK inventory", () => {
  test("extracts route calls from shipped SDK source, excluding @internal methods", () => {
    const directory = mkdtempSync(join(tmpdir(), "published-sdk-test-"));
    mkdirSync(join(directory, "src"));
    writeFileSync(
      join(directory, "src", "client.ts"),
      `export class Client {
        listSessions(workspaceId: string) {
          return this.request("GET", \`/v1/workspaces/\${workspaceId}/sessions\`);
        }
        createSession(workspaceId: string) {
          return this.request("POST", \`/v1/workspaces/\${workspaceId}/sessions\`);
        }
        /** @internal */
        webOnly(workspaceId: string) {
          return this.request("GET", \`/v1/workspaces/\${workspaceId}/web-only\`);
        }
        private request(method: string, path: string) { return { method, path }; }
      }`,
    );
    expect(publishedSdkCalls(join(directory, "src"))).toEqual({
      "GET /v1/workspaces/:p/sessions": ["Client.listSessions"],
      "POST /v1/workspaces/:p/sessions": ["Client.createSession"],
    });
  });

  test("a call resolves to the exact registered routes for each of its verbs", () => {
    expect(resolveCall("GET /v1/workspaces/:p/sessions", registered)).toEqual([SESSIONS]);
    expect(resolveCall("DELETE|GET|POST /v1/workspaces/:p/sessions", registered)).toEqual([
      SESSIONS,
      "POST /v1/workspaces/:workspaceId/sessions",
    ]);
    expect(resolveCall("DELETE /v1/workspaces/:p/sessions", registered)).toEqual([]);
    expect(resolveCall("GET /v1/workspaces/:p/recordings", registered)).toEqual([]);
  });

  test("a loose match counts only when the SDK's literal segments line up with route literals", () => {
    // `company-brain/${kind}`: the SDK placeholder stands in for a route literal.
    expect(resolveCall("GET /v1/workspaces/:p/company-brain/:p", registered)).toEqual([
      "GET /v1/workspaces/:workspaceId/company-brain/files",
    ]);
    // A removed call must not be "served" by an unrelated route of the same length.
    expect(resolveCall("DELETE /v1/workspaces/:p/social/connections/:p", registered)).toEqual([]);
    // A generic call has no literal after its first placeholder, so it pins nothing loosely.
    expect(resolveCall("GET /v1/workspaces/:p/:p/:p", registered)).toEqual([]);
  });

  test("route overrides pin a generic call's real routes and survive refresh", () => {
    const call = "GET|POST /v1/workspaces/:p/:p/:p";
    const override = {
      call,
      routes: ["GET /v1/workspaces/:workspaceId/company-brain/files"],
      reason: "The proxy only reaches company-brain files.",
    };
    const refreshed = refreshPublishedPackage({
      name: "@opengeni/sdk",
      version: "4.6.1",
      calls: { [call]: ["createSessionProxyHandler"] },
      registered,
      previous: {
        name: "@opengeni/sdk",
        version: "4.6.1",
        calls: {},
        acceptedGaps: [],
        routeOverrides: [override],
      },
      acceptGapsReason: null,
    });
    expect(refreshed.newGaps).toEqual([]);
    expect(refreshed.entry.calls[call]!.routes).toEqual(override.routes);
    expect(refreshed.entry.routeOverrides).toEqual([override]);
    const valid = { schemaVersion: 2 as const, packages: [refreshed.entry] };
    expect(validatePublishedInventory(valid)).toBeDefined();
    expect(
      publishedSdkFindings(
        valid,
        registered.filter((route) => !route.path.endsWith("/files")),
      ).breaking.map((finding) => finding.id),
    ).toEqual([
      "published-sdk:@opengeni/sdk@4.6.1:GET /v1/workspaces/:workspaceId/company-brain/files",
    ]);
    const drifted = structuredClone(valid);
    drifted.packages[0]!.calls[call]!.routes = [SESSION];
    expect(() => validatePublishedInventory(drifted)).toThrow(/recorded routes/);
    const unexplained = structuredClone(valid);
    unexplained.packages[0]!.routeOverrides![0]!.reason = "";
    expect(() => validatePublishedInventory(unexplained)).toThrow(/explain/);
  });

  test("a removed route a published SDK calls is breaking, exactly by method and path", () => {
    const withoutGet = registered.filter((route) => !route.path.endsWith(":sessionId"));
    expect(
      publishedSdkFindings(inventory([RECORDING_GAP]), withoutGet).breaking.map(
        (finding) => finding.id,
      ),
    ).toEqual([`published-sdk:@opengeni/sdk@4.6.1:${SESSION}`]);
    // Keeping the path but dropping the verb is also caught.
    const postOnly = registered.filter((route) => route.path !== SESSIONS.slice(4));
    expect(
      publishedSdkFindings(inventory([RECORDING_GAP]), [
        ...postOnly,
        { method: "POST", path: "/v1/workspaces/:workspaceId/sessions" },
      ]).breaking.map((finding) => finding.message),
    ).toEqual([
      `published @opengeni/sdk@4.6.1 calls ${SESSIONS} (Client.listSessions), which the API no longer registers`,
    ]);
    expect(publishedSdkFindings(inventory([RECORDING_GAP]), registered).breaking).toEqual([]);
  });

  test("an accepted gap that is served again is reported for cleanup", () => {
    const result = publishedSdkFindings(
      inventory([
        RECORDING_GAP,
        { call: "GET /v1/workspaces/:p/sessions", reason: "Temporarily missing." },
      ]),
      registered,
    );
    expect(result.resolvedGaps).toEqual(["@opengeni/sdk@4.6.1: GET /v1/workspaces/:p/sessions"]);
  });

  test("refresh resolves routes, keeps existing gap reasons and refuses to invent new ones", () => {
    const previous = inventory([RECORDING_GAP]).packages[0]!;
    const calls = {
      "GET /v1/workspaces/:p/sessions": ["Client.listSessions"],
      "DELETE /v1/workspaces/:p/recordings/:p": ["Client.discardRecording"],
      "GET /v1/workspaces/:p/gone": ["Client.gone"],
    };
    const refused = refreshPublishedPackage({
      name: previous.name,
      version: previous.version,
      calls,
      registered,
      previous,
      acceptGapsReason: null,
    });
    expect(refused.newGaps).toEqual(["GET /v1/workspaces/:p/gone"]);
    expect(refused.entry.acceptedGaps).toEqual([RECORDING_GAP]);
    expect(refused.entry.calls["GET /v1/workspaces/:p/sessions"]).toEqual({
      sdk: ["Client.listSessions"],
      routes: [SESSIONS],
    });
    const accepted = refreshPublishedPackage({
      name: previous.name,
      version: previous.version,
      calls,
      registered,
      previous,
      acceptGapsReason: "Approved exception: link.",
    });
    expect(accepted.entry.acceptedGaps.map((gap) => gap.reason)).toEqual([
      "Removed before the policy.",
      "Approved exception: link.",
    ]);
    expect(
      validatePublishedInventory({ schemaVersion: 2, packages: [accepted.entry] }),
    ).toBeDefined();
  });

  test("validation keeps unresolved calls and accepted gaps consistent", () => {
    expect(validatePublishedInventory(inventory([RECORDING_GAP]))).toBeDefined();
    expect(() => validatePublishedInventory(inventory())).toThrow(/not an accepted gap/);
    expect(() =>
      validatePublishedInventory(
        inventory([
          RECORDING_GAP,
          { call: "GET /v1/workspaces/:p/sessions/:p", reason: "Still served, though." },
        ]),
      ),
    ).toThrow(/remove the gap/);
    expect(() =>
      validatePublishedInventory(
        inventory([RECORDING_GAP, { call: "GET /v1/nope", reason: "Not a call at all." }]),
      ),
    ).toThrow(/not a recorded call/);
    expect(() => validatePublishedInventory(inventory([{ ...RECORDING_GAP, reason: "" }]))).toThrow(
      /explain/,
    );
    expect(() => validatePublishedInventory({ schemaVersion: 1, packages: [] })).toThrow(
      /schemaVersion: 2/,
    );
  });
});
