import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SiteAuthAuthorizeRequest } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";

mock.module("@/context", () => ({ useAppContext: () => ({}) }));
let module: typeof import("./site-auth");
let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://console.example" });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  module = await import("./site-auth");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const host = "team-crm-4k9x.sites.example";
const search = {
  host,
  state: "state-0123456789abcdef",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
  redirect_uri: `https://${host}/_og/auth/callback`,
};

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await act(async () => await Promise.resolve());
};
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);

async function render(
  client: { authorizeSiteViewer: (request: SiteAuthAuthorizeRequest) => Promise<unknown> },
  options: { search?: Record<string, string>; onUseAnotherAccount?: () => void } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const visited: string[] = [];
  await act(async () =>
    root.render(
      <module.SiteAuthorizePage
        client={client as never}
        email="ada@example.test"
        search={options.search ?? search}
        onUseAnotherAccount={options.onUseAnotherAccount}
        navigate={(url) => visited.push(url)}
      />,
    ),
  );
  await flush();
  return {
    container,
    visited,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("names the Site and account, and Continue goes only to the Site's callback", async () => {
  const requests: SiteAuthAuthorizeRequest[] = [];
  const page = await render({
    authorizeSiteViewer: async (request) => {
      requests.push(request);
      return {
        redirectTo: `https://${host}/_og/auth/callback?code=one-time-code-123456&state=${search.state}`,
        site: { title: "Team CRM", hostname: host },
      };
    },
  });
  expect(requests).toEqual([
    {
      host,
      state: search.state,
      codeChallenge: search.code_challenge,
      codeChallengeMethod: "S256",
      redirectUri: search.redirect_uri,
    },
  ]);
  expect(page.container.textContent).toContain("Continue to Team CRM");
  expect(page.container.textContent).toContain(host);
  expect(page.container.textContent).toContain("ada@example.test");

  await act(async () => button("Continue")!.click());
  await flush();
  expect(page.visited).toEqual([
    `https://${host}/_og/auth/callback?code=one-time-code-123456&state=${search.state}`,
  ]);
  await page.unmount();
});

test("refuses a callback on another host", async () => {
  const page = await render({
    authorizeSiteViewer: async () => ({
      redirectTo: "https://evil.example/_og/auth/callback?code=x",
      site: { title: "Team CRM", hostname: host },
    }),
  });
  await act(async () => button("Continue")!.click());
  await flush();
  expect(page.visited).toEqual([]);
  expect(page.container.textContent).toContain("sign-in link isn't valid");
  await page.unmount();
});

test("says plainly when the account can't open the Site", async () => {
  let switched = 0;
  const page = await render(
    {
      authorizeSiteViewer: async () => {
        throw new OpenGeniApiError(403, "denied", { code: "site_access_denied" });
      },
    },
    { onUseAnotherAccount: () => (switched += 1) },
  );
  expect(page.container.textContent).toContain("You can't open this Site");
  expect(page.container.textContent).toContain(`ada@example.test doesn't have access to ${host}`);
  await act(async () => button("Use another account")!.click());
  expect(switched).toBe(1);
  await act(async () => button("Back to the Site")!.click());
  await flush();
  expect(page.visited).toHaveLength(1);
  expect(page.visited[0]).toContain("error=access_denied");
  await page.unmount();
});

test("a malformed request never calls the API", async () => {
  let called = false;
  const page = await render(
    {
      authorizeSiteViewer: async () => {
        called = true;
        throw new Error("unexpected");
      },
    },
    { search: { ...search, redirect_uri: "https://evil.example/_og/auth/callback" } },
  );
  expect(called).toBe(false);
  expect(page.container.textContent).toContain("Nothing to sign in to here");
  await page.unmount();
});
