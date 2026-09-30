import { describe, expect, test } from "bun:test";
import {
  CreateWorkspaceWebhookRequest,
  CreateOrganizationWebhookRequest,
  CredentialProviderResponse,
  InitiatingHuman,
  PutOrganizationCredentialProviderRequest,
  resolveWorkspaceDefaultSandboxImage,
  signOpenGeniPayload,
  UpdateWorkspaceSettingsRequest,
  verifyOpenGeniSignature,
} from "../src/index";

describe("OpenGeni signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "event", type: "turn.completed" });

  test("round-trips and binds the timestamp and exact body", async () => {
    const signature = await signOpenGeniPayload(secret, body, 1_700_000_000);
    expect(signature).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(
      await verifyOpenGeniSignature({ secret, body, signature, nowSeconds: 1_700_000_010 }),
    ).toBe(true);
    expect(
      await verifyOpenGeniSignature({
        secret,
        body: `${body} `,
        signature,
        nowSeconds: 1_700_000_010,
      }),
    ).toBe(false);
    expect(
      await verifyOpenGeniSignature({
        secret: "other",
        body,
        signature,
        nowSeconds: 1_700_000_010,
      }),
    ).toBe(false);
    const forgedTime = signature.replace("t=1700000000", "t=1700000005");
    expect(
      await verifyOpenGeniSignature({
        secret,
        body,
        signature: forgedTime,
        nowSeconds: 1_700_000_010,
      }),
    ).toBe(false);
  });

  test("rejects stale, malformed, and missing signatures", async () => {
    const signature = await signOpenGeniPayload(secret, body, 1_700_000_000);
    expect(
      await verifyOpenGeniSignature({ secret, body, signature, nowSeconds: 1_700_000_301 }),
    ).toBe(false);
    for (const bad of [null, "", "v1=abc", "t=1700000000", "t=x,v1=00"]) {
      expect(await verifyOpenGeniSignature({ secret, body, signature: bad })).toBe(false);
    }
  });
});

describe("workspace integration contracts", () => {
  test("organization filters are exact and may be cleared without changing workspace inputs", () => {
    const request = {
      url: "https://product.example/credentials",
      workspaceFilter: { externalSource: "Product " },
    };
    expect(PutOrganizationCredentialProviderRequest.parse(request)).toEqual(request);
    expect(
      PutOrganizationCredentialProviderRequest.parse({ ...request, workspaceFilter: null })
        .workspaceFilter,
    ).toBeNull();
    expect(
      CreateWorkspaceWebhookRequest.safeParse({
        url: request.url,
        eventTypes: ["turn.completed"],
        workspaceFilter: {},
      }).success,
    ).toBe(false);
    expect(
      CreateOrganizationWebhookRequest.safeParse({
        url: request.url,
        eventTypes: ["turn.completed"],
        workspaceFilter: {},
      }).success,
    ).toBe(true);
    for (const workspaceFilter of [
      { externalSource: "" },
      { externalId: "tenant" },
      { externalSource: "x".repeat(257) },
    ]) {
      expect(
        PutOrganizationCredentialProviderRequest.safeParse({ ...request, workspaceFilter }).success,
      ).toBe(false);
    }
  });

  test("human attribution represents internal and external identities without granting authority", () => {
    expect(
      InitiatingHuman.parse({ subjectId: "user:alice", externalIdentity: null }).externalIdentity,
    ).toBeNull();
    expect(
      InitiatingHuman.parse({
        subjectId: "external_user:internal",
        externalIdentity: { source: "product", externalId: "user-7" },
      }).externalIdentity?.externalId,
    ).toBe("user-7");
  });

  test("MCP headers validate targets, dates, bounds, token names, duplicates and unsafe headers", () => {
    const entry = {
      server: "capability",
      headers: { Authorization: "Bearer test-only" },
      expiresAt: "2026-09-30T12:00:00+00:00",
    };
    const parse = (mcp: unknown) => CredentialProviderResponse.safeParse({ status: "ok", mcp });
    expect(parse([entry]).success).toBe(true);
    for (const headers of [
      {},
      { Host: "example.com" },
      { CONNECTION: "keep-alive" },
      { "Transfer-Encoding": "chunked" },
      { "Proxy-Authorization": "test-only" },
      { "content-length": "1" },
      { "bad name": "value" },
      { Authorization: "one", authorization: "two" },
      { Authorization: "value\r\nHost: example.com" },
      { Authorization: "\0" },
      { Authorization: "x".repeat(16385) },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, "v"])),
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`x-${i}`, "v".repeat(16384)])),
    ]) {
      expect(parse([{ ...entry, headers }]).success).toBe(false);
    }
    expect(parse([{ ...entry, expiresAt: "not-a-date" }]).success).toBe(false);
    expect(parse([{ ...entry, server: "" }]).success).toBe(false);
    expect(parse([entry, entry]).success).toBe(false);
    expect(
      parse(Array.from({ length: 33 }, (_, i) => ({ ...entry, server: `s-${i}` }))).success,
    ).toBe(false);
  });

  test("webhook event types are a closed set and deduplicated", () => {
    expect(
      CreateWorkspaceWebhookRequest.parse({
        url: "https://receiver.example/hook",
        eventTypes: ["turn.completed", "turn.completed", "turn.failed"],
      }).eventTypes,
    ).toEqual(["turn.completed", "turn.failed"]);
    expect(
      CreateWorkspaceWebhookRequest.safeParse({
        url: "https://receiver.example/hook",
        eventTypes: ["agent.message.delta"],
      }).success,
    ).toBe(false);
  });

  test("credential provider git hosts must be bare hostnames", () => {
    expect(
      CredentialProviderResponse.safeParse({
        status: "ok",
        git: [{ host: "github.com", password: "token" }],
      }).success,
    ).toBe(true);
    expect(
      CredentialProviderResponse.safeParse({
        status: "ok",
        git: [{ host: "evil.example/path@github.com", password: "token" }],
      }).success,
    ).toBe(false);
  });

  test("default sandbox image is an optional settings field", () => {
    expect(resolveWorkspaceDefaultSandboxImage({ defaultSandboxImage: "ghcr.io/a/b:1" })).toBe(
      "ghcr.io/a/b:1",
    );
    expect(resolveWorkspaceDefaultSandboxImage({})).toBeNull();
    expect(UpdateWorkspaceSettingsRequest.safeParse({ defaultSandboxImage: "a b" }).success).toBe(
      false,
    );
    expect(UpdateWorkspaceSettingsRequest.safeParse({ defaultSandboxImage: null }).success).toBe(
      true,
    );
  });
});
