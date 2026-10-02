import { expect, test } from "bun:test";
import { OpenGeniBrowserClient as BrowserClient } from "../src/browser";
import {
  downloadSessionProxySiteHtml,
  getSessionProxyArtifactAssociation,
  getSessionProxyWorkspaceGrant,
  SESSION_PROXY_SITE_HTML_MAX_BYTES,
} from "../src/session-proxy";

test("server proxy helpers stay on the focused subpath, not the browser client", async () => {
  expect(SESSION_PROXY_SITE_HTML_MAX_BYTES).toBe(25 * 1024 * 1024);
  expect(typeof getSessionProxyWorkspaceGrant).toBe("function");
  expect(typeof getSessionProxyArtifactAssociation).toBe("function");
  expect(typeof downloadSessionProxySiteHtml).toBe("function");
  for (const name of [
    "getSessionProxyWorkspaceGrant",
    "getSessionProxyArtifactAssociation",
    "downloadSessionProxySiteHtml",
  ]) {
    expect(name in BrowserClient.prototype).toBe(false);
  }
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/browser.ts", import.meta.url).pathname],
    target: "browser",
    minify: false,
  });
  expect(bundle.success).toBe(true);
  const output = await bundle.outputs[0]!.text();
  expect(output).not.toContain("SessionProxySiteHtmlTooLargeError");
  expect(output).not.toContain("/access/grant");
  expect(output).not.toContain("/artifact-associations/");
});
