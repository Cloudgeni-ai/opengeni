import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getManagedSession } from "../src/managed-session";

describe("getManagedSession", () => {
  test("requests and forwards every Better Auth session renewal cookie", async () => {
    const renewedSession = "better-auth.session_token=renewed; Path=/; HttpOnly";
    const refreshedCache =
      "better-auth.session_data=refreshed; Expires=Wed, 12 Aug 2026 12:00:00 GMT; Path=/; HttpOnly";
    let receivedHeaders: Headers | undefined;
    let returnHeaders: boolean | undefined;
    const auth = {
      api: {
        getSession: async (input: { headers: Headers; returnHeaders?: boolean }) => {
          receivedHeaders = input.headers;
          returnHeaders = input.returnHeaders;
          const headers = new Headers();
          headers.append("set-cookie", renewedSession);
          headers.append("set-cookie", refreshedCache);
          return {
            headers,
            response: {
              session: { id: "session-1" },
              user: { id: "user-1" },
            },
          };
        },
      },
    };
    const app = new Hono().get("/", async (c) => {
      const session = await getManagedSession(c, auth as never);
      return c.json({ userId: session?.user.id });
    });

    const response = await app.request("/", {
      headers: { cookie: "better-auth.session_token=original" },
    });

    expect(response.status).toBe(200);
    expect(returnHeaders).toBe(true);
    expect(receivedHeaders?.get("cookie")).toBe("better-auth.session_token=original");
    expect(response.headers.getSetCookie()).toEqual([renewedSession, refreshedCache]);
    expect(await response.json()).toEqual({ userId: "user-1" });
  });

  test("does not invent a cookie when Better Auth does not refresh the session", async () => {
    const auth = {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: null,
        }),
      },
    };
    const app = new Hono().get("/", async (c) => {
      const session = await getManagedSession(c, auth as never);
      return c.json({ authenticated: session !== null });
    });

    const response = await app.request("/");

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ authenticated: false });
  });
});
