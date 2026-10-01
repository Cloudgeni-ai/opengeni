import { describe, expect, test } from "bun:test";
import {
  CreateWorkspaceWebhookRequest,
  CreateOrganizationWebhookRequest,
  CredentialProviderResponse,
  InitiatingHuman,
  OrganizationWebhook,
  PutOrganizationCredentialProviderRequest,
  resolveWorkspaceDefaultSandboxImage,
  signOpenGeniPayload,
  UpdateOrganizationWebhookRequest,
  UpdateWorkspaceSettingsRequest,
  verifyOpenGeniSignature,
  WorkspaceWebhookEvent,
} from "../src/index";

describe("OpenGeni signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "event", type: "turn.completed" });

  test("round-trips and binds the timestamp and exact body", async () => {
    const signature = await signOpenGeniPayload(secret, body, 1_700_000_000);
    expect(signature).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(
      await verifyOpenGeniSignature({
        secret,
        body,
        signature,
        nowSeconds: 1_700_000_010,
      }),
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
      await verifyOpenGeniSignature({
        secret,
        body,
        signature,
        nowSeconds: 1_700_000_301,
      }),
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
      PutOrganizationCredentialProviderRequest.parse({
        ...request,
        workspaceFilter: null,
      }).workspaceFilter,
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
    ).toBe(false);
    expect(PutOrganizationCredentialProviderRequest.safeParse({ url: request.url }).success).toBe(
      false,
    );
    expect(
      CreateOrganizationWebhookRequest.safeParse({
        url: request.url,
        eventTypes: ["turn.completed"],
      }).success,
    ).toBe(false);
    for (const workspaceFilter of [
      { externalSource: "" },
      { externalId: "tenant" },
      { externalSource: "x".repeat(201) },
      { externalSource: "é".repeat(101) },
      { externalSource: "nul\0" },
      { externalSource: "\uD800" },
    ]) {
      expect(
        PutOrganizationCredentialProviderRequest.safeParse({
          ...request,
          workspaceFilter,
        }).success,
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
      url: "https://product.example/mcp",
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
      { "MCP-Session-ID": "session" },
      { "mcp-protocol-version": "2025-03-26" },
      { "content-type": "application/json" },
      { Accept: "application/json" },
      { "bad name": "value" },
      { "Authorization\n": "value" },
      { Authorization: "one", authorization: "two" },
      { Authorization: "value\r\nHost: example.com" },
      { Authorization: "\0" },
      { Authorization: "unsupported-😀" },
      { Authorization: "x".repeat(16385) },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, "v"])),
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`x-${i}`, "v".repeat(16384)])),
    ]) {
      expect(parse([{ ...entry, headers }]).success).toBe(false);
    }
    expect(parse([{ ...entry, expiresAt: "not-a-date" }]).success).toBe(false);
    expect(parse([{ ...entry, url: "" }]).success).toBe(false);
    expect(parse([{ server: "product-capabilities", headers: entry.headers }]).success).toBe(false);
    for (const url of [
      "product-capabilities",
      "file:///tmp/mcp",
      "https://user:secret@product.example/mcp",
      "https://product.example/mcp#fragment",
    ]) {
      expect(parse([{ ...entry, url }]).success).toBe(false);
    }
    expect(
      CredentialProviderResponse.parse({
        status: "ok",
        mcp: [{ ...entry, url: "HTTPS://PRODUCT.EXAMPLE:443/mcp" }],
      }),
    ).toMatchObject({ mcp: [{ url: entry.url }] });
    expect(parse([entry, entry]).success).toBe(false);
    expect(parse([entry, { ...entry, url: "https://PRODUCT.EXAMPLE:443/mcp" }]).success).toBe(
      false,
    );
    expect(
      parse(
        Array.from({ length: 33 }, (_, i) => ({
          ...entry,
          url: `https://product.example/mcp/${i}`,
        })),
      ).success,
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
    expect(
      resolveWorkspaceDefaultSandboxImage({
        defaultSandboxImage: "ghcr.io/a/b:1",
      }),
    ).toBe("ghcr.io/a/b:1");
    expect(resolveWorkspaceDefaultSandboxImage({})).toBeNull();
    expect(UpdateWorkspaceSettingsRequest.safeParse({ defaultSandboxImage: "a b" }).success).toBe(
      false,
    );
    expect(UpdateWorkspaceSettingsRequest.safeParse({ defaultSandboxImage: null }).success).toBe(
      true,
    );
  });
});

test("organization webhooks accept session event types only; usage events stay per-workspace", () => {
  const base = { url: "https://hooks.example.com/og", workspaceFilter: null };
  expect(
    CreateOrganizationWebhookRequest.safeParse({
      ...base,
      eventTypes: ["turn.completed"],
    }).success,
  ).toBe(true);
  expect(
    CreateOrganizationWebhookRequest.safeParse({
      ...base,
      eventTypes: ["usage.exhausted"],
    }).success,
  ).toBe(false);
  expect(
    UpdateOrganizationWebhookRequest.safeParse({
      workspaceFilter: null,
      eventTypes: ["usage.period_reset"],
    }).success,
  ).toBe(false);
  expect(
    CreateWorkspaceWebhookRequest.safeParse({
      url: base.url,
      eventTypes: ["usage.exhausted"],
    }).success,
  ).toBe(true);
  const invalid = CreateOrganizationWebhookRequest.safeParse({
    ...base,
    eventTypes: ["usage.exhausted"],
  });
  expect(invalid.success).toBe(false);
  if (!invalid.success) {
    expect(invalid.error.issues[0]?.message).toContain("workspace webhook");
  }
  const webhook = {
    id: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    url: base.url,
    enabled: true,
    description: null,
    workspaceFilter: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
  expect(
    OrganizationWebhook.safeParse({ ...webhook, eventTypes: ["turn.completed"] }).success,
  ).toBe(true);
  expect(
    OrganizationWebhook.safeParse({ ...webhook, eventTypes: ["usage.exhausted"] }).success,
  ).toBe(false);
});

test("signed pre-upgrade session and usage webhook bodies default to the workspace lane", async () => {
  const common = {
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    occurredAt: "2026-09-01T00:00:00Z",
  };
  for (const event of [
    {
      ...common,
      type: "turn.completed",
      sessionId: crypto.randomUUID(),
      turnId: null,
      sequence: 1,
      data: {},
    },
    { ...common, type: "usage.exhausted", data: { scope: "workspace", resetsAt: null } },
  ]) {
    const body = JSON.stringify(event);
    const signature = await signOpenGeniPayload("legacy-secret", body, 1_700_000_000);
    expect(
      await verifyOpenGeniSignature({
        secret: "legacy-secret",
        body,
        signature,
        nowSeconds: 1_700_000_001,
      }),
    ).toBe(true);
    expect(WorkspaceWebhookEvent.parse(JSON.parse(body)).lane).toBe("workspace");
    expect(WorkspaceWebhookEvent.parse({ ...event, lane: "workspace" }).lane).toBe("workspace");
  }
  const session = {
    ...common,
    type: "turn.completed",
    sessionId: crypto.randomUUID(),
    turnId: null,
    sequence: 1,
    data: {},
  };
  expect(WorkspaceWebhookEvent.parse({ ...session, lane: "organization" }).lane).toBe(
    "organization",
  );
  expect(
    WorkspaceWebhookEvent.safeParse({
      ...common,
      type: "usage.exhausted",
      lane: "organization",
      data: {},
    }).success,
  ).toBe(false);
});
