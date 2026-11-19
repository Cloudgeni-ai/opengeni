import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  OPENGENI_WEBHOOK_HEADERS,
  OpenGeniClient,
  signOpenGeniPayload,
  verifyCredentialProviderRequest,
  verifyWebhookEvent,
  type CreateSessionRequest,
} from "../src/index";
import { WORKSPACE_ID } from "./helpers";

/**
 * Compatibility contract for Console agents: what CloudGeni, Kontali and other
 * embedding hosts send and receive through the SDK must not change. The
 * fixtures are shared with packages/contracts/test/session-compat-fixtures and
 * were recorded on main (see their `recordedFrom`).
 */
type FixtureCase = { name: string; input: Record<string, unknown>; parsed: unknown };
function fixture(name: string): FixtureCase[] {
  const path = new URL(
    `../../contracts/test/fixtures/session-compat/${name}.json`,
    import.meta.url,
  );
  return (JSON.parse(readFileSync(path, "utf8")) as { cases: FixtureCase[] }).cases;
}

describe("SDK wire compatibility (recorded on main)", () => {
  test("createSession sends today's requests unchanged", async () => {
    for (const fixtureCase of fixture("create-session-requests")) {
      const sent: unknown[] = [];
      const client = new OpenGeniClient({
        baseUrl: "https://api.example.test",
        apiKey: "og_key",
        messageTimeZone: false,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          sent.push(JSON.parse(await request.text()));
          return Response.json({ id: "33333333-3333-4333-8333-333333333333" }, { status: 201 });
        },
      });
      await client
        .createSession(WORKSPACE_ID, fixtureCase.input as unknown as CreateSessionRequest)
        .catch(() => undefined);
      expect({ name: fixtureCase.name, sent }).toEqual({
        name: fixtureCase.name,
        sent: [fixtureCase.input],
      });
    }
  });

  test("verifyWebhookEvent returns today's workspace and organization events unchanged", async () => {
    const secret = "whsec_compat";
    for (const fixtureCase of fixture("webhook-events")) {
      const body = JSON.stringify(fixtureCase.input);
      const { event } = await verifyWebhookEvent({
        body,
        secret,
        headers: { [OPENGENI_WEBHOOK_HEADERS.signature]: await signOpenGeniPayload(secret, body) },
      });
      expect({ name: fixtureCase.name, event }).toEqual({
        name: fixtureCase.name,
        event: { ...fixtureCase.input, lane: fixtureCase.input.lane ?? "workspace" } as never,
      });
    }
  });

  test("verifyCredentialProviderRequest returns today's credentials.request body unchanged", async () => {
    const secret = "cpsec_compat";
    // The body the worker sends (apps/worker credentialProviderRequestBody), as on main.
    const request = {
      type: "credentials.request",
      lane: "organization",
      mcpServers: [{ id: "cloudgeni-capability", url: "https://cloudgeni.example/mcp" }],
      purpose: "provision",
      forceRefresh: false,
      accountId: "acct_1",
      workspaceId: WORKSPACE_ID,
      sessionId: "22222222-2222-4222-8222-222222222222",
      rootSessionId: "22222222-2222-4222-8222-222222222222",
      parentSessionId: null,
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      initiator: { kind: "subject", subjectId: "external_user:cg-user-1" },
      initiatorContext: {
        kind: "human",
        initiator: { kind: "subject", subjectId: "external_user:cg-user-1" },
        context: {},
      },
      initiatingHumanSubjectId: "external_user:cg-user-1",
      initiatingHuman: {
        subjectId: "external_user:cg-user-1",
        externalIdentity: { source: "cloudgeni", externalUserId: "cg-user-1" },
      },
      sandboxBackend: "modal",
      sandboxOs: "linux",
    };
    const body = JSON.stringify(request);
    const verified = await verifyCredentialProviderRequest({
      body,
      secret,
      headers: { [OPENGENI_WEBHOOK_HEADERS.signature]: await signOpenGeniPayload(secret, body) },
    });
    expect(verified).toEqual(request as never);
  });
});
