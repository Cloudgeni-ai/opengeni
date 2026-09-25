import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  apiRequestBindingsForTransportPeer,
  replaceTrustedClientAddressHeader,
  TRUSTED_CLIENT_ADDRESS_HEADER,
  trustedRequestSourceAddress,
} from "../src/http/request-source";

async function resolve(
  trustedProxyHops: number,
  input: { peer?: string | null; forwardedFor?: string; cidrs?: string },
): Promise<string> {
  const app = new Hono();
  app.get("/", (c) =>
    c.text(
      trustedRequestSourceAddress(c, {
        apiTrustedProxyHops: trustedProxyHops,
        apiTrustedProxyCidrs: input.cidrs ?? "",
      }),
    ),
  );
  const response = await app.request(
    "/",
    {
      headers: input.forwardedFor === undefined ? {} : { "x-forwarded-for": input.forwardedFor },
    },
    input.peer === undefined ? undefined : apiRequestBindingsForTransportPeer(input.peer),
  );
  return await response.text();
}

describe("trusted request source address", () => {
  test("uses the transport peer and ignores forwarding headers by default", async () => {
    expect(await resolve(0, { peer: "10.0.0.10", forwardedFor: "203.0.113.7" })).toBe("10.0.0.10");
  });

  test("walks a declared proxy chain from the server side", async () => {
    expect(await resolve(1, { peer: "10.0.0.10", forwardedFor: "203.0.113.7" })).toBe(
      "203.0.113.7",
    );
    // A caller-prepended value never displaces the address the edge observed.
    expect(await resolve(1, { peer: "10.0.0.10", forwardedFor: "198.51.100.1, 203.0.113.7" })).toBe(
      "203.0.113.7",
    );
    expect(
      await resolve(2, {
        peer: "10.0.0.10",
        forwardedFor: "198.51.100.1, 203.0.113.7, 10.0.0.9",
      }),
    ).toBe("203.0.113.7");
  });

  test("falls back to the transport peer for a missing, short, or malformed chain", async () => {
    expect(await resolve(1, { peer: "10.0.0.10" })).toBe("10.0.0.10");
    expect(await resolve(2, { peer: "10.0.0.10", forwardedFor: "203.0.113.7" })).toBe("10.0.0.10");
    expect(await resolve(1, { peer: "10.0.0.10", forwardedFor: "not-an-address" })).toBe(
      "10.0.0.10",
    );
    // An empty entry keeps its position instead of shifting a spoofed value in.
    expect(await resolve(1, { peer: "10.0.0.10", forwardedFor: "198.51.100.1," })).toBe(
      "10.0.0.10",
    );
  });

  test("normalizes the address forms load balancers write", async () => {
    expect(await resolve(1, { peer: "10.0.0.10", forwardedFor: "203.0.113.7:51234" })).toBe(
      "203.0.113.7",
    );
    expect(await resolve(1, { peer: "10.0.0.10", forwardedFor: "[2001:DB8::1]:443" })).toBe(
      "2001:db8::1",
    );
    expect(await resolve(0, { peer: "::ffff:10.0.0.10" })).toBe("::ffff:10.0.0.10");
  });

  test("honors forwarding headers only from a declared proxy range", async () => {
    const cidrs = "10.224.0.0/16, 2001:db8::/32";
    expect(await resolve(1, { peer: "10.224.3.4", forwardedFor: "203.0.113.7", cidrs })).toBe(
      "203.0.113.7",
    );
    expect(
      await resolve(1, { peer: "::ffff:10.224.3.4", forwardedFor: "203.0.113.7", cidrs }),
    ).toBe("203.0.113.7");
    expect(await resolve(1, { peer: "2001:db8::5", forwardedFor: "203.0.113.7", cidrs })).toBe(
      "203.0.113.7",
    );
    expect(await resolve(1, { peer: "192.0.2.10", forwardedFor: "203.0.113.7", cidrs })).toBe(
      "192.0.2.10",
    );
  });

  test("never trusts forwarding headers without a server-owned transport peer", async () => {
    expect(await resolve(1, { forwardedFor: "203.0.113.7" })).toBe("unknown");
    expect(await resolve(1, { peer: null, forwardedFor: "203.0.113.7" })).toBe("unknown");
  });
});

describe("trusted client address header", () => {
  async function stamped(input: {
    path: string;
    stamp: boolean;
    peer?: string;
    supplied?: string;
    forwardedFor?: string;
  }): Promise<string | null> {
    const app = new Hono();
    app.use("*", async (c, next) => {
      replaceTrustedClientAddressHeader(
        c,
        { apiTrustedProxyHops: 1, apiTrustedProxyCidrs: "" },
        input.stamp,
      );
      await next();
    });
    app.all("*", (c) =>
      c.json({ value: new Request(c.req.raw).headers.get(TRUSTED_CLIENT_ADDRESS_HEADER) }),
    );
    const headers: Record<string, string> = {};
    if (input.supplied) headers[TRUSTED_CLIENT_ADDRESS_HEADER] = input.supplied;
    if (input.forwardedFor) headers["x-forwarded-for"] = input.forwardedFor;
    const response = await app.request(
      input.path,
      { headers },
      input.peer ? apiRequestBindingsForTransportPeer(input.peer) : undefined,
    );
    return ((await response.json()) as { value: string | null }).value;
  }

  test("replaces a caller-supplied value with the trusted source address", async () => {
    expect(
      await stamped({
        path: "/v1/auth/sign-in/email",
        stamp: true,
        peer: "10.0.0.10",
        supplied: "192.0.2.55",
        forwardedFor: "203.0.113.7",
      }),
    ).toBe("203.0.113.7");
  });

  test("strips a caller-supplied value when not stamping or without a peer", async () => {
    expect(
      await stamped({
        path: "/v1/sessions",
        stamp: false,
        peer: "10.0.0.10",
        supplied: "192.0.2.55",
      }),
    ).toBeNull();
    expect(
      await stamped({ path: "/v1/auth/sign-in/email", stamp: true, supplied: "192.0.2.55" }),
    ).toBeNull();
  });
});
