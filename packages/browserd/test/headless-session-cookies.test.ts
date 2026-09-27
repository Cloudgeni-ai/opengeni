import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserCdpConnection } from "../src/cdp-driver";
import { HEADLESS_SHELL_VERSION } from "../src/headless-shell";
import {
  captureHeadlessSessionCookies,
  restoreHeadlessSessionCookies,
  validateHeadlessSessionCookies,
  decodeHeadlessSessionCookies,
  type HeadlessSessionCookies,
} from "../src/headless-session-cookies";
import {
  captureEncryptedBrowserProfile,
  restoreEncryptedBrowserProfile,
  type BrowserProfileManifest,
} from "../src/state-artifact";

const source = {
  browserSessionId: "11111111-1111-4111-8111-111111111111",
  controllerGeneration: "controller-source",
};
const secret = "private-session-value-never-written-as-plaintext";
function sessionCookie() {
  return {
    name: "identity",
    value: secret,
    domain: "example.test",
    path: "/account",
    expires: -1 as const,
    session: true as const,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
    priority: "High" as const,
    sourceScheme: "Secure" as const,
    sourcePort: 443,
    partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true },
    partitionKeyOpaque: false as const,
  };
}
function state(): HeadlessSessionCookies {
  return {
    schemaVersion: 1,
    shellVersion: HEADLESS_SHELL_VERSION,
    source,
    context: "default",
    cookies: [sessionCookie()],
  };
}
function manifest(): BrowserProfileManifest {
  return {
    schemaVersion: 1,
    ...source,
    capturedAt: "2026-09-26T12:00:00.000Z",
    engine: "chromium",
    engineVersion: HEADLESS_SHELL_VERSION,
    driverId: "opengeni.cdp.v1",
    driverSchemaVersion: 1,
    profileCrypto: "chromium_basic",
    platform: "linux",
    architecture: "x64",
    tabs: [],
  };
}
function connection(
  input: { contexts?: string[]; version?: string; cookies?: unknown[]; corrupt?: boolean } = {},
) {
  let cookies: unknown[] = input.cookies ?? [
    sessionCookie(),
    { ...sessionCookie(), name: "persistent", session: false, expires: 2_000_000_000 },
  ];
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> | undefined }> =
    [];
  return {
    calls,
    cdp: {
      async send<T>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T> {
        calls.push({ method, params });
        if (method === "Target.getBrowserContexts")
          return { browserContextIds: input.contexts ?? [] } as T;
        if (method === "Browser.getVersion")
          return { product: `HeadlessChrome/${input.version ?? HEADLESS_SHELL_VERSION}` } as T;
        if (method === "Storage.getCookies") return { cookies } as T;
        if (method === "Storage.setCookies") {
          cookies = (params!.cookies as Array<Record<string, unknown>>).map((entry) => ({
            ...entry,
            expires: -1,
            session: true,
            ...(input.corrupt ? { path: "/wrong" } : {}),
          }));
          return {} as T;
        }
        throw new Error("unexpected private CDP method");
      },
      on: () => () => undefined,
      waitForEvent: async () => {
        throw new Error("unexpected event");
      },
      close() {},
    } satisfies BrowserCdpConnection,
  };
}

describe("private headless session-cookie state", () => {
  test("preserves session semantics and complete attributes including partition keys", async () => {
    const mock = connection();
    const captured = await captureHeadlessSessionCookies(mock.cdp, source);
    expect(captured).toEqual(state());
    await restoreHeadlessSessionCookies(mock.cdp, captured);
    const set = mock.calls.find((entry) => entry.method === "Storage.setCookies")!;
    expect(set.params).not.toHaveProperty("browserContextId");
    expect(set.params!.cookies as unknown[]).toHaveLength(1);
    expect((set.params!.cookies as unknown[])[0]).not.toHaveProperty("expires");
    expect((set.params!.cookies as unknown[])[0]).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "None",
      priority: "High",
      sourceScheme: "Secure",
      sourcePort: 443,
      domain: "example.test",
      path: "/account",
      partitionKey: sessionCookie().partitionKey,
    });
  });
  test("refuses pooled contexts, incompatible versions and opaque partition keys without cookie writes", async () => {
    for (const mock of [
      connection({ contexts: ["another-private-context"] }),
      connection({ version: "149.0.0.0" }),
      connection({ cookies: [{ ...sessionCookie(), partitionKeyOpaque: true }] }),
    ]) {
      await expect(captureHeadlessSessionCookies(mock.cdp, source)).rejects.toThrow(
        "invalid or incompatible",
      );
      expect(mock.calls.some((entry) => entry.method === "Storage.setCookies")).toBe(false);
    }
  });
  test("rejects malformed, oversized, duplicate and wrong-context records without reflecting secrets", () => {
    for (const invalid of [
      { ...state(), context: "other" },
      { ...state(), cookies: [sessionCookie(), sessionCookie()] },
      { ...state(), cookies: [{ ...sessionCookie(), unknown: secret }] },
      { ...state(), cookies: [{ ...sessionCookie(), value: "x".repeat(16385) }] },
      {
        ...state(),
        cookies: [
          {
            ...sessionCookie(),
            partitionKey: { topLevelSite: secret, hasCrossSiteAncestor: true },
          },
        ],
      },
      {
        ...state(),
        cookies: [
          {
            ...sessionCookie(),
            partitionKey: { topLevelSite: "https://top.example/path", hasCrossSiteAncestor: true },
          },
        ],
      },
    ]) {
      expect(() => validateHeadlessSessionCookies(invalid)).toThrow("invalid or incompatible");
      try {
        validateHeadlessSessionCookies(invalid);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
    try {
      decodeHeadlessSessionCookies(Buffer.from(`{"value":"${secret}"`));
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
  test("checks restored host/path/partition attributes instead of accepting silent cookie conversion", async () => {
    await expect(
      restoreHeadlessSessionCookies(connection({ corrupt: true }).cdp, state()),
    ).rejects.toThrow("invalid or incompatible");
  });
  test("encrypts the private entry; restores to memory only after exact artifact authentication", async () => {
    const directory = await mkdtemp("/tmp/ogb-private-cookie-");
    const profile = join(directory, "profile");
    const artifact = join(directory, "profile.ogbs");
    const key = Buffer.alloc(32, 0x31),
      aad = Buffer.from("exact-browser-revision");
    try {
      await mkdir(profile);
      const captured = await captureEncryptedBrowserProfile({
        profileDirectory: profile,
        artifactPath: artifact,
        dataKey: key,
        aad,
        manifest: manifest(),
        headlessSessionCookies: state(),
      });
      expect(JSON.stringify(captured)).not.toContain(secret);
      expect((await readFile(artifact)).includes(Buffer.from(secret))).toBe(false);
      expect(await readdir(profile)).toEqual([]);
      let restored: HeadlessSessionCookies | undefined;
      const authority = {
        artifactPath: artifact,
        dataKey: key,
        aad,
        expectedArtifactDigest: captured.artifactDigest,
        expectedContentDigest: captured.contentDigest,
        expectedSizeBytes: captured.sizeBytes,
      };
      await restoreEncryptedBrowserProfile({
        ...authority,
        outputProfileDirectory: join(directory, "restored"),
        acceptHeadlessSessionCookies: (value) => {
          restored = value;
        },
      });
      expect(restored).toEqual(state());
      expect(await readdir(join(directory, "restored"))).toEqual([]);
      let leaked = false;
      await expect(
        restoreEncryptedBrowserProfile({
          ...authority,
          aad: Buffer.from("another-browser-revision"),
          outputProfileDirectory: join(directory, "wrong-aad"),
          acceptHeadlessSessionCookies: () => {
            leaked = true;
          },
        }),
      ).rejects.toThrow("authentication failed");
      expect(leaked).toBe(false);
      await expect(
        restoreEncryptedBrowserProfile({
          ...authority,
          expectedArtifactDigest: "f".repeat(64),
          outputProfileDirectory: join(directory, "wrong-digest"),
          acceptHeadlessSessionCookies: () => {
            leaked = true;
          },
        }),
      ).rejects.toThrow("artifact digest");
      expect(leaked).toBe(false);
      await expect(
        restoreEncryptedBrowserProfile({
          ...authority,
          outputProfileDirectory: join(directory, "no-authority"),
        }),
      ).rejects.toThrow("private driver authority");
      await expect(
        captureEncryptedBrowserProfile({
          profileDirectory: profile,
          artifactPath: join(directory, "cross-profile.ogbs"),
          dataKey: key,
          aad,
          manifest: { ...manifest(), browserSessionId: "22222222-2222-4222-8222-222222222222" },
          headlessSessionCookies: state(),
        }),
      ).rejects.toThrow("invalid or incompatible");
      await expect(
        captureEncryptedBrowserProfile({
          profileDirectory: profile,
          artifactPath: join(directory, "cross-engine.ogbs"),
          dataKey: key,
          aad,
          manifest: { ...manifest(), engine: "chrome" },
          headlessSessionCookies: state(),
        }),
      ).rejects.toThrow("invalid or incompatible");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
