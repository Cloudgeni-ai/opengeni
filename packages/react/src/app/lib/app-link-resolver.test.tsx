import { describe, expect, test } from "bun:test";
import { parseOpenGeniLink } from "@opengeni/sdk";
import type { ReactNode } from "react";

import { registerDom, renderComponent } from "../../../test/render-hook";
import { OpenGeniLinkProvider, type OpenGeniLinkResolver } from "../../components/open-geni-links";
import { AppHostProvider, type AppHost } from "./app-host";
import type { PageHost } from "./navigation";
import { useAppLinkResolver } from "./session-artifact-navigation";
import { SessionUiFeaturesProvider, type SessionUiPreset } from "./session-ui-features";

registerDom();

const WORKSPACE = "ws";
const SITE = "11111111-1111-4111-8111-111111111111";
const site = parseOpenGeniLink(`/workspaces/${WORKSPACE}/artifacts/${SITE}`)!;

function pageHost(opensBeside: boolean, opened: string[]): PageHost {
  return {
    href: () => `https://app.example.test/workspaces/${WORKSPACE}/sessions`,
    origin: () => "https://app.example.test",
    readQuery: () => new URLSearchParams(),
    replaceQuery: () => undefined,
    assign: () => undefined,
    opensBeside,
    open: (url: string) => void opened.push(url),
  } as unknown as PageHost;
}

async function resolverIn(options: {
  embedded: boolean;
  preset: SessionUiPreset;
  host?: OpenGeniLinkResolver;
}) {
  const opened: string[] = [];
  const captured: { current: OpenGeniLinkResolver | null } = { current: null };
  function Capture() {
    captured.current = useAppLinkResolver();
    return null;
  }
  const appHost = {
    navigation: { page: pageHost(options.embedded, opened) },
  } as unknown as AppHost;
  const tree: ReactNode = (
    <AppHostProvider host={appHost}>
      <OpenGeniLinkProvider resolveLink={options.host}>
        <SessionUiFeaturesProvider preset={options.preset}>
          <Capture />
        </SessionUiFeaturesProvider>
      </OpenGeniLinkProvider>
    </AppHostProvider>
  );
  const rendered = await renderComponent(tree);
  await rendered.unmount();
  return { resolve: captured.current!, opened };
}

describe("useAppLinkResolver", () => {
  test("the web app keeps its own console path", async () => {
    const { resolve } = await resolverIn({ embedded: false, preset: "app" });
    expect(resolve(site)).toEqual({ href: `/workspaces/${WORKSPACE}/artifacts/${SITE}` });
  });

  test("an embed with the dock links the web app's absolute URL for the dock to intercept", async () => {
    const { resolve } = await resolverIn({ embedded: true, preset: "companion" });
    expect(resolve(site)).toEqual({
      href: `https://app.example.test/workspaces/${WORKSPACE}/artifacts/${SITE}`,
    });
  });

  test("an embed without the dock opens the web app's page beside the host", async () => {
    const { resolve, opened } = await resolverIn({ embedded: true, preset: "embed" });
    const resolution = resolve(site);
    expect(resolution?.href).toBeUndefined();
    await resolution?.open?.();
    expect(opened).toEqual([`/workspaces/${WORKSPACE}/artifacts/${SITE}`]);
  });

  test("the host's resolver wins, and links it leaves fall back to the app", async () => {
    const hostOpened: string[] = [];
    const { resolve, opened } = await resolverIn({
      embedded: true,
      preset: "embed",
      host: (target) =>
        target.kind === "site" ? { open: () => void hostOpened.push(target.artifactId) } : null,
    });
    await resolve(site)?.open?.();
    expect(hostOpened).toEqual([SITE]);
    expect(opened).toEqual([]);
    const editable = parseOpenGeniLink(
      `/workspaces/${WORKSPACE}/artifacts/editable/0123456789abcdef0123456789abcdef`,
    )!;
    await resolve(editable)?.open?.();
    expect(opened).toEqual([
      `/workspaces/${WORKSPACE}/artifacts/editable/0123456789abcdef0123456789abcdef`,
    ]);
  });
});
