// Unit tests for the NATS JWT v2 signing lib (the auth-callout cryptographic core).
// These assert the WIRE FORMAT correctness in isolation (no broker); the
// end-to-end "a real nats-server accepts these JWTs" proof is the
// selfhosted-auth-callout.integration.ts smoke. Together they cover both the
// encoding contract and the server-acceptance contract.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  decodeAuthRequest,
  mintAuthResponse,
  mintUserJwt,
  nkeys,
  workspaceAgentPermissions,
} from "../src/index";

const WS = "11111111-1111-4111-8111-111111111111";

function freshAccountSeed(): string {
  return new TextDecoder().decode(nkeys.createAccount().getSeed());
}
function freshUserPublicKey(): string {
  return nkeys.createUser().getPublicKey();
}

/** Decode the base64url payload of a JWT segment. */
function payloadOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
}
function headerOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString("utf8"));
}

describe("nats-jwt encoding", () => {
  test("a user JWT has the canonical NATS v2 header + claims shape", () => {
    const accountSeed = freshAccountSeed();
    const accountPublic = nkeys.fromSeed(Buffer.from(accountSeed)).getPublicKey();
    const userPublic = freshUserPublicKey();
    const jwt = mintUserJwt({
      userPublicKey: userPublic,
      accountSeed,
      name: "agent-x",
      permissions: workspaceAgentPermissions(WS),
      audienceAccount: "APP",
      expiresAtSeconds: 2_000_000_000,
    });

    expect(headerOf(jwt)).toEqual({ typ: "JWT", alg: "ed25519-nkey" });
    const claims = payloadOf(jwt);
    expect(claims.iss).toBe(accountPublic); // signed by the account key
    expect(claims.sub).toBe(userPublic); // scoped to the requested user nkey
    expect(claims.aud).toBe("APP"); // server-config-mode placement account
    expect(claims.exp).toBe(2_000_000_000);
    const nats = claims.nats as Record<string, unknown>;
    expect(nats.type).toBe("user");
    expect(nats.version).toBe(2);
    expect(nats.pub).toEqual({ allow: [`agent.${WS}.>`, "_INBOX.>"] });
    expect(nats.sub).toEqual({ allow: [`agent.${WS}.>`, "_INBOX.>"] });
  });

  test("the jti is the base32(SHA-512/256(claims-with-blank-jti)) NATS hash", () => {
    const accountSeed = freshAccountSeed();
    const userPublic = freshUserPublicKey();
    const jwt = mintUserJwt({
      userPublicKey: userPublic,
      accountSeed,
      name: "agent-x",
      permissions: workspaceAgentPermissions(WS),
      audienceAccount: "APP",
    });
    const claims = payloadOf(jwt);
    const jti = claims.jti as string;
    // Recompute: blank the jti, serialize, SHA-512/256, base32 (no padding).
    const withBlank = JSON.stringify({ ...claims, jti: "" });
    const digest = createHash("sha512-256").update(withBlank, "utf8").digest();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0;
    let value = 0;
    let expected = "";
    for (const byte of digest) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        expected += alphabet[(value >>> bits) & 31];
      }
    }
    if (bits > 0) {
      expected += alphabet[(value << (5 - bits)) & 31];
    }
    expect(jti).toBe(expected);
    expect(jti.length).toBeGreaterThan(0);
  });

  test("the user JWT signature verifies under the account key", () => {
    const account = nkeys.createAccount();
    const accountSeed = new TextDecoder().decode(account.getSeed());
    const jwt = mintUserJwt({
      userPublicKey: freshUserPublicKey(),
      accountSeed,
      name: "agent-x",
      permissions: workspaceAgentPermissions(WS),
      audienceAccount: "APP",
    });
    const [header, payload, signature] = jwt.split(".");
    const signingInput = Buffer.from(`${header}.${payload}`, "utf8");
    const sig = Buffer.from(signature!, "base64url");
    expect(account.verify(signingInput, sig)).toBe(true);
    // A tampered payload must NOT verify.
    const tampered = Buffer.from(`${header}.${payload}x`, "utf8");
    expect(account.verify(tampered, sig)).toBe(false);
  });

  test("an authorization response carries aud=serverId and embeds the user JWT", () => {
    const accountSeed = freshAccountSeed();
    const userPublic = freshUserPublicKey();
    const userJwt = mintUserJwt({
      userPublicKey: userPublic,
      accountSeed,
      name: "agent-x",
      permissions: workspaceAgentPermissions(WS),
      audienceAccount: "APP",
    });
    const response = mintAuthResponse({
      userPublicKey: userPublic,
      serverId: "NSERVERID",
      accountSeed,
      userJwt,
    });
    const claims = payloadOf(response);
    expect(claims.aud).toBe("NSERVERID"); // the response audience is the server id
    expect(claims.sub).toBe(userPublic);
    const nats = claims.nats as Record<string, unknown>;
    expect(nats.type).toBe("authorization_response");
    expect(nats.jwt).toBe(userJwt);
    expect(nats.error).toBeUndefined();
  });

  test("a denial response carries nats.error and NO user JWT", () => {
    const accountSeed = freshAccountSeed();
    const userPublic = freshUserPublicKey();
    const response = mintAuthResponse({
      userPublicKey: userPublic,
      serverId: "NSERVERID",
      accountSeed,
      error: "invalid or expired enrollment bearer",
    });
    const nats = payloadOf(response).nats as Record<string, unknown>;
    expect(nats.error).toBe("invalid or expired enrollment bearer");
    expect(nats.jwt).toBeUndefined();
  });
});

describe("decodeAuthRequest", () => {
  test("extracts the user_nkey, server_id, and connect auth_token", () => {
    // Build a request-shaped JWT payload (only the payload matters to decode).
    const reqPayload = {
      nats: {
        user_nkey: "UABCDEF",
        server_id: { id: "NSERVER" },
        connect_opts: { auth_token: "oge_thebearer", user: "agentuser" },
      },
    };
    const fakeJwt = `h.${Buffer.from(JSON.stringify(reqPayload)).toString("base64url")}.s`;
    const decoded = decodeAuthRequest(fakeJwt);
    expect(decoded).not.toBeNull();
    expect(decoded!.userNkey).toBe("UABCDEF");
    expect(decoded!.serverId).toBe("NSERVER");
    expect(decoded!.authToken).toBe("oge_thebearer");
    expect(decoded!.user).toBe("agentuser");
  });

  test("returns null for a malformed token (no nats block / wrong segment count)", () => {
    expect(decodeAuthRequest("not-a-jwt")).toBeNull();
    const noNats = `h.${Buffer.from(JSON.stringify({ foo: 1 })).toString("base64url")}.s`;
    expect(decodeAuthRequest(noNats)).toBeNull();
  });
});

describe("workspaceAgentPermissions", () => {
  test("scopes pub+sub to ONLY agent.<ws>.> and _INBOX.> (the isolation boundary)", () => {
    const perms = workspaceAgentPermissions(WS);
    expect(perms.pub.allow).toEqual([`agent.${WS}.>`, "_INBOX.>"]);
    expect(perms.sub.allow).toEqual([`agent.${WS}.>`, "_INBOX.>"]);
    // No deny entries needed: an allow-list IS deny-all-else. Crucially, a DIFFERENT
    // workspace's subtree is NOT in the allow list.
    const other = "22222222-2222-4222-8222-222222222222";
    expect(perms.pub.allow).not.toContain(`agent.${other}.>`);
  });
});
