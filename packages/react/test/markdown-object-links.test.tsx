import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "../src/components/markdown";
import {
  OpenGeniLinkProvider,
  sessionLinkResolver,
  type OpenGeniLinkTarget,
} from "../src/components/open-geni-links";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const EDITABLE = "0123456789abcdef0123456789abcdef";
const SITE = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";
const REPLY = [
  `[Open weekly report](/workspaces/${WORKSPACE}/artifacts/editable/${EDITABLE})`,
  `[Open dashboard](/workspaces/${WORKSPACE}/artifacts/${SITE})`,
  `[Download export](artifact:${FILE})`,
].join("\n\n");

describe("OpenGeni object links inside an embedding host", () => {
  test("console paths never render as navigations when the host resolves nothing", () => {
    const html = renderToStaticMarkup(<Markdown>{REPLY}</Markdown>);
    expect(html).not.toContain(`href="/workspaces/`);
    expect(html).not.toContain('href="artifact:');
    expect(html.match(/\(artifact unavailable\)/g)).toHaveLength(3);
    expect(html).toContain('data-og-link-unavailable="editable-artifact"');
    expect(html).toContain('data-og-link-unavailable="site"');
  });

  test("rejected reserved references never become host-origin navigations", () => {
    const path = `/workspaces/${WORKSPACE}/artifacts/editable/${EDITABLE}`;
    for (const href of [
      path + "#top",
      path + "?version=2",
      path + "?",
      path + "/",
      path.replace("editable", "%65ditable"),
      path + `?fromSession=${FILE}?version=2`,
      "artifact:invalid",
      "ARTIFACT:invalid",
      "/workspace/a:0",
    ]) {
      const html = renderToStaticMarkup(<Markdown>{`[Report](${href})`}</Markdown>);
      expect(html).not.toContain("<a ");
      expect(html).toContain("unavailable");
    }
    const uppercase = renderToStaticMarkup(
      <Markdown artifactHref={(id) => `/download/${id}`}>{`[Report](ARTIFACT:${FILE})`}</Markdown>,
    );
    expect(uppercase).toContain(`href="/download/${FILE}"`);
  });

  test("unsafe resolver and legacy destinations are unavailable, never empty anchors", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd"]) {
      for (const props of [{ resolveLink: () => ({ href }) }, { artifactHref: () => href }]) {
        const html = renderToStaticMarkup(
          <Markdown {...props}>{`[Report](artifact:${FILE})`}</Markdown>,
        );
        expect(html).not.toContain("<a ");
        expect(html).toContain("unavailable");
      }
    }
  });

  test("disabled sandbox defaults leave path references unavailable but retain file downloads", () => {
    const resolve = sessionLinkResolver({
      client: {
        fsRead: (() => Promise.reject(new Error("must not read"))) as never,
        createFileDownloadUrl: (() => Promise.resolve({ url: "https://file.test" })) as never,
      },
      workspaceId: WORKSPACE,
      sessionId: FILE,
      sandboxFiles: false,
    });
    expect(resolve({ kind: "sandbox-file", path: "src/a", line: null })).toBeNull();
    expect(resolve({ kind: "file", fileId: FILE, workspaceId: null })).not.toBeNull();
    const html = renderToStaticMarkup(
      <Markdown resolveLink={resolve}>{"[Code](sandbox:src/a)"}</Markdown>,
    );
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });

  test("a host resolver turns each target into its own URL", () => {
    const seen: OpenGeniLinkTarget[] = [];
    const html = renderToStaticMarkup(
      <Markdown
        resolveLink={(target) => {
          seen.push(target);
          return target.kind === "editable-artifact"
            ? { href: `/reports/${target.artifactId}` }
            : target.kind === "site"
              ? { href: `/apps/${target.artifactId}` }
              : null;
        }}
      >
        {REPLY}
      </Markdown>,
    );
    expect(html).toContain(`href="/reports/${EDITABLE}"`);
    expect(html).toContain(`href="/apps/${SITE}"`);
    expect(html).toContain("Download export (artifact unavailable)");
    expect(seen).toEqual([
      { kind: "editable-artifact", artifactId: EDITABLE, workspaceId: WORKSPACE },
      { kind: "site", artifactId: SITE, workspaceId: WORKSPACE },
      { kind: "file", fileId: FILE, workspaceId: null },
    ]);
  });

  test("a provider action opens the exact target; the nearest resolver wins", async () => {
    const opened: string[] = [];
    const r = await renderComponent(
      <OpenGeniLinkProvider
        resolveLink={(target) =>
          target.kind === "editable-artifact"
            ? { open: () => void opened.push(`outer:${target.artifactId}`) }
            : null
        }
      >
        <OpenGeniLinkProvider
          resolveLink={(target) =>
            target.kind === "file"
              ? { open: () => void opened.push(`file:${target.fileId}`) }
              : null
          }
        >
          <Markdown>{REPLY}</Markdown>
        </OpenGeniLinkProvider>
      </OpenGeniLinkProvider>,
    );
    await flush();
    const buttons = Array.from(r.container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Open weekly report",
      "Download export",
    ]);
    for (const button of buttons) await actRun(() => button.click());
    await flush();
    expect(opened).toEqual([`outer:${EDITABLE}`, `file:${FILE}`]);
    expect(r.container.textContent).toContain("Open dashboard (artifact unavailable)");
    await r.unmount();
  });

  test("explicit artifactHref and onSandboxFile keep precedence over resolvers", () => {
    const html = renderToStaticMarkup(
      <Markdown
        artifactHref={(id) => `/files/${id}`}
        onSandboxFile={() => undefined}
        resolveLink={() => ({ href: "/resolver" })}
      >
        {`[File](artifact:${FILE}) [Code](sandbox:src/app.ts:4)`}
      </Markdown>,
    );
    expect(html).toContain(`href="/files/${FILE}"`);
    expect(html).toContain('title="Open src/app.ts at line 4"');
    expect(html).not.toContain("/resolver");
  });

  test("absolute and unrelated links stay ordinary links", () => {
    const html = renderToStaticMarkup(
      <Markdown resolveLink={() => ({ href: "/resolver" })}>
        {`[Console](https://console.example.test/workspaces/${WORKSPACE}/artifacts/${SITE}) [Docs](/workspaces/${WORKSPACE}/settings)`}
      </Markdown>,
    );
    expect(html).toContain(
      `href="https://console.example.test/workspaces/${WORKSPACE}/artifacts/${SITE}"`,
    );
    expect(html).toContain(`href="/workspaces/${WORKSPACE}/settings"`);
    expect(html).not.toContain("/resolver");
  });

  test("the session default downloads files and sandbox files through the client", async () => {
    const calls: unknown[] = [];
    const resolve = sessionLinkResolver({
      workspaceId: WORKSPACE,
      sessionId: "session-1",
      client: {
        createFileDownloadUrl: (async (workspaceId: string, fileId: string, options: unknown) => {
          calls.push(["download-url", workspaceId, fileId, options]);
          return { url: "https://files.example.test/signed", expiresAt: "" };
        }) as never,
        fsRead: (async (workspaceId: string, sessionId: string, request: unknown) => {
          calls.push(["fs-read", workspaceId, sessionId, request]);
          return {
            path: "reports/weekly.csv",
            encoding: "base64",
            content: btoa("a,b\n"),
            sizeBytes: 4,
            truncated: false,
            isBinary: false,
            revision: 1,
          };
        }) as never,
      },
    });
    const clicked: string[] = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download || this.href);
    };
    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => "blob:download";
    try {
      await resolve({ kind: "file", fileId: FILE, workspaceId: null })!.open!();
      await resolve({ kind: "sandbox-file", path: "reports/weekly.csv", line: null })!.open!();
    } finally {
      HTMLAnchorElement.prototype.click = click;
      URL.createObjectURL = createObjectURL;
    }
    expect(calls).toEqual([
      ["download-url", WORKSPACE, FILE, { sessionId: "session-1" }],
      [
        "fs-read",
        WORKSPACE,
        "session-1",
        { path: "reports/weekly.csv", encoding: "base64", maxBytes: 25 * 1024 * 1024 },
      ],
    ]);
    expect(clicked).toEqual(["https://files.example.test/signed", "weekly.csv"]);
    // Another workspace's file and host-owned kinds are not guessed.
    expect(resolve({ kind: "file", fileId: FILE, workspaceId: "other" })).toBeNull();
    expect(
      resolve({ kind: "editable-artifact", artifactId: EDITABLE, workspaceId: WORKSPACE }),
    ).toBeNull();
    expect(resolve({ kind: "site", artifactId: SITE, workspaceId: WORKSPACE })).toBeNull();
  });
});
