import { expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { betterAuth } from "better-auth";
import { symmetricEncrypt } from "better-auth/crypto";
import type { ManagedAuth } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import {
  appleCallbackProviderRequest,
  createAppleClientSecret,
  managedAppleProviderOptions,
  redirectAppleFormPost,
  revokeManagedAppleTokens,
} from "./apple-sign-in";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const credentials = {
  clientId: "ai.example.signin",
  teamId: "EXAMPLETEAM",
  keyId: "EXAMPLEKEY",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const settings = testSettings({
  managedAuthAppleClientId: credentials.clientId,
  managedAuthAppleTeamId: credentials.teamId,
  managedAuthAppleKeyId: credentials.keyId,
  managedAuthApplePrivateKey: credentials.privateKey,
});
const second = 1_000;
const day = 86_400;

function decodePart(jwt: string, index: number) {
  return JSON.parse(Buffer.from(jwt.split(".")[index]!, "base64url").toString());
}

test("Apple client secret is a P-256 JWT and renews one day before expiry", () => {
  const epoch = 1_800_000_000;
  let now = epoch;
  const mint = createAppleClientSecret(
    { ...credentials, privateKey: credentials.privateKey.replaceAll("\n", "\\n") },
    () => now * second,
  );
  const jwt = mint();
  const [header, body, signature] = jwt.split(".");
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${body}`),
      {
        key: publicKey,
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature!, "base64url"),
    ),
  ).toBe(true);
  expect(decodePart(jwt, 0)).toEqual({ alg: "ES256", kid: credentials.keyId });
  expect(decodePart(jwt, 1)).toEqual({
    iss: credentials.teamId,
    sub: credentials.clientId,
    aud: "https://appleid.apple.com",
    iat: epoch,
    exp: epoch + 30 * day,
  });
  now += 29 * day - 1;
  expect(mint()).toBe(jwt);
  now++;
  const renewed = mint();
  expect(renewed).not.toBe(jwt);
  expect(decodePart(renewed, 1)).toMatchObject({ iat: now, exp: now + 30 * day });
  expect(mint()).toBe(renewed);
  expect(() => createAppleClientSecret({ ...credentials, privateKey: "not-a-key" })).toThrow(
    /P-256 PEM/,
  );
});

test("Apple is gated by all four settings; the web Services ID remains an audience", async () => {
  expect(managedAppleProviderOptions(testSettings())).toBeNull();
  expect(managedAppleProviderOptions({ ...settings, managedAuthAppleKeyId: undefined })).toBeNull();
  const apple = managedAppleProviderOptions(
    { ...settings, managedAuthAppleAppBundleIdentifier: "ai.example.app" },
    { disableSignUp: true },
  )!;
  const auth = betterAuth({ socialProviders: { apple } });
  const provider = (await auth.$context).socialProviders.find((p) => p.id === "apple")!;
  expect(provider.idToken).toMatchObject({ audience: ["ai.example.signin", "ai.example.app"] });
  expect(provider.options?.disableSignUp).toBe(true);
  expect(decodePart(apple.clientSecret, 1).sub).toBe(credentials.clientId);
});

test("Apple form_post keeps only a state-bound display name, never the posted email or id_token", async () => {
  const auth = betterAuth({
    secret: "apple-form-post-test-secret-at-least-32-bytes",
  }) as ManagedAuth;
  const callback = "https://app.example.test/v1/auth/callback/apple";
  const response = await redirectAppleFormPost(
    auth,
    new Request(`${callback}?state=ignored`, {
      method: "POST",
      body: new URLSearchParams({
        code: "fixture-code",
        state: "fixture-state",
        id_token: "ignored-token",
        user: JSON.stringify({
          name: { firstName: "Example", lastName: "Human" },
          email: "ignored@example.test",
        }),
      }),
    }),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const location = new URL(response.headers.get("location")!, callback);
  expect(location.searchParams.get("state")).toBe("fixture-state");
  expect(location.searchParams.get("code")).toBe("fixture-code");
  expect(location.href).not.toMatch(/Example|ignored|id_token|[?&]user=/);
  const decoded = new URL((await appleCallbackProviderRequest(auth, new Request(location))).url);
  expect(JSON.parse(decoded.searchParams.get("user")!)).toEqual({
    name: { firstName: "Example", lastName: "Human" },
  });
  location.searchParams.set("state", "another-state");
  location.searchParams.set("user", "untrusted-name");
  expect(
    new URL((await appleCallbackProviderRequest(auth, new Request(location))).url).searchParams.has(
      "user",
    ),
  ).toBe(false);
});

test("revocation decrypts Apple tokens, prefers the refresh token, and does not send other providers' tokens", async () => {
  const auth = betterAuth({
    secret: "apple-revocation-test-secret-at-least-32-bytes",
    account: { encryptOAuthTokens: true },
  }) as ManagedAuth;
  const context = await auth.$context;
  const seal = (data: string) => symmetricEncrypt({ key: context.secretConfig, data });
  const apple = {
    providerId: "apple",
    refreshToken: await seal("fixture-refresh"),
    accessToken: await seal("fixture-access"),
  };
  context.internalAdapter.findAccounts = async (userId) => {
    expect(userId).toBe("test-user");
    return [apple, { providerId: "google", refreshToken: "other-provider" }] as Awaited<
      ReturnType<typeof context.internalAdapter.findAccounts>
    >;
  };
  const requests: URLSearchParams[] = [];
  const fetcher = Object.assign(
    async (url: string, init: RequestInit) => {
      expect(url).toBe("https://appleid.apple.com/auth/revoke");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      const body = init.body as URLSearchParams;
      requests.push(body);
      expect(body.get("client_id")).toBe(credentials.clientId);
      expect(decodePart(body.get("client_secret")!, 1)).toMatchObject({
        sub: credentials.clientId,
      });
      return new Response(null, { status: 200 });
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  expect(await revokeManagedAppleTokens(auth, settings, "test-user", { fetcher })).toBe("revoked");
  apple.refreshToken = "";
  expect(await revokeManagedAppleTokens(auth, settings, "test-user", { fetcher })).toBe("revoked");
  expect(requests.map((body) => [body.get("token"), body.get("token_type_hint")])).toEqual([
    ["fixture-refresh", "refresh_token"],
    ["fixture-access", "access_token"],
  ]);
  await expect(
    revokeManagedAppleTokens(auth, settings, "test-user", {
      fetcher: Object.assign(async () => new Response(null, { status: 503 }), {
        preconnect: fetch.preconnect,
      }),
    }),
  ).rejects.toThrow("HTTP 503");
  context.internalAdapter.findAccounts = async () => [];
  expect(await revokeManagedAppleTokens(auth, testSettings(), "test-user", { fetcher })).toBe(
    "not_linked",
  );
});
