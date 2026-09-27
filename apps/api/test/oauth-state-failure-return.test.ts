import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { createSignedState } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import {
  INTEGRATIONS_FALLBACK_PATH,
  oauthStateFailureReturn,
  oauthStateTtlMs,
  workspaceIntegrationsPath,
} from "../src/integrations/oauth-client";

const secret = "oauth-state-failure-return-secret";
const settings = testSettings({ integrationsStateSecret: secret }) as Settings;
const workspaceId = "7c1f4c1e-2f0a-4a7b-9d55-0b6f7f1d2e3a";
const nowMs = Date.UTC(2026, 8, 25, 12);
const nowSeconds = Math.floor(nowMs / 1000);

describe("OAuth state failure return", () => {
  test("an authentic but aged state returns to its workspace and says expired", () => {
    const aged = createSignedState(
      secret,
      { workspaceId, accountId: "account" },
      nowSeconds - oauthStateTtlMs / 1000 - 1,
    );
    expect(oauthStateFailureReturn(settings, aged, nowMs)).toEqual({
      returnPath: `/workspaces/${workspaceId}/plugins`,
      reason: "state_expired",
    });
  });

  test("an authentic fresh state that failed is invalid (for example already used)", () => {
    const fresh = createSignedState(secret, { workspaceId }, nowSeconds - 5);
    expect(oauthStateFailureReturn(settings, fresh, nowMs)).toEqual({
      returnPath: workspaceIntegrationsPath(workspaceId),
      reason: "state_invalid",
    });
  });

  test("unsigned, tampered, foreign, or missing state names no workspace", () => {
    const foreign = createSignedState("another-secret", { workspaceId }, nowSeconds - 3600);
    const signed = createSignedState(secret, { workspaceId }, nowSeconds - 3600);
    const [encoded, signature] = signed.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ workspaceId: "11111111-1111-4111-8111-111111111111", nonce: "n", iat: 1 }),
    ).toString("base64url");
    for (const raw of [
      undefined,
      "",
      "not-a-state",
      foreign,
      `${encoded}.${signature}x`,
      `${tamperedPayload}.${signature}`,
    ]) {
      expect(oauthStateFailureReturn(settings, raw, nowMs)).toEqual({
        returnPath: INTEGRATIONS_FALLBACK_PATH,
        reason: "state_invalid",
      });
    }
  });

  test("a signed workspace that is not a UUID never becomes a path", () => {
    const traversal = createSignedState(secret, { workspaceId: "../../admin" }, nowSeconds - 3600);
    expect(oauthStateFailureReturn(settings, traversal, nowMs)).toEqual({
      returnPath: INTEGRATIONS_FALLBACK_PATH,
      reason: "state_expired",
    });
  });

  test("no configured state secret falls back without throwing", () => {
    const aged = createSignedState(secret, { workspaceId }, nowSeconds - 3600);
    const unconfigured = testSettings({ integrationsStateSecret: undefined }) as Settings;
    expect(oauthStateFailureReturn(unconfigured, aged, nowMs)).toEqual({
      returnPath: INTEGRATIONS_FALLBACK_PATH,
      reason: "state_invalid",
    });
  });
});
