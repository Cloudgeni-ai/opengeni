import { expect, test } from "bun:test";

import { claimConnectContinueReplay } from "./connect-continue";

test("a server step is replayed once, so a sign-in the server can't see never loops", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  } as unknown as Storage;
  const step = "https://app.example.com/v1/integrations/oauth/callback?code=c&state=s";
  expect(claimConnectContinueReplay(step, storage)).toBe(true);
  expect(claimConnectContinueReplay(step, storage)).toBe(false);
  expect(claimConnectContinueReplay(`${step}2`, storage)).toBe(true);
});
