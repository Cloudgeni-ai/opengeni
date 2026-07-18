// M-AUTH — unit tests for the auth-callout DECISION logic (validate → scoped-JWT /
// deny), in isolation from the NATS transport + a real broker. The "a real
// nats-server accepts the grant and enforces the isolation" proof is the
// test/integration/selfhosted-auth-callout.integration.ts smoke; here we assert the
// PURE decision: a valid+active bearer grants a workspace-scoped user JWT, every
// failure mode produces a SIGNED denial (never a throw, never a grant).

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { signEnrollmentBearer } from "@opengeni/contracts";
import { decodeAuthRequest, mintAuthResponse, nkeys } from "@opengeni/events";

const SECRET = "test-enrollment-signing-secret";
const WS = "11111111-1111-4111-8111-111111111111";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// The active-enrollment registry the mocked getEnrollment resolves against.
const active = new Map<string, number>([[`${WS}:${AGENT}`, 1]]);

// `bun test` runs EVERY test file in ONE shared process, and a top-level
// `mock.module` replaces a module process-globally for the WHOLE run — it is
// installed during the collection phase, so it is live even while OTHER files'
// tests execute (regardless of file order), and `mock.restore()` in afterAll
// only helps files that run strictly after this one finishes. `@opengeni/db` is
// imported by nearly every test file (the BYO sandbox tests read enrollments
// through the real DAOs), so a naive whole-module replacement poisons them.
//
// To stay a good citizen this mock therefore: (a) spreads every real export so
// nothing becomes `undefined`, and (b) makes `getEnrollment` override ONLY this
// file's synthetic test workspace (`WS`) — any other workspace falls through to
// the REAL getEnrollment against that caller's real DB. That keeps the BYO
// tests correct even while this mock is installed. afterAll still restores the
// module for cleanliness.
const realDb = await import("@opengeni/db");
// Capture the REAL getEnrollment into a stable local BEFORE installing the mock.
// The `realDb` namespace is a live binding, so after mock.module replaces the
// module `realDb.getEnrollment` would resolve back to the stub — capturing it
// here avoids infinite self-delegation.
const realGetEnrollment = realDb.getEnrollment;
mock.module("@opengeni/db", () => ({
  ...realDb,
  getEnrollment: async (db: never, workspaceId: string, enrollmentId: string) => {
    // Only intercept this test's synthetic workspace; everyone else gets the
    // real DAO so unrelated, process-shared test files are unaffected.
    if (workspaceId !== WS) {
      return realGetEnrollment(db, workspaceId, enrollmentId);
    }
    const credentialGeneration = active.get(`${workspaceId}:${enrollmentId}`);
    return credentialGeneration === undefined
      ? null
      : ({
          id: enrollmentId,
          workspaceId,
          status: "active",
          credentialGeneration,
        } as never);
  },
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
  active.set(`${WS}:${AGENT}`, 1);
});

// Restore the REAL @opengeni/db so other files in this shared `bun test` process
// (notably the BYO sandbox tests that read enrollments through the real DAOs)
// are not poisoned by the getEnrollment stub above.
afterAll(() => {
  mock.restore();
});

describe("handleAuthorizationRequest", () => {
  test("a valid + active bearer GRANTS a workspace-scoped user JWT", async () => {
    const bearerExp = Math.floor(Date.now() / 1000) + 3600;
    const bearer = await signEnrollmentBearer(SECRET, {
      workspaceId: WS,
      agentId: AGENT,
      enrollmentId: AGENT,
      credentialGeneration: 1,
      subjectPrefix: `agent.${WS}.${AGENT}`,
      exp: bearerExp,
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
    const now = Math.floor(Date.now() / 1000);
    expect(userClaims.exp).toBeGreaterThan(now);
    expect(userClaims.exp).toBeLessThanOrEqual(bearerExp);
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
      credentialGeneration: 1,
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
      credentialGeneration: 1,
      subjectPrefix: `agent.${WS}.${AGENT}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const out = await handleAuthorizationRequest(deps(), authRequest(bearer));
    const res = readResponse(out);
    expect(res.granted).toBe(false);
    expect(res.error).toMatch(/not active/i);
  });

  test("an old bearer is denied after the enrollment generation advances", async () => {
    active.set(`${WS}:${AGENT}`, 2);
    const oldBearer = await signEnrollmentBearer(SECRET, {
      workspaceId: WS,
      agentId: AGENT,
      enrollmentId: AGENT,
      credentialGeneration: 1,
      subjectPrefix: `agent.${WS}.${AGENT}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = readResponse(await handleAuthorizationRequest(deps(), authRequest(oldBearer)));
    expect(res.granted).toBe(false);
    expect(res.error).toMatch(/generation/i);
  });

  test("the user JWT never outlives a sooner bearer expiration", async () => {
    const bearerExp = Math.floor(Date.now() / 1000) + 30;
    const bearer = await signEnrollmentBearer(SECRET, {
      workspaceId: WS,
      agentId: AGENT,
      enrollmentId: AGENT,
      credentialGeneration: 1,
      subjectPrefix: `agent.${WS}.${AGENT}`,
      exp: bearerExp,
    });
    const res = readResponse(await handleAuthorizationRequest(deps(), authRequest(bearer)));
    const userClaims = JSON.parse(
      Buffer.from(res.userJwt!.split(".")[1]!, "base64url").toString("utf8"),
    );
    expect(userClaims.exp).toBe(bearerExp);
  });

  test("a denial response is still a SIGNED, server-addressed auth response", async () => {
    const out = await handleAuthorizationRequest(deps(), authRequest(undefined));
    const claims = JSON.parse(
      Buffer.from(Buffer.from(out).toString("utf8").split(".")[1]!, "base64url").toString(),
    );
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
