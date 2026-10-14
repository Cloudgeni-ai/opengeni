import { describe, expect, test } from "bun:test";
import {
  clearCookie,
  formToken,
  humanCookie,
  loginCookie,
  mintVisitor,
  parseCookies,
  readHuman,
  readLogin,
  readSession,
  readVisitor,
  serializeCookie,
  verifyFormToken,
} from "../src/cookies";
import { TEST_SECRET } from "./helpers";

function jar(setCookie: string): Map<string, string> {
  return parseCookies(setCookie.split(";")[0]!);
}

describe("gateway cookies", () => {
  test("are host-only __Host- cookies: Secure, HttpOnly, SameSite=Lax, Path=/", async () => {
    const visitor = await mintVisitor(TEST_SECRET);
    expect(visitor.setCookie).toMatch(/^__Host-og_v=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; /u);
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"])
      expect(visitor.setCookie).toContain(attribute);
    expect(visitor.setCookie).not.toContain("Domain");
    expect(clearCookie("__Host-og_session")).toContain("Max-Age=0");
    expect(serializeCookie("__Host-x", "1", -5)).toContain("Max-Age=0");
  });

  test("visitor ids verify only with the gateway signature", async () => {
    const visitor = await mintVisitor(TEST_SECRET);
    expect(await readVisitor(TEST_SECRET, jar(visitor.setCookie))).toBe(visitor.id);
    expect(await readVisitor("another-secret-another-secret-0000", jar(visitor.setCookie))).toBe(
      null,
    );
    const value = jar(visitor.setCookie).get("__Host-og_v")!;
    const forged = `${"A".repeat(22)}${value.slice(22)}`;
    expect(await readVisitor(TEST_SECRET, new Map([["__Host-og_v", forged]]))).toBe(null);
    expect(await readVisitor(TEST_SECRET, new Map([["__Host-og_v", "plain"]]))).toBe(null);
    expect(await readVisitor(TEST_SECRET, new Map())).toBe(null);
  });

  test("login state round-trips, binds the host, and expires", async () => {
    const login = {
      state: "s".repeat(43),
      verifier: "v".repeat(43),
      returnPath: "/dash?x=1",
      host: "team-4k9x.sites.test",
      expiresAt: Date.now() + 60_000,
    };
    const cookies = jar(await loginCookie(TEST_SECRET, login));
    expect(await readLogin(TEST_SECRET, cookies)).toEqual(login);
    expect(await readLogin(TEST_SECRET, cookies, Date.now() + 120_000)).toBe(null);
    const value = cookies.get("__Host-og_login")!;
    expect(await readLogin(TEST_SECRET, new Map([["__Host-og_login", `x${value.slice(1)}`]]))).toBe(
      null,
    );
  });

  test("site sessions are opaque tokens of a safe shape", () => {
    expect(readSession(new Map([["__Host-og_session", "t".repeat(43)]]))).toBe("t".repeat(43));
    expect(readSession(new Map([["__Host-og_session", "short"]]))).toBe(null);
    expect(readSession(new Map([["__Host-og_session", `${"t".repeat(40)} x`]]))).toBe(null);
  });

  test("human proof is bound to the host and visitor and expires", async () => {
    const host = "a-site.sites.test";
    const cookies = jar(await humanCookie(TEST_SECRET, host, "visitor-a"));
    expect(await readHuman(TEST_SECRET, cookies, host, "visitor-a")).toBe(true);
    expect(await readHuman(TEST_SECRET, cookies, "A-Site.sites.test", "visitor-a")).toBe(true);
    expect(await readHuman(TEST_SECRET, cookies, "other-site.sites.test", "visitor-a")).toBe(false);
    expect(await readHuman(TEST_SECRET, cookies, host, "visitor-b")).toBe(false);
    expect(await readHuman(TEST_SECRET, cookies, host, null)).toBe(false);
    expect(
      await readHuman(TEST_SECRET, cookies, host, "visitor-a", Date.now() + 2 * 3600_000),
    ).toBe(false);
  });

  test("form tokens are bound to purpose, host and visitor", async () => {
    const token = await formToken(TEST_SECRET, "report", "a-site.sites.test", "v1");
    expect(await verifyFormToken(TEST_SECRET, "report", token, "a-site.sites.test", "v1")).toBe(
      true,
    );
    expect(await verifyFormToken(TEST_SECRET, "report", token, "b-site.sites.test", "v1")).toBe(
      false,
    );
    expect(await verifyFormToken(TEST_SECRET, "report", token, "a-site.sites.test", "v2")).toBe(
      false,
    );
    expect(await verifyFormToken(TEST_SECRET, "other", token, "a-site.sites.test", "v1")).toBe(
      false,
    );
    expect(await verifyFormToken(TEST_SECRET, "report", token, "a-site.sites.test", null)).toBe(
      false,
    );
  });

  test("parseCookies keeps the first value of a name", () => {
    expect(parseCookies("a=1; b=2; a=3").get("a")).toBe("1");
    expect(parseCookies(null).size).toBe(0);
  });
});
