// M-AUTH — unit tests for the auth-callout DECISION logic (validate → scoped-JWT /
// deny), in isolation from the NATS transport + a real broker. The "a real
// nats-server accepts the grant and enforces the isolation" proof is the
// test/integration/selfhosted-auth-callout.integration.ts smoke; here we assert the
// PURE decision: a valid+active bearer grants a workspace-scoped user JWT, every
// failure mode produces a SIGNED denial (never a throw, never a grant).

import { afterEach, describe, expect, mock, test } from "bun:test";
import { signEnrollmentBearer } from "@opengeni/contracts";
import { decodeAuthRequest, mintAuthResponse, nkeys } from "@opengeni/events";

const SECRET = "test-enrollment-signing-secret";
const WS = "11111111-1111-4111-8111-111111111111";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// The active-enrollment registry the mocked getEnrollment resolves against.
const active = new Set<string>([`${WS}:${AGENT}`]);
mock.module("@opengeni/db", () => ({
  getEnrollment: async (_db: unknown, workspaceId: string, enrollmentId: string) =>
    active.has(`${workspaceId}:${enrollmentId}`)
      ? { id: enrollmentId, workspaceId, status: "active" }
      : null,
}));

// Imported AFTER the db mock so the responder binds the mocked getEnrollment.
const { handleAuthorizationRequest } = await import("../src/sandbox/auth-callout");

const account = nkeys.createAccount();
const ACCOUNT_SEED = new TextDecoder().decode(account.getSeed());

function deps() {
  return {
    db: {} as never,
    settings: { enrollmentSigningSecret: SECRET } as never,
    callout: { accountSeed: ACCOUNT_SEED, accountName: "APP", user: "auth", password: "p" },
  };
}

/** Build a synthetic authorization-REQUEST JWT (only the payload is decoded). */
function authRequest(authToken: string | undefined): Uint8Array {
  const userNkey = nkeys.createUser().getPublicKey();
  const payload = {
    nats: {
      user_nkey: userNkey,
      server_id: { id: "NSERVERID" },
      connect_opts: authToken ? { auth_token: authToken } : {},
    },
  };
  const jwt = `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  return Buffer.from(jwt, "utf8");
}

/** Decode the response the responder returned + report grant/deny + the user JWT. */
function readResponse(bytes: Uint8Array): { granted: boolean; error?: string; userJwt?: string } {
  const jwt = Buffer.from(bytes).toString("utf8");
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
  const nats = claims.nats as { jwt?: string; error?: string };
  return { granted: Boolean(nats.jwt), error: nats.error, userJwt: nats.jwt };
}

afterEach(() => {
  active.clear();
  active.add(`${WS}:${AGENT}`);
});

describe("handleAuthorizationRequest", () => {
  test("a valid + active bearer GRANTS a workspace-scoped user JWT", async () => {
    const bearer = await signEnrollmentBearer(SECRET, {
      workspaceId: WS,
      agentId: AGENT,
      enrollmentId: AGENT,
      subjectPrefix: `agent.${WS}.${AGENT}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const out = await handleAuthorizationRequest(deps(), authRequest(bearer));
    const res = readResponse(out);
    expect(res.granted).toBe(true);
    // The minted user JWT scopes pub/sub to ONLY this workspace's subtree.
    const userClaims = JSON.parse(
      Buffer.from(res.userJwt!.split(".")[1]!, "base64url").toString("utf8"),
    );
    expect(userClaims.nats.pub.allow).toEqual([`agent.${WS}.>`, "_INBOX.>"]);
    expect(userClaims.nats.sub.allow).toEqual([`agent.${WS}.>`, "_INBOX.>"]);
    expect(userClaims.aud).toBe("APP");
  });

  test("a MISSING bearer is denied", async () => {
    const out = await handleAuthorizationRequest(deps(), authRequest(undefined));
    const res = readResponse(out);
    expect(res.granted).toBe(false);
    expect(res.error).toMatch(/missing/i);
  });

  test("an INVALID bearer (bad signature) is denied", async () => {
    const out = await handleAuthorizationRequest(deps(), authRequest("oge_garbage.sig"));
    const res = readResponse(out);
    expect(res.granted).toBe(false);
    expect(res.error).toMatch(/invalid|expired/i);
  });

  test("an EXPIRED bearer is denied", async () => {
    const expired = await signEnrollmentBearer(SECRET, {
      workspaceId: WS,
      agentId: AGENT,
      enrollmentId: AGENT,
      subjectPrefix: `agent.${WS}.${AGENT}`,
      exp: Math.floor(Date.now() / 1000) - 10, // already past
    });
    const out = await handleAuthorizationRequest(deps(), authRequest(expired));
    const res = readResponse(out);
    expect(res.granted).toBe(false);
    expect(res.error).toMatch(/invalid|expired/i);
  });

  test("a REVOKED enrollment (not active) is denied even with a valid bearer", async () => {
    active.delete(`${WS}:${AGENT}`); // revoke
    const bearer = await signEnrollmentBearer(SECRET, {
      workspaceId: WS,
      agentId: AGENT,
      enrollmentId: AGENT,
      subjectPrefix: `agent.${WS}.${AGENT}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const out = await handleAuthorizationRequest(deps(), authRequest(bearer));
    const res = readResponse(out);
    expect(res.granted).toBe(false);
    expect(res.error).toMatch(/not active/i);
  });

  test("a denial response is still a SIGNED, server-addressed auth response", async () => {
    const out = await handleAuthorizationRequest(deps(), authRequest(undefined));
    const claims = JSON.parse(Buffer.from(Buffer.from(out).toString("utf8").split(".")[1]!, "base64url").toString());
    expect(claims.aud).toBe("NSERVERID"); // addressed to the requesting server
    expect(claims.iss).toBe(account.getPublicKey()); // signed by the callout account
  });

  test("an undecodable request throws (left unanswered → server denies on timeout)", async () => {
    expect(handleAuthorizationRequest(deps(), Buffer.from("not-a-jwt"))).rejects.toThrow();
  });

  // Sanity: the helpers used above behave (guards the test's own assumptions).
  test("the test's request encoder round-trips through decodeAuthRequest", () => {
    const decoded = decodeAuthRequest(Buffer.from(authRequest("oge_x")).toString("utf8"));
    expect(decoded?.authToken).toBe("oge_x");
    expect(decoded?.serverId).toBe("NSERVERID");
    // And mintAuthResponse is importable (the responder's dependency).
    expect(typeof mintAuthResponse).toBe("function");
  });
});
