import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { SignupChallenge, useSocialSignupChallenge } = await import("./signup-challenge");
afterAll(() => GlobalRegistrator.unregister());
test("challenge lifecycle clears expired/error tokens, resets on retries and removes the widget", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const tokens: (string | undefined)[] = [];
  const removed: string[] = [];
  let options: Record<string, unknown> = {};
  let rendered = 0;
  window.turnstile = {
    render: (_element, value) => {
      options = value;
      return String(++rendered);
    },
    execute: () => undefined,
    remove: (id) => {
      removed.push(id);
    },
  };
  try {
    await act(async () =>
      root.render(<SignupChallenge siteKey="test-key" onToken={(token) => tokens.push(token)} />),
    );
    expect(options.action).toBe("signup");
    await act(async () => (options.callback as (token: string) => void)("pass"));
    expect(tokens.at(-1)).toBe("pass");
    await act(async () => (options["expired-callback"] as () => void)());
    expect(tokens.at(-1)).toBeUndefined();
    await act(async () => (options["error-callback"] as () => void)());
    expect(host.textContent).toContain("Verification couldn't load");
    await act(async () => host.querySelector("button")!.click());
    expect(rendered).toBe(2);
    expect(removed).toEqual(["1"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete window.turnstile;
  }
  expect(removed).toEqual(["1", "2"]);
});

type SocialChallenge = ReturnType<typeof useSocialSignupChallenge>;
type SocialOutcome = Awaited<ReturnType<SocialChallenge["run"]>>;

function fakeTurnstile() {
  const state = {
    options: [] as Record<string, unknown>[],
    executed: [] as string[],
    removed: [] as string[],
    call(name: string, ...args: unknown[]) {
      return (state.options.at(-1)![name] as (...value: unknown[]) => unknown)(...args);
    },
  };
  window.turnstile = {
    render: (_element, value) => {
      state.options.push(value);
      return String(state.options.length);
    },
    execute: (id) => {
      state.executed.push(id);
    },
    remove: (id) => {
      state.removed.push(id);
    },
  };
  return state;
}

async function mountSocialChallenge(siteKey: string | undefined) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const current: { challenge?: SocialChallenge } = {};
  function Harness() {
    current.challenge = useSocialSignupChallenge(siteKey);
    return <>{current.challenge.element}</>;
  }
  await act(async () => root.render(<Harness />));
  return {
    host,
    get challenge() {
      return current.challenge!;
    },
    /** Starts a run; the outcome is boxed so awaiting the start doesn't wait for it. */
    async run() {
      let outcome!: Promise<SocialOutcome>;
      await act(async () => {
        outcome = current.challenge!.run();
      });
      return { outcome };
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("a social click runs the challenge invisibly and shows it only when Cloudflare asks for interaction", async () => {
  const turnstile = fakeTurnstile();
  const mounted = await mountSocialChallenge("test-key");
  try {
    const { outcome } = await mounted.run();
    expect(turnstile.options[0]).toMatchObject({
      sitekey: "test-key",
      action: "signup",
      execution: "execute",
      appearance: "interaction-only",
    });
    expect(turnstile.executed).toEqual(["1"]);
    const container = mounted.host.querySelector('[aria-label="Signup verification"]')!;
    expect(container.className).toBe("");
    await act(async () => turnstile.call("before-interactive-callback"));
    expect(mounted.challenge.interactive).toBe(true);
    expect(container.className).toContain("mt-3");
    await act(async () => turnstile.call("callback", "solved"));
    expect(await outcome).toEqual({ status: "verified", token: "solved" });
    expect(mounted.challenge.interactive).toBe(false);
    expect(container.className).toBe("");
    expect(turnstile.removed).toEqual(["1"]);
  } finally {
    await mounted.unmount();
    delete window.turnstile;
  }
});

test("a failed or unsupported challenge continues without a token; a newer click or another action cancels", async () => {
  const turnstile = fakeTurnstile();
  const mounted = await mountSocialChallenge("test-key");
  try {
    const { outcome: replaced } = await mounted.run();
    const { outcome: failed } = await mounted.run();
    expect(await replaced).toEqual({ status: "cancelled" });
    expect(turnstile.removed).toEqual(["1"]);
    await act(async () => turnstile.call("error-callback", "600010"));
    expect(await failed).toEqual({ status: "unverified" });
    const { outcome: unsupported } = await mounted.run();
    await act(async () => turnstile.call("unsupported-callback"));
    expect(await unsupported).toEqual({ status: "unverified" });
    const { outcome: cancelled } = await mounted.run();
    await act(async () => mounted.challenge.cancel());
    expect(await cancelled).toEqual({ status: "cancelled" });
    // A late callback from a settled widget changes nothing.
    await act(async () => turnstile.call("callback", "late"));
    expect(turnstile.removed).toEqual(["1", "2", "3", "4"]);
    const { outcome: unmounted } = await mounted.run();
    await mounted.unmount();
    expect(await unmounted).toEqual({ status: "cancelled" });
  } finally {
    delete window.turnstile;
  }
});

test("a challenge that never answers stops waiting, except while a person is solving it", async () => {
  const turnstile = fakeTurnstile();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  window.setTimeout = ((callback: () => void) => {
    timers.set(++nextTimer, callback);
    return nextTimer;
  }) as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as typeof window.clearTimeout;
  const mounted = await mountSocialChallenge("test-key");
  try {
    const { outcome } = await mounted.run();
    await act(async () => turnstile.call("before-interactive-callback"));
    expect(timers.size).toBe(0);
    await act(async () => turnstile.call("after-interactive-callback"));
    expect(timers.size).toBe(1);
    await act(async () => [...timers.values()][0]!());
    expect(await outcome).toEqual({ status: "unverified" });
  } finally {
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
    await mounted.unmount();
    delete window.turnstile;
  }
});

test("without a site key a social click needs no challenge", async () => {
  const turnstile = fakeTurnstile();
  const mounted = await mountSocialChallenge(undefined);
  try {
    expect(await (await mounted.run()).outcome).toEqual({ status: "unverified" });
    expect(turnstile.options).toEqual([]);
    expect(mounted.host.querySelector('[aria-label="Signup verification"]')).toBeNull();
  } finally {
    await mounted.unmount();
    delete window.turnstile;
  }
});
