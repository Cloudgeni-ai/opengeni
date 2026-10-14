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

type Client = {
  authorizeSiteViewer: (request: SiteAuthAuthorizeRequest) => Promise<unknown>;
  getClientConfig?: () => Promise<unknown>;
};

async function render(
  client: Client,
  options: {
    search?: Record<string, string>;
    onUseAnotherAccount?: () => void;
    sitesDomain?: string | null;
    framed?: boolean;
  } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const visited: string[] = [];
  const domainProp = "sitesDomain" in options ? { sitesDomain: options.sitesDomain } : {};
  await act(async () =>
    root.render(
      <module.SiteAuthorizePage
        client={{ getClientConfig: async () => ({}), ...client } as never}
        email="ada@example.test"
        search={options.search ?? search}
        onUseAnotherAccount={options.onUseAnotherAccount}
        navigate={(url) => visited.push(url)}
        isFramed={() => options.framed ?? false}
        {...domainProp}
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

const configured = { sitesDomain: "sites.example" };

test("names the Site and account, mints the code only on Continue, and goes to the callback", async () => {
  const requests: SiteAuthAuthorizeRequest[] = [];
  const page = await render(
    {
      authorizeSiteViewer: async (request) => {
        requests.push(request);
        return {
          redirectTo: `https://${host}/_og/auth/callback?code=one-time-code-123456&state=${search.state}`,
          site: { title: "Team CRM", hostname: host },
        };
      },
    },
    configured,
  );
  expect(requests).toEqual([]);
  expect(page.container.textContent).toContain(`Continue to ${host}`);
  expect(page.container.textContent).toContain("ada@example.test");

  await act(async () => button("Continue")!.click());
  await flush();
  expect(requests).toEqual([
    {
      host,
      state: search.state,
      codeChallenge: search.code_challenge,
      codeChallengeMethod: "S256",
      redirectUri: search.redirect_uri,
    },
  ]);
  expect(page.visited).toEqual([
    `https://${host}/_og/auth/callback?code=one-time-code-123456&state=${search.state}`,
  ]);
  await page.unmount();
});

test("learns the Sites domain from the client config when it isn't passed in", async () => {
  let configCalls = 0;
  const page = await render({
    getClientConfig: async () => {
      configCalls += 1;
      return { sites: { domain: "sites.example" } };
    },
    authorizeSiteViewer: async () => {
      throw new Error("unexpected");
    },
  });
  expect(configCalls).toBe(1);
  expect(page.container.textContent).toContain(`Continue to ${host}`);
  await page.unmount();
});

test("Cancel before the API confirmed the Site stays in Opengeni", async () => {
  let called = false;
  const page = await render(
    {
      authorizeSiteViewer: async () => {
        called = true;
        throw new Error("unexpected");
      },
    },
    configured,
  );
  await act(async () => button("Cancel")!.click());
  await flush();
  expect(page.visited).toEqual(["/"]);
  expect(called).toBe(false);
  await page.unmount();
});

test("refuses a callback on another host", async () => {
  const page = await render(
    {
      authorizeSiteViewer: async () => ({
        redirectTo: "https://evil.example/_og/auth/callback?code=x",
        site: { title: "Team CRM", hostname: host },
      }),
    },
    configured,
  );
  await act(async () => button("Continue")!.click());
  await flush();
  expect(page.visited).toEqual([]);
  expect(page.container.textContent).toContain("sign-in link isn't valid");
  await page.unmount();
});

test("says plainly when the account can't open the Site, then goes back to it", async () => {
  let switched = 0;
  const page = await render(
    {
      authorizeSiteViewer: async () => {
        throw new OpenGeniApiError(403, "denied", { code: "site_access_denied" });
      },
    },
    { ...configured, onUseAnotherAccount: () => (switched += 1) },
  );
  await act(async () => button("Continue")!.click());
  await flush();
  expect(page.container.textContent).toContain("You can't open this Site");
  expect(page.container.textContent).toContain(`ada@example.test doesn't have access to ${host}`);
  await act(async () => button("Use another account")!.click());
  expect(switched).toBe(1);
  await act(async () => button("Back to the Site")!.click());
  await flush();
  expect(page.visited).toEqual([
    `https://${host}/_og/auth/callback?error=access_denied&state=${search.state}`,
  ]);
  await page.unmount();
});

test("an unknown Site offers no way back to it", async () => {
  const page = await render(
    {
      authorizeSiteViewer: async () => {
        throw new OpenGeniApiError(404, "missing", { code: "site_not_found" });
      },
    },
    configured,
  );
  await act(async () => button("Continue")!.click());
  await flush();
  expect(page.container.textContent).toContain("This Site isn't available");
  expect(button("Back to the Site")).toBeUndefined();
  expect(page.visited).toEqual([]);
  await page.unmount();
});

test("a malformed request or a host outside the Sites domain never calls the API", async () => {
  for (const options of [
    {
      ...configured,
      search: { ...search, redirect_uri: "https://evil.example/_og/auth/callback" },
    },
    {
      ...configured,
      search: {
        ...search,
        host: "team-crm-4k9x.evil.example",
        redirect_uri: "https://team-crm-4k9x.evil.example/_og/auth/callback",
      },
    },
    { sitesDomain: null },
  ]) {
    let called = false;
    const page = await render(
      {
        authorizeSiteViewer: async () => {
          called = true;
          throw new Error("unexpected");
        },
      },
      options,
    );
    expect(page.container.textContent).toContain("Nothing to sign in to here");
    expect(button("Continue")).toBeUndefined();
    expect(called).toBe(false);
    await page.unmount();
  }
});

test("refuses to render inside another page", async () => {
  let calls = 0;
  const page = await render(
    {
      getClientConfig: async () => {
        calls += 1;
        return {};
      },
      authorizeSiteViewer: async () => {
        calls += 1;
        throw new Error("unexpected");
      },
    },
    { framed: true },
  );
  expect(page.container.textContent).toContain("Open this page in its own tab");
  expect(button("Continue")).toBeUndefined();
  expect(calls).toBe(0);
  await page.unmount();
});
