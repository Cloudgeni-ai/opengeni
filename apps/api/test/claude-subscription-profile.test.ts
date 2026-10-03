import { expect, test } from "bun:test";
import {
  fetchClaudeSubscriptionProfile,
  parseClaudeSubscriptionProfile,
} from "../src/claude-subscription-profile";
const accountUuid = "10000000-0000-4000-8000-000000000001";
test("profile retains provider email and plan while excluding other fields", () => {
  expect(
    parseClaudeSubscriptionProfile({
      account: {
        uuid: accountUuid,
        email_address: "account@example.test",
        full_name: "Ignored name",
      },
      organization: { organization_type: "claude_max", uuid: "ignored" },
    }),
  ).toEqual({ accountUuid, email: "account@example.test", plan: "claude_max" });
  expect(
    parseClaudeSubscriptionProfile({
      account: { uuid: accountUuid, email: "other@example.test", has_claude_pro: true },
    }),
  ).toEqual({ accountUuid, email: "other@example.test", plan: "claude_pro" });
  expect(parseClaudeSubscriptionProfile({ account: { uuid: accountUuid } })).toEqual({
    accountUuid,
    email: null,
    plan: null,
  });
  expect(
    parseClaudeSubscriptionProfile({ account: { uuid: accountUuid, email: "invalid" } }),
  ).toBeNull();
});
test("inference-only setup token makes no profile request", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error("not permitted");
  }) as typeof fetch;
  expect(
    await fetchClaudeSubscriptionProfile("sk-ant-oat01-fixture", ["user:inference"], fetchImpl),
  ).toBeNull();
  expect(calls).toBe(0);
});
test("profile read is bounded, sends only its bearer, and never follows redirects", async () => {
  const fetchImpl = (async (url, init) => {
    expect(url).toBe("https://api.anthropic.com/api/oauth/profile");
    expect(init!.redirect).toBe("error");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer sk-ant-oat01-fixture");
    expect(init!.body).toBeUndefined();
    return Response.json({ account: { uuid: accountUuid, email: "account@example.test" } });
  }) as typeof fetch;
  expect(
    (await fetchClaudeSubscriptionProfile("sk-ant-oat01-fixture", ["user:profile"], fetchImpl))!
      .email,
  ).toBe("account@example.test");
});
test("profile outage preserves a sign-in; oversized or malformed profile is unavailable", async () => {
  for (const response of [
    new Response(null, { status: 403 }),
    new Response("not json"),
    new Response("x".repeat(65537)),
  ]) {
    expect(
      await fetchClaudeSubscriptionProfile(
        "sk-ant-oat01-fixture",
        ["user:profile"],
        (async () => response) as typeof fetch,
      ),
    ).toBeNull();
  }
});
