import { afterEach, describe, expect, test } from "bun:test";
import type { NativeAppRelayPoll } from "@opengeni/sdk";
import {
  officePlatform,
  prepareSignIn,
  SIGN_IN_CANCELLED,
  signInMode,
  startBrowserSignIn,
} from "./office-auth";

describe("where the Excel pane signs in", () => {
  afterEach(() => {
    delete (globalThis as { Office?: unknown }).Office;
  });

  test("desktop Excel (Mac and Windows) uses the system browser", () => {
    expect(signInMode("Mac")).toBe("browser");
    expect(signInMode("PC")).toBe("browser");
  });

  test("Excel on the web, and anything unknown, keeps the Office dialog", () => {
    expect(signInMode("OfficeOnline")).toBe("dialog");
    expect(signInMode("iOS")).toBe("dialog");
    expect(signInMode(null)).toBe("dialog");
  });

  test("reads the platform from office.js", () => {
    expect(officePlatform()).toBeNull();
    (globalThis as { Office?: unknown }).Office = { context: { platform: "Mac" } };
    expect(officePlatform()).toBe("Mac");
    (globalThis as { Office?: unknown }).Office = {
      context: { diagnostics: { platform: "PC" } },
    };
    expect(officePlatform()).toBe("PC");
  });
});

describe("browser sign-in", () => {
  const WEB = "https://app.opengeni.test";

  function fakeClient(polls: NativeAppRelayPoll[]) {
    const calls: { created: unknown[]; polled: unknown[]; exchanged: unknown[] } = {
      created: [],
      polled: [],
      exchanged: [],
    };
    const client = {
      createNativeAppRelay: async (input: unknown) => {
        calls.created.push(input);
        return {
          relayId: "r".repeat(43),
          confirmationCode: "AB3X7K",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      pollNativeAppRelay: async (input: unknown) => {
        calls.polled.push(input);
        const next = polls.shift();
        if (!next) throw new Error("offline");
        return next;
      },
      exchangeNativeAppCode: async (input: unknown) => {
        calls.exchanged.push(input);
        return { accessToken: "ogapp_token", tokenType: "Bearer" as const, expiresAt: "" };
      },
    };
    return { client: client as never, calls };
  }

  test("opens the system browser on the relay, then redeems the approved code with the verifier", async () => {
    const request = await prepareSignIn();
    const { client, calls } = fakeClient([
      { status: "pending" },
      { status: "gone" },
      { status: "approved", code: "c".repeat(43) },
    ]);
    const opened: string[] = [];
    const started = await startBrowserSignIn(
      { client, webOrigin: WEB, openBrowser: (url) => opened.push(url), sleep: async () => {} },
      request,
    );
    expect(started.confirmationCode).toBe("AB3X7K");
    expect(await started.done).toBe("ogapp_token");
    expect(opened).toEqual([
      `${WEB}/native-sign-in?relay=${"r".repeat(43)}&platform=office&device_name=Excel`,
    ]);
    expect(calls.created).toEqual([
      {
        redirectUri: `${WEB}/office/auth-callback.html`,
        codeChallenge: request.challenge,
        codeChallengeMethod: "S256",
        platform: "office",
        deviceName: "Excel",
      },
    ]);
    // The verifier goes only to this deployment's API, never into the browser URL.
    expect(opened[0]).not.toContain(request.verifier);
    expect(calls.exchanged).toEqual([
      {
        code: "c".repeat(43),
        codeVerifier: request.verifier,
        redirectUri: `${WEB}/office/auth-callback.html`,
      },
    ]);
  });

  test("reopen opens the same page; cancel stops polling", async () => {
    const { client, calls } = fakeClient([{ status: "pending" }]);
    const opened: string[] = [];
    let release = () => {};
    const started = await startBrowserSignIn(
      {
        client,
        webOrigin: WEB,
        openBrowser: (url) => opened.push(url),
        sleep: () => new Promise<void>((resolve) => (release = resolve)),
      },
      await prepareSignIn(),
    );
    started.reopen();
    expect(opened).toHaveLength(2);
    expect(opened[1]).toBe(opened[0]);
    started.cancel();
    release();
    await expect(started.done).rejects.toThrow(SIGN_IN_CANCELLED);
    expect(calls.polled).toHaveLength(0);
  });

  test("a refused or expired relay ends the sign-in", async () => {
    const refused = fakeClient([{ status: "refused" }]);
    const first = await startBrowserSignIn(
      { client: refused.client, webOrigin: WEB, openBrowser: () => {}, sleep: async () => {} },
      await prepareSignIn(),
    );
    await expect(first.done).rejects.toThrow("Sign-in was refused. Try again.");

    const expired = fakeClient([{ status: "gone" }]);
    const second = await startBrowserSignIn(
      {
        client: expired.client,
        webOrigin: WEB,
        openBrowser: () => {},
        sleep: async () => {},
        now: () => Date.now() + 120_000,
      },
      await prepareSignIn(),
    );
    await expect(second.done).rejects.toThrow("Sign-in timed out. Try again.");
  });
});
