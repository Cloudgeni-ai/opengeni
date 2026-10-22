import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../../types";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

mock.module("../../lib/navigation", () => ({
  Link: ({
    children,
    to,
    params,
    search,
  }: {
    children: ReactNode;
    to: string;
    params: Record<string, string>;
    search?: Record<string, string>;
  }) => <a href={JSON.stringify({ to, params, search: search ?? null })}>{children}</a>,
}));

let module: typeof import("./site-origin-link");
let ownsDom = false;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  module = await import("./site-origin-link");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
});

const session = (parentSessionId: string | null) =>
  ({
    id: sessionId,
    workspaceId,
    parentSessionId,
    metadata: { _opengeniSiteOrigin: { siteId, title: "Opengeni usage" } },
  }) as unknown as Session;
const target = (markup: string) => {
  const container = document.createElement("div");
  container.innerHTML = markup;
  return JSON.parse(container.querySelector("a")!.getAttribute("href")!);
};

test("a Site's own conversation opens the Site with it selected", () => {
  expect(target(renderToStaticMarkup(<module.SiteOriginLink session={session(null)} />))).toEqual({
    to: "/workspaces/$workspaceId/sites/$siteId",
    params: { workspaceId, siteId },
    search: { conversation: sessionId },
  });
});

test("a session spawned inside one opens the Site without selecting it", () => {
  expect(
    target(renderToStaticMarkup(<module.SiteOriginLink session={session(sessionId)} />)),
  ).toEqual({
    to: "/workspaces/$workspaceId/sites/$siteId",
    params: { workspaceId, siteId },
    search: null,
  });
});

test("a session that didn't start in a Site has no link", () => {
  expect(
    renderToStaticMarkup(
      <module.SiteOriginLink session={{ ...session(null), metadata: {} } as Session} />,
    ),
  ).toBe("");
});
