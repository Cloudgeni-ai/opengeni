import { expect, test } from "bun:test";
import { Hono } from "hono";
import { configureManagedUserAdmission } from "@opengeni/core";
import {
  createBetterAuthSessionAdapter,
  managedAuthSelectedProofHeaders,
} from "../src/auth/managed-auth-session-adapter";
import { registerManagedAuthSessionSetRoutes } from "../src/routes/managed-auth-session-sets";

function fixture(email: string) {
  const session = {
    session: { id: "existing", expiresAt: new Date(Date.now() + 60000) },
    user: { id: "user", email, emailVerified: true },
  };
  const auth = {
    $context: Promise.resolve({
      secret: "test-signing-secret",
      authCookies: { sessionToken: { name: "session" } },
      internalAdapter: { findSession: async () => session },
    }),
    api: { getSession: async () => ({ headers: new Headers(), response: session }) },
    handler: async () => {
      throw new Error("must not bypass admission");
    },
  };
  configureManagedUserAdmission(auth as never, ["staff@example.com"]);
  return { auth, session };
}

for (const email of ["staff@example.com", "outsider@example.com"]) {
  test(`legacy HTTP session admission: ${email}`, async () => {
    const { auth } = fixture(email);
    const app = new Hono();
    registerManagedAuthSessionSetRoutes(app, {
      settings: { managedAuthSessionSetMode: "legacy", allowedUserEmails: ["staff@example.com"] },
      managedAuth: auth,
      db: { execute: async () => [{ valid: true }] },
    } as never);
    const response = await app.request("/v1/auth/get-session");
    expect(response.status).toBe(email.startsWith("staff") ? 200 : 403);
  });

  test(`broker/dual adapter admission: ${email}`, async () => {
    const { auth, session } = fixture(email);
    const adapter = createBetterAuthSessionAdapter(auth as never, {} as never);
    const headers = await managedAuthSelectedProofHeaders(auth as never, "token");
    const selected = { token: "token" } as never;
    for (const resolve of [
      () => adapter.resolveAmbientSession(headers),
      () => adapter.resolveSelectedSession(selected),
      () => adapter.refreshSelectedSession(selected),
    ]) {
      if (email.startsWith("staff")) expect(await resolve()).toEqual(session);
      else await expect(resolve()).rejects.toThrow("Account is not permitted");
    }
  });
}
