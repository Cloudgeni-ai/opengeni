import { describe, expect, test } from "bun:test";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { apiContractAdmission, createApp, type AppDependencies } from "../src/app";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";

function appFor(settings: Settings) {
  return createApp({
    settings,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } satisfies AppDependencies);
}

describe("API contract admission", () => {
  const mutation = { method: "POST", pathname: `/v1/workspaces/${WORKSPACE}/sessions` };
  const stale = "2026-01-stale-v1";

  test("a browser (cookie / no bearer) must match the exact revision", () => {
    for (const claimedRevision of [undefined, stale]) {
      expect(apiContractAdmission({ ...mutation, authorization: undefined, claimedRevision })).toBe(
        "reject",
      );
    }
    expect(
      apiContractAdmission({
        ...mutation,
        authorization: undefined,
        claimedRevision: OPENGENI_API_CONTRACT_REVISION,
      }),
    ).toBe("admit");
  });

  test("a bearer integration is admitted with an older or missing revision", () => {
    for (const claimedRevision of [undefined, stale, OPENGENI_API_CONTRACT_REVISION]) {
      expect(
        apiContractAdmission({ ...mutation, authorization: "Bearer ogk_example", claimedRevision }),
      ).toBe("admit");
    }
    // A scheme without a credential is not bearer authentication.
    expect(
      apiContractAdmission({ ...mutation, authorization: "Bearer ", claimedRevision: stale }),
    ).toBe("reject");
    expect(
      apiContractAdmission({ ...mutation, authorization: "Basic abc", claimedRevision: stale }),
    ).toBe("reject");
  });

  test("an explicitly refused revision is rejected for bearer callers too", () => {
    expect(
      apiContractAdmission(
        { ...mutation, authorization: "Bearer ogk_example", claimedRevision: stale },
        new Set([stale]),
      ),
    ).toBe("reject");
  });

  test("reads and unprotected protocols are never fenced", () => {
    expect(
      apiContractAdmission({
        method: "GET",
        pathname: mutation.pathname,
        authorization: undefined,
        claimedRevision: stale,
      }),
    ).toBe("admit");
  });

  test("in production a stale browser mutation is 409 while a stale bearer proceeds", async () => {
    const app = appFor(testSettings({ environment: "production" }));
    const path = `/v1/workspaces/${WORKSPACE}/sessions/${SESSION}/control`;
    const browser = await app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "better-auth.session_token=stale-tab",
        [OPENGENI_API_CONTRACT_HEADER]: stale,
      },
      body: "{}",
    });
    expect(browser.status).toBe(409);
    expect(await browser.json()).toMatchObject({ code: "API_CONTRACT_CHANGED" });

    for (const { headers, advertised } of [
      {
        headers: { authorization: "Bearer ogk_integration", [OPENGENI_API_CONTRACT_HEADER]: stale },
        // A pinned SDK throws on any mismatched response revision, so a bearer
        // that claimed a different revision receives no revision header.
        advertised: null,
      },
      {
        headers: { authorization: "Bearer ogk_integration" },
        advertised: OPENGENI_API_CONTRACT_REVISION,
      },
    ]) {
      const bearer = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
      // The request passes the contract fence and reaches authentication,
      // which the inert test dependencies cannot complete.
      expect(bearer.status).not.toBe(409);
      expect(bearer.headers.get(OPENGENI_API_CONTRACT_HEADER)).toBe(advertised);
    }
  });
});
