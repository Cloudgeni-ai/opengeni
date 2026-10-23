import { expect, test } from "bun:test";
import { OpenGeniBrowserClient as BrowserClient } from "../src/browser";
import { getSessionProxyWorkspaceGrant } from "../src/session-proxy";

test("server relay helpers stay on the focused subpath, not the browser client", async () => {
  expect(typeof getSessionProxyWorkspaceGrant).toBe("function");
  expect("getSessionProxyWorkspaceGrant" in BrowserClient.prototype).toBe(false);
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/browser.ts", import.meta.url).pathname],
    target: "browser",
    minify: false,
  });
  expect(bundle.success).toBe(true);
  const output = await bundle.outputs[0]!.text();
  expect(output).not.toContain("/access/grant");
});
