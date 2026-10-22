// Run with Electron after bundling (external: electron), not with the Bun unit runner.
import { app } from "electron";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { MainWindow } from "../../src/main/window";
import { computerConnectUrl } from "@opengeni/sdk/app-links";
import type { DesktopAppConfig } from "../../src/main/config";

const directory = mkdtempSync(join(tmpdir(), "opengeni-link-e2e-"));
app.setPath("userData", directory);
app.on("window-all-closed", () => {});
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end('<html><body><a id="connect">Open app and connect</a></body></html>');
});
let window: MainWindow | undefined;
async function main() {
  try {
    await app.whenReady();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const received: string[] = [];
    const config = {
      productName: "Connection regression",
      scheme: "opengeni",
      thisComputer: true,
      background: { light: "#fff", dark: "#222" },
      preloadPath: join(directory, "unused.cjs"),
    } as DesktopAppConfig;
    window = new MainWindow(config, directory, {
      connectComputer: (url) => received.push(url),
      navigated() {},
      crashed() {},
      loadFailed() {},
      loaded() {},
      closed() {},
      focused() {},
    });
    const contents = window.showAccount({ id: "fixture", baseUrl: origin, initialPath: "/" });
    await new Promise<void>((resolve) => contents.once("did-finish-load", () => resolve()));
    const url = computerConnectUrl({
      webUrl: `${origin}/workspaces/w1/sessions/s1`,
      subjectId: "person",
    });
    for (const target of ["", "_blank"]) {
      const before = received.length;
      await contents.executeJavaScript(
        `(() => { const a = document.querySelector('#connect'); a.href = ${JSON.stringify(url)}; a.target = ${JSON.stringify(target)}; a.click(); })()`,
        true,
      );
      const deadline = Date.now() + 3000;
      while (received.length === before && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        received.length,
        before + 1,
        `connection click target=${target || "same window"} must dispatch`,
      );
      assert.equal(received.at(-1), url);
    }
    assert.equal(contents.getURL(), `${origin}/`);
    console.log(
      "PASS: real Electron anchor clicks dispatch connect links in the same window and a new window without navigating away",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.window.destroy();
    server.close();
    rmSync(directory, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  }
}
void main();
