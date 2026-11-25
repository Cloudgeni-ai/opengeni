import { afterEach, describe, expect, test } from "bun:test";

import { signUpEmail, startManagedSocialSignIn } from "../api";
import { heedeoSignupToken, preloadHeedeo, resetHeedeoForTests } from "./heedeo";

const config = { publishableKey: "pk_test", scriptUrl: "https://heedeo.dev/i.js" };
const descriptors = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
};

function fakePage(heedeo?: unknown) {
  const appended: { src: string; async: boolean }[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({ src: "", async: false, remove: () => undefined }),
      head: {
        append: (element: { src: string; async: boolean; onload?: () => void }) =>
          appended.push(element),
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      heedeo,
      location: Object.assign(new URL("https://app.example.test/"), { assign: () => undefined }),
      history: { state: null, replaceState: () => undefined },
    },
  });
  return appended;
}

afterEach(() => {
  resetHeedeoForTests();
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe("Heedeo in the browser", () => {
  test("loads the script once, async, with the publishable key", () => {
    const appended = fakePage();
    preloadHeedeo(config);
    preloadHeedeo(config);
    expect(appended).toEqual([
      expect.objectContaining({ src: "https://heedeo.dev/i.js?key=pk_test", async: true }),
    ]);
  });

  test("does nothing without a config or with a non-https script", async () => {
    const appended = fakePage({ identify: async () => ({ token: "tok" }) });
    expect(await heedeoSignupToken()).toBeUndefined();
    preloadHeedeo(undefined);
    preloadHeedeo({ ...config, scriptUrl: "http://heedeo.example.test/i.js" });
    expect(appended).toEqual([]);
  });

  test("returns identify's token, and nothing when it is missing, rejects or is slow", async () => {
    fakePage({ identify: async () => ({ token: "tok" }) });
    preloadHeedeo(config);
    expect(await heedeoSignupToken()).toBe("tok");

    resetHeedeoForTests();
    fakePage({
      identify: async () => {
        throw new Error("blocked");
      },
    });
    preloadHeedeo(config);
    expect(await heedeoSignupToken()).toBeUndefined();

    resetHeedeoForTests();
    fakePage({ identify: () => new Promise(() => undefined) });
    preloadHeedeo(config);
    const started = Date.now();
    expect(await heedeoSignupToken(100)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);

    resetHeedeoForTests();
    fakePage(undefined);
    preloadHeedeo(config);
    expect(await heedeoSignupToken(100)).toBeUndefined();
  });

  test("a script that loaded without window.heedeo (a blocker's stub) answers at once", async () => {
    const appended = fakePage(undefined) as { onload?: () => void }[];
    preloadHeedeo(config);
    appended[0]!.onload?.();
    const started = Date.now();
    expect(await heedeoSignupToken(1_500)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("email sign-up and every Google or GitHub click send a fresh token", async () => {
    let issued = 0;
    fakePage({ identify: async () => ({ token: `tok-${++issued}` }) });
    preloadHeedeo(config);
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=s" });
    }) as unknown as typeof fetch;
    try {
      await signUpEmail({ name: "Human", email: "human@example.test", password: "secret-123" });
      await startManagedSocialSignIn("google");
      await startManagedSocialSignIn("github");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(bodies.map((body) => body.heedeoToken)).toEqual(["tok-1", "tok-2", "tok-3"]);
  });
});
