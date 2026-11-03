import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callServed,
  publishedSdkCalls,
  publishedSdkFindings,
  refreshPublishedPackage,
  validatePublishedInventory,
  type PublishedInventory,
} from "./published-sdk";

const registered = [
  { method: "GET", path: "/v1/workspaces/:workspaceId/sessions" },
  { method: "POST", path: "/v1/workspaces/:workspaceId/sessions" },
  { method: "GET", path: "/v1/workspaces/:workspaceId/sessions/:sessionId" },
];

function inventory(acceptedGaps: { call: string; reason: string }[] = []): PublishedInventory {
  return {
    schemaVersion: 1,
    packages: [
      {
        name: "@opengeni/sdk",
        version: "4.6.1",
        calls: {
          "GET /v1/workspaces/:p/sessions": ["Client.listSessions"],
          "GET /v1/workspaces/:p/sessions/:p": ["Client.getSession"],
          "DELETE /v1/workspaces/:p/recordings/:p": ["Client.discardRecording"],
        },
        acceptedGaps,
      },
    ],
  };
}

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

  test("a call is served when any of its verbs matches a registered route", () => {
    expect(callServed("GET /v1/workspaces/:p/sessions", registered)).toBe(true);
    expect(callServed("DELETE|POST /v1/workspaces/:p/sessions", registered)).toBe(true);
    expect(callServed("DELETE /v1/workspaces/:p/sessions", registered)).toBe(false);
    expect(callServed("GET /v1/workspaces/:p/recordings", registered)).toBe(false);
  });

  test("an unserved published call is breaking unless it is an accepted gap", () => {
    const unaccepted = publishedSdkFindings(inventory(), registered);
    expect(unaccepted.breaking.map((finding) => finding.id)).toEqual([
      "published-sdk:@opengeni/sdk@4.6.1:DELETE /v1/workspaces/:p/recordings/:p",
    ]);
    const accepted = publishedSdkFindings(
      inventory([
        { call: "DELETE /v1/workspaces/:p/recordings/:p", reason: "Removed before the policy." },
      ]),
      registered,
    );
    expect(accepted.breaking).toEqual([]);
  });

  test("removing a route a published SDK calls is caught", () => {
    const withoutGet = registered.filter((route) => !route.path.endsWith(":sessionId"));
    expect(
      publishedSdkFindings(
        inventory([
          { call: "DELETE /v1/workspaces/:p/recordings/:p", reason: "Removed before the policy." },
        ]),
        withoutGet,
      ).breaking.map((finding) => finding.message),
    ).toEqual([
      "published @opengeni/sdk@4.6.1 calls GET /v1/workspaces/:p/sessions/:p (Client.getSession), which the API no longer registers",
    ]);
  });

  test("an accepted gap that is served again is reported for cleanup", () => {
    const result = publishedSdkFindings(
      inventory([{ call: "GET /v1/workspaces/:p/sessions", reason: "Temporarily missing." }]),
      registered,
    );
    expect(result.resolvedGaps).toEqual(["@opengeni/sdk@4.6.1: GET /v1/workspaces/:p/sessions"]);
  });

  test("refresh keeps existing gap reasons and refuses to invent new ones", () => {
    const previous = inventory([
      { call: "DELETE /v1/workspaces/:p/recordings/:p", reason: "Removed before the policy." },
    ]).packages[0]!;
    const calls = { ...previous.calls, "GET /v1/workspaces/:p/gone": ["Client.gone"] };
    const refused = refreshPublishedPackage({
      name: previous.name,
      version: previous.version,
      calls,
      registered,
      previous,
      acceptGapsReason: null,
    });
    expect(refused.newGaps).toEqual(["GET /v1/workspaces/:p/gone"]);
    expect(refused.entry.acceptedGaps).toEqual(previous.acceptedGaps);
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
  });

  test("validation rejects gaps that are not recorded calls or lack a reason", () => {
    expect(validatePublishedInventory(inventory())).toBeDefined();
    expect(() =>
      validatePublishedInventory(
        inventory([{ call: "GET /v1/nope", reason: "Not a call at all." }]),
      ),
    ).toThrow(/not a recorded call/);
    expect(() =>
      validatePublishedInventory(
        inventory([{ call: "DELETE /v1/workspaces/:p/recordings/:p", reason: "" }]),
      ),
    ).toThrow(/explain/);
    expect(() => validatePublishedInventory({ packages: [] })).toThrow(/schemaVersion/);
  });
});
