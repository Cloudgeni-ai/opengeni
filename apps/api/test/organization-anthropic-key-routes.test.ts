import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import * as claudeDefaultModels from "../src/claude-default-models";
import * as codexRoutes from "../src/routes/codex";
import { registerOrganizationModelProviderRoutes } from "../src/routes/organization-model-providers";

const ORGANIZATION = "00000000-0000-4000-8000-0000000000a2";
const BASE = `/v1/organizations/${ORGANIZATION}/model-providers/anthropic`;
// Synthetic fixture; never a real key.
const KEY = "sk-ant-usr-SyntheticFixtureKey_0123456789-abcdefAA";

describe("organization Anthropic API key connection", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let upsert: ReturnType<
    typeof spyOn<typeof opengeniDb, "upsertOrganizationModelProviderConnection">
  >;
  let app: Hono;

  beforeEach(() => {
    upsert = spyOn(opengeniDb, "upsertOrganizationModelProviderConnection").mockImplementation(
      async (_db, input) => ({
        providerKind: input.providerKind,
        status: "active" as const,
        version: 1,
        endpoint: null,
        authMethod: "api_key" as const,
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
        updatedAt: new Date("2026-11-10T00:00:00.000Z"),
      }),
    );
    spies.push(
      upsert,
      spyOn(claudeDefaultModels, "offerClaudeDefaultModels").mockResolvedValue(undefined as never),
      spyOn(codexRoutes, "requireOrganizationCodexHuman").mockResolvedValue({
        subjectId: "user:organization-admin",
        browserSessionHash: "hash",
      } as never),
    );
    app = new Hono();
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    registerOrganizationModelProviderRoutes(app, {
      db: {} as opengeniDb.Database,
      settings: testSettings({
        productAccessMode: "managed",
        publicBaseUrl: "https://opengeni.test",
        environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      }),
    } as unknown as ApiRouteDeps);
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  const put = async (apiKey: string) =>
    await app.request(BASE, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://opengeni.test",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion: 0, apiKey }),
    });

  test("a key broken across lines or quoted is cleaned up and saved", async () => {
    for (const pasted of [
      `${KEY.slice(0, 40)}\n${KEY.slice(40)}`,
      `"${KEY}"`,
      `${KEY.slice(0, 20)}\u200B${KEY.slice(20)}`,
    ]) {
      const response = await put(pasted);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("sk-ant-");
      expect(upsert.mock.calls.at(-1)![1].credentialDigest).toBe(
        opengeniDb.organizationModelProviderCredentialDigest(KEY),
      );
    }
  });

  test.each([
    ["personal key", "sk-ant-usr-Synthetic_fixture-AA"],
    ["service-account key", "sk-ant-svc-Synthetic_fixture-AA"],
    ["Console API key", "sk-ant-api03-Synthetic_fixture-AA"],
    ["future key kind", "sk-ant-new07-Synthetic_fixture-AA"],
    ["key without a kind", "sk-ant-Synthetic_fixture-AA"],
  ] as const)("saved for Anthropic to accept or refuse: %s", async (_label, key) => {
    expect((await put(key)).status).toBe(200);
    expect(upsert.mock.calls.at(-1)![1].credentialDigest).toBe(
      opengeniDb.organizationModelProviderCredentialDigest(key),
    );
  });

  test.each([
    ["setup token", "sk-ant-oat01-Synthetic_fixture", "Use Claude subscription for setup tokens."],
    ["OAuth refresh token", "sk-ant-ort01-Synthetic_fixture", "Use Claude subscription"],
    ["Admin API key", "sk-ant-admin01-Synthetic_fixture", "Admin API key, which can't run models"],
  ] as const)("refused with a plain reason: %s", async (_label, key, message) => {
    const response = await put(key);
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toContain(message);
    expect(text).not.toContain("Synthetic_fixture");
    expect(upsert).not.toHaveBeenCalled();
  });
});
