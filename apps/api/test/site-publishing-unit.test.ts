import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FREE_SITE_LIMITS,
  SITE_GATEWAY_BODY_SHA256_HEADER,
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  UNLIMITED_SITE_FLOOD_BRAKES,
  type SiteHostMapRecord,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { createSiteContentScanner, siteHtmlUrls } from "../src/site-publishing/content-scanner";
import { createSiteEdgeSync } from "../src/site-publishing/edge-sync";
import {
  sameSha256Hex,
  sha256Hex,
  signSiteGatewayRequest,
  verifySiteGatewayRequest,
} from "../src/site-publishing/gateway-signature";
import { siteAgentToolRefs } from "../src/routes/site-runtime";
import { effectiveSiteLimits, freeSiteLimits } from "../src/site-publishing/limits";
import { siteClientAddressKey } from "../src/site-publishing/runtime";
import { siteAccessNarrowed, siteAgentToolsNarrowed } from "../src/site-publishing/service";
import {
  siteSessionEventProjection,
  siteSessionEventSseTransform,
} from "../src/site-publishing/session-events";
import {
  siteAcceptedMessageView,
  siteControlResultView,
  siteDraftView,
  siteHumanInputListView,
  siteHumanInputRequestView,
  siteQueueMutationView,
  siteQueueView,
} from "../src/site-publishing/session-views";
import {
  effectiveSiteAccess,
  signedInSiteViewerKind,
  siteGuestsAllowed,
} from "../src/site-publishing/viewer";

const CURRENT = "c".repeat(40);
const PREVIOUS = "p".repeat(40);
const PATH = "/v1/site-runtime/site/config";

function verify(
  headers: Record<string, string>,
  overrides: Partial<Parameters<typeof verifySiteGatewayRequest>[0]> = {},
) {
  return verifySiteGatewayRequest({
    method: "POST",
    pathWithQuery: PATH,
    headers: new Headers(headers),
    secrets: [CURRENT, PREVIOUS],
    ...overrides,
  });
}

function signed(
  secret = CURRENT,
  extra: Partial<Parameters<typeof signSiteGatewayRequest>[0]> = {},
) {
  return signSiteGatewayRequest({
    secret,
    method: "POST",
    pathWithQuery: PATH,
    host: "demo-1a2b.sites.example.test",
    body: '{"a":1}',
    visitor: "visitor-abcdefghijklmnop",
    clientIp: "203.0.113.9",
    ...extra,
  });
}

describe("gateway signature", () => {
  test("accepts the current and the previous secret", () => {
    const current = verify(signed());
    expect(current).toEqual({
      ok: true,
      fields: {
        host: "demo-1a2b.sites.example.test",
        session: "",
        visitor: "visitor-abcdefghijklmnop",
        clientIp: "203.0.113.9",
        human: false,
      },
      bodySha256: sha256Hex(new TextEncoder().encode('{"a":1}')),
    });
    expect(verify(signed(PREVIOUS)).ok).toBe(true);
    expect(verify(signed(CURRENT, { human: true }))).toMatchObject({
      ok: true,
      fields: { human: true },
    });
  });

  test("refuses a missing, foreign, stale, or tampered signature", () => {
    expect(verify({})).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify(signed("x".repeat(40)))).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(signed(CURRENT, { nowMs: Date.now() - 31_000 }))).toEqual({
      ok: false,
      reason: "skew",
    });
    expect(verify(signed(CURRENT, { nowMs: Date.now() + 31_000 }))).toEqual({
      ok: false,
      reason: "skew",
    });
    // The body hash, path, method and viewer headers are all covered.
    expect(
      verify({
        ...signed(),
        [SITE_GATEWAY_BODY_SHA256_HEADER]: sha256Hex(new TextEncoder().encode('{"a":2}')),
      }),
    ).toMatchObject({ reason: "bad_signature" });
    expect(verify(signed(), { pathWithQuery: `${PATH}?x=1` })).toMatchObject({
      reason: "bad_signature",
    });
    expect(verify(signed(), { method: "PUT" })).toMatchObject({ reason: "bad_signature" });
    expect(
      verify({ ...signed(), "x-opengeni-site-visitor": "another-visitor-abcdefgh" }),
    ).toMatchObject({ reason: "bad_signature" });
    expect(
      verify({ ...signed(), "x-opengeni-site-host": "other.sites.example.test" }),
    ).toMatchObject({ reason: "bad_signature" });
    expect(verify({ ...signed(), [SITE_GATEWAY_TIMESTAMP_HEADER]: "12ab" })).toMatchObject({
      reason: "bad_timestamp",
    });
    const header = signed()[SITE_GATEWAY_SIGNATURE_HEADER]!;
    expect(
      verify({ ...signed(), [SITE_GATEWAY_SIGNATURE_HEADER]: `${header.slice(0, -2)}AA` }),
    ).toMatchObject({ reason: "bad_signature" });
    expect(verify(signed(), { secrets: [undefined, undefined] })).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  test("requires the signed body hash header, as lowercase hex", () => {
    const headers = signed();
    const hash = headers[SITE_GATEWAY_BODY_SHA256_HEADER]!;
    expect(hash).toBe(sha256Hex(new TextEncoder().encode('{"a":1}')));
    const withoutHash = { ...headers };
    delete withoutHash[SITE_GATEWAY_BODY_SHA256_HEADER];
    expect(verify(withoutHash)).toEqual({ ok: false, reason: "missing_headers" });
    for (const value of ["", "ABC", hash.toUpperCase(), hash.slice(1), `${hash}0`])
      expect(verify({ ...headers, [SITE_GATEWAY_BODY_SHA256_HEADER]: value })).toEqual({
        ok: false,
        reason: "bad_body_hash",
      });
    // GET and HEAD sign the hash of the empty body.
    expect(signed(CURRENT, { body: "" })[SITE_GATEWAY_BODY_SHA256_HEADER]).toBe(
      sha256Hex(new Uint8Array()),
    );
    // The body read afterwards is compared with the signed hash in constant time.
    expect(sameSha256Hex(sha256Hex(new TextEncoder().encode('{"a":1}')), hash)).toBe(true);
    expect(sameSha256Hex(sha256Hex(new TextEncoder().encode('{"a":2}')), hash)).toBe(false);
    expect(sameSha256Hex("", hash)).toBe(false);
  });

  test("refuses signed requests that also carry app credentials", () => {
    for (const name of ["authorization", "cookie", "x-api-key", "x-opengeni-external-actor"])
      expect(verify({ ...signed(), [name]: "x" })).toEqual({ ok: false, reason: "credentials" });
  });
});

describe("limits", () => {
  const settings = testSettings();

  test("the free profile is the strict platform default", () => {
    expect(freeSiteLimits(settings)).toEqual({ ...DEFAULT_FREE_SITE_LIMITS });
    expect(effectiveSiteLimits(settings, null, null)).toEqual({ ...DEFAULT_FREE_SITE_LIMITS });
  });

  test("the Site profile wins over the workspace default", () => {
    const site = effectiveSiteLimits(
      settings,
      { kind: "custom", overrides: { turnsPerConversation: 3, bogus: 1 } },
      { kind: "credits", overrides: null },
    );
    expect(site.turnsPerConversation).toBe(3);
    expect(site.requestsPerMinutePerVisitor).toBe(
      DEFAULT_FREE_SITE_LIMITS.requestsPerMinutePerVisitor,
    );
    const workspace = effectiveSiteLimits(settings, null, { kind: "credits", overrides: null });
    expect(workspace.agentMicrosPerSitePerMonth).toBe(
      DEFAULT_FREE_SITE_LIMITS.agentMicrosPerSitePerMonth! * settings.sitesCreditsLimitMultiplier,
    );
  });

  test("unlimited keeps the flood brakes and custom values cannot pass them", () => {
    const unlimited = effectiveSiteLimits(settings, { kind: "unlimited", overrides: null }, null);
    expect(unlimited.requestsPerMinutePerVisitor).toBe(
      UNLIMITED_SITE_FLOOD_BRAKES.requestsPerMinutePerVisitor,
    );
    expect(unlimited.agentMicrosPerConversation).toBe(
      UNLIMITED_SITE_FLOOD_BRAKES.agentMicrosPerConversation,
    );
    expect(unlimited.agentMicrosPerSitePerMonth).toBeNull();
    const custom = effectiveSiteLimits(
      settings,
      {
        kind: "custom",
        overrides: { requestsPerMinutePerVisitor: null, agentMicrosPerConversation: 9e12 },
      },
      null,
    );
    expect(custom.requestsPerMinutePerVisitor).toBe(
      UNLIMITED_SITE_FLOOD_BRAKES.requestsPerMinutePerVisitor,
    );
    expect(custom.agentMicrosPerConversation).toBe(
      UNLIMITED_SITE_FLOOD_BRAKES.agentMicrosPerConversation,
    );
  });

  test("turning public agents off turns guest agents off everywhere", () => {
    const off = testSettings({ sitesPublicAgentsEnabled: false });
    expect(
      effectiveSiteLimits(off, { kind: "unlimited", overrides: null }, null).guestAgentsEnabled,
    ).toBe(false);
  });
});

describe("viewer access", () => {
  const open = { sitesPublicEnabled: true, sitesLoginOnly: false };
  test("members, invited people and anyone signed in", () => {
    const base = { member: false, email: "ada@example.com", invitedEmails: ["ada@example.com"] };
    expect(signedInSiteViewerKind({ ...base, access: "members" })).toBeNull();
    expect(signedInSiteViewerKind({ ...base, access: "members", member: true })).toBe("member");
    expect(signedInSiteViewerKind({ ...base, access: "invited" })).toBe("invited");
    expect(signedInSiteViewerKind({ ...base, access: "invited", email: null })).toBeNull();
    expect(signedInSiteViewerKind({ ...base, access: "invited", invitedEmails: [] })).toBeNull();
    expect(signedInSiteViewerKind({ ...base, access: "public", invitedEmails: [] })).toBe("user");
  });

  test("guests only on public Sites of deployments that allow them", () => {
    expect(siteGuestsAllowed("public", open)).toBe(true);
    expect(siteGuestsAllowed("invited", open)).toBe(false);
    expect(siteGuestsAllowed("public", { ...open, sitesLoginOnly: true })).toBe(false);
    expect(siteGuestsAllowed("public", { ...open, sitesPublicEnabled: false })).toBe(false);
    expect(effectiveSiteAccess("public", { ...open, sitesPublicEnabled: false })).toBe("members");
  });
});

describe("edge sync", () => {
  const record: SiteHostMapRecord = {
    v: 1,
    hostname: "demo-1a2b.sites.example.test",
    siteId: crypto.randomUUID(),
    status: "active",
    access: "public",
    versionId: crypto.randomUUID(),
    title: "Demo",
    noindex: true,
    generation: 5,
    updatedAt: new Date().toISOString(),
  };
  const cloudflare = {
    sitesCloudflareApiToken: "token",
    sitesCloudflareAccountId: "account",
    sitesCloudflareKvNamespaceId: "namespace",
    sitesCloudflareZoneId: "zone",
    sitesHostMapTtlSeconds: 300,
  };

  test("is a no-op without settings", async () => {
    const calls: string[] = [];
    const sync = createSiteEdgeSync(
      { ...cloudflare, sitesCloudflareApiToken: undefined, sitesCloudflareZoneId: undefined },
      { fetch: (async (url: string) => (calls.push(url), new Response(null))) as never },
    );
    expect(await sync.putHostRecord(record)).toBe("disabled");
    expect(await sync.purgeHost(record.hostname)).toBe("disabled");
    expect(calls).toEqual([]);
  });

  test("never replaces a newer generation, retries failures, and purges by host", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    let stored: SiteHostMapRecord | null = { ...record, generation: 7 };
    let failures = 1;
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
      if (method === "GET") {
        if (failures-- > 0) return new Response("busy", { status: 503 });
        return stored ? Response.json(stored) : new Response(null, { status: 404 });
      }
      if (method === "PUT") stored = JSON.parse(String(init.body));
      return new Response(null, { status: 200 });
    };
    const sync = createSiteEdgeSync(cloudflare, { fetch: fetchImpl as never, backoffMs: 0 });
    expect(await sync.putHostRecord(record)).toBe("skipped_newer");
    stored = null;
    expect(await sync.putHostRecord(record)).toBe("written");
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toContain("/accounts/account/storage/kv/namespaces/namespace/values/");
    expect(put.url).toContain(encodeURIComponent(`host:${record.hostname}`));
    expect(put.url).toContain("expiration_ttl=300");
    expect(JSON.parse(put.body!)).toEqual(record);
    expect(await sync.purgeHost(record.hostname)).toBe("purged");
    const purge = calls.at(-1)!;
    expect(purge.url).toContain("/zones/zone/purge_cache");
    expect(JSON.parse(purge.body!)).toEqual({ hosts: [record.hostname] });
  });
});

describe("content scanner", () => {
  test("is off without a Web Risk key and never calls out", async () => {
    const calls: string[] = [];
    const scanner = createSiteContentScanner(testSettings(), {
      fetch: (async (url: string) => (calls.push(url), new Response("{}"))) as never,
    });
    expect(scanner.name).toBe("none");
    expect(await scanner.scanHtml('<a href="https://evil.example/">x</a>')).toEqual({
      status: "none",
      findings: [],
    });
    expect(calls).toEqual([]);
  });

  test("Web Risk records flagged URLs found in the HTML", async () => {
    const scanner = createSiteContentScanner(testSettings({ sitesWebRiskApiKey: "key" }), {
      fetch: (async (url: string) =>
        Response.json(
          url.includes(encodeURIComponent("https://evil.example/"))
            ? { threat: { threatTypes: ["SOCIAL_ENGINEERING"] } }
            : {},
        )) as never,
    });
    const html = '<a href="https://evil.example/">x</a><img src="https://fine.example/a.png">';
    expect(siteHtmlUrls(html)).toEqual(["https://evil.example/", "https://fine.example/a.png"]);
    expect(await scanner.scanHtml(html)).toEqual({
      status: "flagged",
      findings: [{ url: "https://evil.example/", threatTypes: ["SOCIAL_ENGINEERING"] }],
    });
  });
});

describe("Site agents", () => {
  test("workspace tools reach members and invited viewers; everyone else only when an admin opted in", () => {
    const tools = { tools: ["crm", "bad id!"], guestTools: false };
    const crm = [{ kind: "mcp", id: "crm", optional: true }];
    expect(siteAgentToolRefs(tools, { kind: "member" })).toEqual(crm);
    expect(siteAgentToolRefs(tools, { kind: "invited" })).toEqual(crm);
    // A signed-in person outside the workspace on a public Site is not a member.
    expect(siteAgentToolRefs(tools, { kind: "user" })).toEqual([]);
    expect(siteAgentToolRefs(tools, { kind: "guest" })).toEqual([]);
    expect(siteAgentToolRefs({ ...tools, guestTools: true }, { kind: "user" })).toEqual(crm);
    expect(siteAgentToolRefs({ ...tools, guestTools: true }, { kind: "guest" })).toEqual(crm);
    expect(siteAgentToolRefs({ tools: null, guestTools: true }, { kind: "member" })).toEqual([]);
  });

  test("viewers stop when a Site is unpublished, its access narrows or its agent turns off", () => {
    const base = {
      status: "active" as const,
      access: "invited" as const,
      invitedEmails: ["a@example.com", "b@example.com"],
      agent: { enabled: true, model: null, instructions: null, tools: null, guestTools: false },
    };
    expect(siteAccessNarrowed(base, base)).toBeNull();
    expect(siteAccessNarrowed(base, { ...base, status: "unpublished" })).toBe("unpublished");
    expect(siteAccessNarrowed(base, { ...base, access: "members" })).toBe("access_narrowed");
    expect(siteAccessNarrowed(base, { ...base, invitedEmails: ["a@example.com"] })).toBe(
      "access_narrowed",
    );
    expect(
      siteAccessNarrowed(base, { ...base, invitedEmails: [...base.invitedEmails, "c@x.io"] }),
    ).toBeNull();
    expect(siteAccessNarrowed(base, { ...base, access: "public" })).toBeNull();
    expect(siteAccessNarrowed(base, { ...base, agent: { ...base.agent, enabled: false } })).toBe(
      "agent_disabled",
    );
  });

  test("tools narrow when one is removed or they are no longer for everyone", () => {
    const tools = { tools: ["crm", "billing"], guestTools: true };
    expect(siteAgentToolsNarrowed(tools, tools)).toBe(false);
    expect(siteAgentToolsNarrowed(tools, { ...tools, tools: ["crm", "billing", "docs"] })).toBe(
      false,
    );
    expect(siteAgentToolsNarrowed(tools, { ...tools, tools: ["crm"] })).toBe(true);
    expect(siteAgentToolsNarrowed(tools, { ...tools, tools: null })).toBe(true);
    expect(siteAgentToolsNarrowed(tools, { ...tools, guestTools: false })).toBe(true);
    // Without tools, the opt-in changes nothing.
    expect(
      siteAgentToolsNarrowed({ tools: null, guestTools: true }, { tools: null, guestTools: false }),
    ).toBe(false);
  });
});

describe("Site-safe session events", () => {
  const SECRET = "sk-live-secret-argument";
  const base = {
    id: "5b0d6f8e-0d37-4b8f-9c43-0f1c6c1f7a01",
    workspaceId: "0e4c3a4d-6c50-4d1b-8f4e-2a5d8f1c9b11",
    sessionId: "9a1f2b3c-4d5e-4f60-8a7b-1c2d3e4f5a6b",
    occurredAt: "2026-10-14T12:00:00.000Z",
    turnId: "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9",
    turnGeneration: 3,
    turnAttemptId: "7c6b5a49-3827-4615-9a04-8f7e6d5c4b3a",
    turnAssociation: "current",
    duplicateOfEventId: null,
    duplicateReason: null,
    payloadCodecVersion: 1,
    payloadReadBounded: false,
    clientEventId: "opengeni:internal-key",
  };
  const envelopeKeys = ["id", "sessionId", "sequence", "occurredAt", "type", "turnId", "payload"];

  test("keeps message text and tool names, never tool arguments, outputs or internal ids", () => {
    const longText = "word ".repeat(2000);
    const message = siteSessionEventProjection({
      ...base,
      sequence: 4,
      type: "agent.message.completed",
      payload: { text: longText, messageId: "msg_1", phase: "final_answer", usage: { cost: 9 } },
    });
    expect(message).toEqual({
      id: base.id,
      sessionId: base.sessionId,
      sequence: 4,
      occurredAt: base.occurredAt,
      type: "agent.message.completed",
      turnId: base.turnId,
      payload: { text: longText, messageId: "msg_1", phase: "final_answer" },
    });
    const call = siteSessionEventProjection({
      ...base,
      sequence: 5,
      type: "agent.toolCall.created",
      payload: { id: "call_1", name: "crm_lookup", arguments: { token: SECRET }, raw: SECRET },
    });
    expect(call?.payload).toEqual({ id: "call_1", name: "crm_lookup" });
    const output = siteSessionEventProjection({
      ...base,
      sequence: 6,
      type: "agent.toolCall.output",
      payload: { id: "call_1", output: { isError: true, content: [{ text: SECRET }] } },
    });
    expect(output?.payload).toEqual({ id: "call_1", error: true });
    const failed = siteSessionEventProjection({
      ...base,
      sequence: 7,
      type: "turn.failed",
      payload: { code: "provider_error", error: `upstream said ${SECRET}`, retryable: true },
    });
    expect(failed?.payload).toEqual({ code: "provider_error", retryable: true });
    const user = siteSessionEventProjection({
      ...base,
      sequence: 8,
      type: "user.message",
      payload: { text: "Hi", resources: [{ id: SECRET }], initiator: { userId: SECRET } },
    });
    expect(user).toMatchObject({ clientEventId: base.clientEventId, payload: { text: "Hi" } });
    for (const event of [message, call, output, failed, user]) {
      expect(JSON.stringify(event)).not.toContain(SECRET);
      expect(Object.keys(event!).filter((key) => !envelopeKeys.includes(key))).toEqual(
        event === user ? ["clientEventId"] : [],
      );
    }
    expect(
      siteSessionEventProjection(
        { ...base, sequence: 9, type: "user.message", payload: { text: "Hi" } },
        { payload: "none" },
      )?.payload,
    ).toEqual({});
  });

  test("hidden, late and duplicate events become placeholders at the same sequence", () => {
    const placeholder = (sequence: number, coveredThrough?: number) => ({
      id: base.id,
      sessionId: base.sessionId,
      sequence,
      ...(coveredThrough ? { coveredThrough } : {}),
      occurredAt: base.occurredAt,
      type: "session.event.envelope_omitted",
      turnId: null,
      payload: {},
    });
    expect(
      siteSessionEventProjection({
        ...base,
        sequence: 2,
        type: "sandbox.box.created",
        payload: { sandboxId: SECRET },
      }),
    ).toEqual(placeholder(2));
    expect(
      siteSessionEventProjection({
        ...base,
        sequence: 3,
        coveredThrough: 9,
        type: "agent.reasoning.delta",
        payload: { text: SECRET },
      }),
    ).toEqual(placeholder(3, 9));
    expect(
      siteSessionEventProjection({
        ...base,
        sequence: 10,
        type: "agent.message.completed",
        turnAssociation: "late_rejected",
        payload: { text: SECRET },
      }),
    ).toEqual(placeholder(10));
    expect(
      siteSessionEventProjection({
        ...base,
        sequence: 11,
        type: "agent.message.completed",
        duplicateOfEventId: base.id,
        payload: { text: SECRET },
      }),
    ).toEqual(placeholder(11));
    expect(siteSessionEventProjection({ ...base, type: "user.message" })).toBeNull();
    expect(siteSessionEventProjection("not an event")).toBeNull();
  });

  test("the stream transform rewrites split SSE frames and keeps ids and comments", async () => {
    const frame = (sequence: number, covered: number, type: string, payload: unknown) =>
      `id: ${covered}\nevent: ${type}\ndata: ${JSON.stringify({ ...base, sequence, type, payload })}\n\n`;
    const upstream =
      ": connected\n\n" +
      frame(1, 1, "user.message", { text: "Grüße 👋", resources: [SECRET] }) +
      frame(2, 4, "agent.reasoning.delta", { text: SECRET }) +
      frame(5, 5, "agent.toolCall.created", { id: "call_1", name: "crm", arguments: SECRET }) +
      ": heartbeat\n\n";
    const bytes = new TextEncoder().encode(upstream);
    // One byte per chunk: every frame and multi-byte character is split.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 1)
          controller.enqueue(bytes.slice(index, index + 1));
        controller.close();
      },
    });
    const text = await new Response(source.pipeThrough(siteSessionEventSseTransform())).text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(base.workspaceId);
    expect(text).not.toContain(base.turnAttemptId);
    expect(text.startsWith(": connected\n\n")).toBe(true);
    expect(text.endsWith(": heartbeat\n\n")).toBe(true);
    const frames = [...text.matchAll(/^id: (\d+)\nevent: (\S+)\ndata: (.+)$/gmu)].map(
      ([, id, type, data]) => ({ id: Number(id), type, event: JSON.parse(data!) }),
    );
    expect(frames.map(({ id, type }) => [id, type])).toEqual([
      [1, "user.message"],
      [4, "session.event.envelope_omitted"],
      [5, "agent.toolCall.created"],
    ]);
    expect(frames[0]!.event.payload).toEqual({ text: "Grüße 👋" });
    expect(frames[2]!.event.payload).toEqual({ id: "call_1", name: "crm" });
  });
});

describe("Site-safe session views", () => {
  const WORKSPACE = "0e4c3a4d-6c50-4d1b-8f4e-2a5d8f1c9b11";
  const SECRET = "vault-item-secret-name";
  const control = {
    state: "paused",
    controlVersion: 3,
    controlEtag: "etag-3",
    directState: "running",
    primaryBlocker: {
      kind: "workspace",
      displayName: "Acme Corp workspace",
      actor: "user:someone",
      reason: "Budget review",
      changedAt: "2026-10-14T10:00:00.000Z",
      revision: 2,
    },
    additionalBlockerCount: 0,
    blockers: [],
    resumeOptions: [
      { scope: "workspace", selectedStateAfter: "running", impactCopy: "Resume Acme Corp" },
      { scope: "session", selectedStateAfter: "running", impactCopy: "Resume this session" },
    ],
    override: { rootSessionId: WORKSPACE, revision: 1 },
    settlement: null,
  };
  const turn = {
    id: "5b0d6f8e-0d37-4b8f-9c43-0f1c6c1f7a01",
    workspaceId: WORKSPACE,
    sessionId: "6c1e7f9f-1e48-4c90-8d54-1f2d7d2f8b12",
    temporalWorkflowId: "turn-workflow-internal",
    status: "queued",
    source: "user",
    position: 2,
    prompt: "Hello",
    tools: [{ kind: "mcp", id: "crm" }],
    metadata: { _opengeniSiteOrigin: { siteId: WORKSPACE } },
    lineage: { parent: WORKSPACE },
    initiator: { kind: "user", subjectId: "user:someone" },
    cancelledBy: "user:someone",
    cancelReason: "internal note",
    sandboxBackend: "docker",
    version: 1,
  };

  test("queues keep the viewer's turns and control state, not the workspace behind them", () => {
    const view = siteQueueView({
      version: 7,
      effectiveControl: control,
      activePersonalConnections: [{ id: "personal" }],
      stoppingPreviousAttempt: false,
      items: [turn],
      pendingInputs: [{ id: "x", summary: "child finished in workspace" }],
      pendingInputAttachment: { turnId: turn.id, inputIds: ["x"] },
    });
    const text = JSON.stringify(view);
    for (const hidden of [WORKSPACE, "turn-workflow-internal", "user:someone", "Acme", "crm"])
      expect(text).not.toContain(hidden);
    expect(view).toMatchObject({
      version: 7,
      pendingInputs: [],
      pendingInputAttachment: null,
      items: [{ id: turn.id, prompt: "Hello", position: 2, tools: [], metadata: {} }],
      effectiveControl: {
        state: "paused",
        controlEtag: "etag-3",
        primaryBlocker: { kind: "workspace", displayName: "Workspace", actor: null, reason: null },
        resumeOptions: [{ scope: "session", impactCopy: "Resume this conversation." }],
        override: null,
      },
    });
    expect(
      siteQueueMutationView({ receipt: { id: "r", actor: "user:x" }, snapshot: {} }),
    ).toMatchObject({ receipt: { id: "r" } });
    expect(
      siteControlResultView({ receipt: { id: "r" }, effectiveControl: control, wakeCount: 1 }),
    ).toMatchObject({ wakeCount: 1, effectiveControl: { primaryBlocker: { actor: null } } });
  });

  test("drafts, accepted messages and human-input requests are text and states only", () => {
    expect(
      siteDraftView({
        revision: 2,
        text: "Draft",
        resources: [{ kind: "artifact", id: WORKSPACE }],
        annotations: [{ id: "a" }],
        model: "m",
      }),
    ).toEqual({ revision: 2, text: "Draft", model: "m", annotations: [], resources: [] });
    const accepted = siteAcceptedMessageView({
      accepted: {
        id: "e1",
        sessionId: turn.sessionId,
        sequence: 4,
        type: "user.message",
        payload: { text: "Hi", resources: [{ id: WORKSPACE }] },
        workspaceId: WORKSPACE,
      },
      turn,
      receipt: { id: "r" },
      routing: "queued_for_execution",
      interruptionCount: 0,
      replay: false,
    });
    expect(JSON.stringify(accepted)).not.toContain(WORKSPACE);
    expect(accepted).toMatchObject({
      accepted: { type: "user.message", payload: { text: "Hi" } },
      turn: { prompt: "Hello" },
      routing: "queued_for_execution",
    });
    const request = {
      id: "7d2f8a00-2f59-4da1-9e65-2a3e8e3f9c23",
      workspaceId: WORKSPACE,
      sessionId: turn.sessionId,
      turnId: turn.id,
      creationAttemptId: "attempt-internal",
      toolCallId: "call-internal",
      status: "answered",
      questions: [
        {
          id: "q",
          kind: "secret",
          prompt: "Key?",
          secret: { item: SECRET },
          skillReview: { skillId: "s" },
        },
      ],
      allowSkip: false,
      response: { answers: [{ questionId: "q", value: SECRET }] },
      respondedBy: "user:someone",
      createdAt: "2026-10-14T10:00:00.000Z",
    };
    const listed = siteHumanInputListView({ requests: [request] });
    const text = JSON.stringify(listed);
    for (const hidden of [WORKSPACE, SECRET, "attempt-internal", "call-internal", "user:someone"])
      expect(text).not.toContain(hidden);
    expect(siteHumanInputRequestView(request)).toMatchObject({
      status: "answered",
      questions: [{ id: "q", kind: "secret", prompt: "Key?" }],
      response: null,
      respondedBy: null,
    });
  });
});

describe("client address rate keys", () => {
  test("IPv6 counts per /64, IPv4 and mapped IPv4 per address", () => {
    expect(siteClientAddressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(siteClientAddressKey(" 2001:DB8:1:2:aaaa:bbbb:cccc:dddd ")).toBe("2001:db8:1:2::/64");
    expect(siteClientAddressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(siteClientAddressKey("[2001:db8:1:2:ffff::9]")).toBe("2001:db8:1:2::/64");
    expect(siteClientAddressKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(siteClientAddressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(siteClientAddressKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(siteClientAddressKey("64:ff9b::198.51.100.4")).toBe("64:ff9b:0:0::/64");
    expect(siteClientAddressKey("")).toBe("unknown");
    expect(siteClientAddressKey("not an address")).toBe("not an address");
  });
});
