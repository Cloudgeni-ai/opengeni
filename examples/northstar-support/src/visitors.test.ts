import { describe, expect, test } from "bun:test";

import { SessionOwners, VisitorCookies, sameOriginRequest } from "./visitors";

const HTTPS_ORIGIN = "https://demo.example.test";
const HTTP_ORIGIN = "http://127.0.0.1:3101";

function withCookie(url: string, cookie: string): Request {
  return new Request(url, { headers: { cookie } });
}

/** The `name=value` pair of a Set-Cookie header. */
function pair(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

describe("VisitorCookies", () => {
  test("issues an opaque, HMAC-signed, HttpOnly SameSite=Lax cookie", () => {
    const cookies = new VisitorCookies(HTTP_ORIGIN);
    const issued = cookies.issue(new Request(`${HTTP_ORIGIN}/api/demo/state`));
    expect(issued.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(issued.setCookie).toMatch(
      /^northstar_visitor=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    // A session cookie: no persistence beyond the browser session.
    expect(issued.setCookie).not.toMatch(/Max-Age|Expires/i);
    expect(cookies.read(withCookie(`${HTTP_ORIGIN}/api/demo/state`, pair(issued.setCookie)))).toBe(
      issued.id,
    );
    expect(cookies.issue(new Request(`${HTTP_ORIGIN}/`)).id).not.toBe(issued.id);
  });

  test("uses a Secure __Host- cookie when the origin or the request is https", () => {
    const secureOrigin = new VisitorCookies(HTTPS_ORIGIN);
    // Behind TLS termination the pod sees http; the configured origin decides.
    const behindProxy = secureOrigin.issue(new Request("http://10.0.0.7:8080/api/demo/state"));
    expect(behindProxy.setCookie).toMatch(
      /^__Host-northstar_visitor=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(
      secureOrigin.read(
        withCookie("http://10.0.0.7:8080/api/demo/state", pair(behindProxy.setCookie)),
      ),
    ).toBe(behindProxy.id);

    const directTls = new VisitorCookies(HTTP_ORIGIN).issue(
      new Request(`${HTTPS_ORIGIN}/api/demo/state`),
    );
    expect(directTls.setCookie).toContain("__Host-northstar_visitor=");
    expect(directTls.setCookie).toEndWith("; Secure");
  });

  test("rejects missing, malformed, tampered, and foreign-process cookies", () => {
    const cookies = new VisitorCookies(HTTP_ORIGIN);
    const url = `${HTTP_ORIGIN}/api/demo/state`;
    const issued = cookies.issue(new Request(url));
    const [name, value] = pair(issued.setCookie).split("=") as [string, string];
    const [id, mac] = value.split(".") as [string, string];

    expect(cookies.read(new Request(url))).toBeNull();
    expect(cookies.read(withCookie(url, `${name}=${id}`))).toBeNull();
    expect(cookies.read(withCookie(url, `${name}=${id}.${mac}.extra`))).toBeNull();
    expect(cookies.read(withCookie(url, `${name}=${id}.${mac.slice(0, -1)}A`))).toBeNull();
    // A different id cannot reuse another visitor's signature.
    const other = cookies.issue(new Request(url));
    expect(cookies.read(withCookie(url, `${name}=${other.id}.${mac}`))).toBeNull();
    // Keys are random per process: a restarted server starts every visitor over.
    expect(new VisitorCookies(HTTP_ORIGIN).read(withCookie(url, `${name}=${value}`))).toBeNull();
    // An https deployment ignores a non-__Host- cookie, for example one a
    // sibling subdomain set for the whole site.
    expect(
      new VisitorCookies(HTTPS_ORIGIN).read(withCookie(`${HTTPS_ORIGIN}/`, `${name}=${value}`)),
    ).toBeNull();
    // Other cookies around it are ignored.
    expect(cookies.read(withCookie(url, `theme=dark; ${name}=${value}; other=1`))).toBe(id);
  });
});

describe("SessionOwners", () => {
  test("grants a session only to the visitor that created it", () => {
    const owners = new SessionOwners();
    expect(owners.claim("session-1", "visitor-a")).toBe(true);
    expect(owners.owns("session-1", "visitor-a")).toBe(true);
    expect(owners.owns("session-1", "visitor-b")).toBe(false);
    expect(owners.owns("session-1", null)).toBe(false);
    expect(owners.owns("session-unknown", "visitor-a")).toBe(false);
    // An idempotent replay for the creator is fine; another visitor cannot take it over.
    expect(owners.claim("session-1", "visitor-a")).toBe(true);
    expect(owners.claim("session-1", "visitor-b")).toBe(false);
    expect(owners.owns("session-1", "visitor-a")).toBe(true);
  });

  test("forgets the oldest sessions first once full", () => {
    const owners = new SessionOwners(2);
    owners.claim("session-1", "visitor-a");
    owners.claim("session-2", "visitor-a");
    owners.claim("session-3", "visitor-a");
    expect(owners.owns("session-1", "visitor-a")).toBe(false);
    expect(owners.owns("session-2", "visitor-a")).toBe(true);
    expect(owners.owns("session-3", "visitor-a")).toBe(true);
  });
});

describe("sameOriginRequest", () => {
  test("accepts same-origin browsers and non-browser clients only", () => {
    const request = (site?: string) =>
      new Request(`${HTTPS_ORIGIN}/api/demo/reset`, {
        method: "POST",
        headers: site ? { "sec-fetch-site": site } : {},
      });
    expect(sameOriginRequest(request())).toBe(true);
    expect(sameOriginRequest(request("same-origin"))).toBe(true);
    expect(sameOriginRequest(request("none"))).toBe(true);
    expect(sameOriginRequest(request("same-site"))).toBe(false);
    expect(sameOriginRequest(request("cross-site"))).toBe(false);
  });
});
