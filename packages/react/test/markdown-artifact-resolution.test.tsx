import { expect, test } from "bun:test";
import { OpenGeniApiError, openGeniConsolePath, type OpenGeniClient } from "@opengeni/sdk";
import { Markdown } from "../src/components/markdown";
import { OpenGeniLinkProvider, viewerLinkResolver } from "../src/components/open-geni-links";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();
const WS = "11111111-1111-4111-8111-111111111111";
const SITE = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";
const client: Pick<OpenGeniClient, "getFile" | "getWorkspaceArtifactCurrent"> = {
  getFile: async (_ws, id) => {
    if (id === SITE) throw new OpenGeniApiError(404, "Not found");
    return {} as never;
  },
  getWorkspaceArtifactCurrent: async () => ({}) as never,
};

test("UUID Site and file references render their existing routes, not unavailable text", async () => {
  const r = await renderComponent(
    <OpenGeniLinkProvider
      artifactScope={{ client, workspaceId: WS }}
      resolveLink={(target) => {
        const href = openGeniConsolePath(target, WS);
        return href ? { href } : null;
      }}
    >
      <Markdown artifactHref={(id) => `/files/${id}`}>
        {`[Dashboard](artifact:${SITE}) [Export](artifact:${FILE})`}
      </Markdown>
    </OpenGeniLinkProvider>,
  );
  try {
    await flush();
    const links = [...r.container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/workspaces/${WS}/artifacts/${SITE}`,
      `/files/${FILE}`,
    ]);
    expect(r.container.textContent).not.toContain("unavailable");
  } finally {
    await r.unmount();
  }
});

test("an embedded viewer receives a Site target after UUID lookup", async () => {
  const opened: unknown[] = [];
  const r = await renderComponent(
    <OpenGeniLinkProvider
      artifactScope={{ client, workspaceId: WS }}
      resolveLink={viewerLinkResolver({
        workspaceId: WS,
        open: (target) => void opened.push(target),
      })}
    >
      <Markdown>{`[Dashboard](artifact:${SITE})`}</Markdown>
    </OpenGeniLinkProvider>,
  );
  try {
    await flush();
    await actRun(() => r.container.querySelector<HTMLButtonElement>("button")!.click());
    expect(opened).toEqual([{ kind: "site", artifactId: SITE }]);
  } finally {
    await r.unmount();
  }
});

test("a failed metadata lookup can be retried instead of guessing a file route", async () => {
  let attempts = 0;
  const flaky = {
    ...client,
    getFile: (async () => {
      if (++attempts === 1) throw new Error("Temporary failure");
      return {} as never;
    }) as OpenGeniClient["getFile"],
  };
  const r = await renderComponent(
    <OpenGeniLinkProvider artifactScope={{ client: flaky, workspaceId: WS }}>
      <Markdown artifactHref={(id) => `/files/${id}`}>{`[Export](artifact:${FILE})`}</Markdown>
    </OpenGeniLinkProvider>,
  );
  try {
    await flush();
    expect(r.container.querySelector("a")).toBeNull();
    await actRun(() => r.container.querySelector<HTMLButtonElement>("button")!.click());
    await flush();
    expect(r.container.querySelector("a")?.getAttribute("href")).toBe(`/files/${FILE}`);
    expect(attempts).toBe(2);
  } finally {
    await r.unmount();
  }
});

test("a late lookup from the previous workspace cannot replace the current target", async () => {
  let release: () => void = () => undefined;
  let oldSignal: AbortSignal | undefined;
  const delayed = {
    ...client,
    getFile: (async (_ws, _id, options) => {
      oldSignal = options?.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {} as never;
    }) as OpenGeniClient["getFile"],
  };
  const render = (workspaceId: string, source: typeof client) => (
    <OpenGeniLinkProvider
      artifactScope={{ client: source, workspaceId }}
      resolveLink={(target) => {
        const href = openGeniConsolePath(target, workspaceId);
        return href ? { href } : null;
      }}
    >
      <Markdown>{`[Dashboard](artifact:${SITE})`}</Markdown>
    </OpenGeniLinkProvider>
  );
  const r = await renderComponent(render(WS, delayed));
  try {
    expect(r.container.querySelector("[aria-busy=true]")).not.toBeNull();
    expect(r.container.querySelector("a")).toBeNull();
    await r.rerender(render("other-workspace", client));
    await flush();
    expect(oldSignal?.aborted).toBe(true);
    await actRun(() => release());
    await flush();
    expect(r.container.querySelector("a")?.getAttribute("href")).toBe(
      `/workspaces/other-workspace/artifacts/${SITE}`,
    );
  } finally {
    await r.unmount();
  }
});
