import { expect, test } from "bun:test";
import {
  parseIdentityLinkContinuation,
  readIdentityLinkContinuation,
  retainIdentityLinkContinuation,
} from "./identity-link-continuation";

test("identity confirmation challenge is tab-local and scrubbed before application mount", () => {
  const linkId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const challenge = "a".repeat(43);
  const url = new URL(
    `https://app.example/identity-links/${linkId}?organization=${organizationId}#challenge=${challenge}`,
  );
  expect(parseIdentityLinkContinuation(url)).toEqual({ linkId, organizationId, challenge });
  let replaced = "";
  retainIdentityLinkContinuation({
    location: { href: url.href } as Location,
    history: {
      state: { kept: true },
      replaceState: (state: unknown, _unused: string, next: string | URL | null | undefined) => {
        expect(state).toEqual({ kept: true });
        replaced = String(next);
      },
    } as History,
  });
  expect(replaced).toBe(url.pathname + url.search);
  expect(replaced).not.toContain(challenge);
  expect(readIdentityLinkContinuation(linkId, organizationId)).toBe(challenge);
  expect(readIdentityLinkContinuation(crypto.randomUUID(), organizationId)).toBeNull();
  expect(readIdentityLinkContinuation(linkId, crypto.randomUUID())).toBeNull();
  expect(parseIdentityLinkContinuation(new URL(url.origin + url.pathname + url.search))).toBeNull();
});
