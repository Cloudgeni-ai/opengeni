import { beforeEach, expect, test } from "bun:test";

import {
  disposableMailProviders,
  isDisposableMailHost,
  resetSignupMailMxCache,
  signupMailSignal,
  type MxResolver,
} from "./signup-mail";

const settings = { signupDisposableMailDomains: "", signupMailMxLookupTimeoutMs: 200 };
const mx =
  (hosts: Record<string, string[]>, calls: string[] = []): MxResolver =>
  async (domain) => {
    calls.push(domain);
    const exchanges = hosts[domain];
    if (!exchanges) throw Object.assign(new Error("no MX"), { code: "ENODATA" });
    return exchanges.map((exchange) => ({ exchange }));
  };

beforeEach(() => resetSignupMailMxCache());

test("a listed domain or a subdomain of one is disposable without a lookup", async () => {
  const calls: string[] = [];
  expect(await signupMailSignal("a@mailinator.com", settings, mx({}, calls))).toBe("disposable");
  expect(await signupMailSignal("a@inbox.yopmail.com", settings, mx({}, calls))).toBe("disposable");
  expect(calls).toEqual([]);
  const providers = disposableMailProviders(settings);
  expect(isDisposableMailHost("Mail.Guerrillamail.com.", providers)).toBe(true);
  expect(isDisposableMailHost("notmailinator.com", providers)).toBe(false);
});

test("a custom domain whose MX is a temporary-inbox host is disposable; ordinary MX is clear", async () => {
  const resolver = mx({
    "farm-domain.example": ["email.chatgpt.org.uk"],
    "acme-robotics.io": ["aspmx.l.google.com", "alt1.aspmx.l.google.com"],
  });
  expect(await signupMailSignal("x.abc12@farm-domain.example", settings, resolver)).toBe(
    "disposable",
  );
  expect(await signupMailSignal("ceo@acme-robotics.io", settings, resolver)).toBe("clear");
  // No MX record is an answer: nothing listed.
  expect(await signupMailSignal("a@no-mx.example", settings, resolver)).toBe("clear");
});

test("operators add providers; answers are cached", async () => {
  const calls: string[] = [];
  const resolver = mx({ "custom.example": ["in.private-temp.example"] }, calls);
  const extended = { ...settings, signupDisposableMailDomains: " private-temp.example ,bad name" };
  expect(await signupMailSignal("a@custom.example", settings, resolver)).toBe("clear");
  resetSignupMailMxCache();
  expect(await signupMailSignal("a@custom.example", extended, resolver)).toBe("disposable");
  expect(await signupMailSignal("b@custom.example", extended, resolver)).toBe("disposable");
  expect(calls).toEqual(["custom.example", "custom.example"]);
});

test("fails open: no domain, lookup off, slow or failing DNS record nothing", async () => {
  const failing: MxResolver = async () => {
    throw Object.assign(new Error("server failure"), { code: "ESERVFAIL" });
  };
  const slow: MxResolver = () => new Promise(() => undefined);
  expect(await signupMailSignal(null, settings, failing)).toBeNull();
  expect(await signupMailSignal("not-an-address", settings, failing)).toBeNull();
  expect(await signupMailSignal("a@acme.io", settings, failing)).toBeNull();
  expect(
    await signupMailSignal("a@acme.io", { ...settings, signupMailMxLookupTimeoutMs: 20 }, slow),
  ).toBeNull();
  expect(
    await signupMailSignal("a@acme.io", { ...settings, signupMailMxLookupTimeoutMs: 0 }, failing),
  ).toBeNull();
  // A listed domain needs no lookup even when lookups are off.
  expect(
    await signupMailSignal(
      "a@yopmail.com",
      { ...settings, signupMailMxLookupTimeoutMs: 0 },
      failing,
    ),
  ).toBe("disposable");
});
