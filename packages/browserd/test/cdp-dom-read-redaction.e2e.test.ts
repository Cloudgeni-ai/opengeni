import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const html = (body: string) =>
  new Response(`<!doctype html>${body}`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** Almost every public page holds a hidden form field (a CSRF token). */
const PUBLIC_PAGE = `<title>Public</title><body>
  <form><input type="hidden" name="csrf" value="fixture-csrf-secret"></form>
  <h1>Public page</h1><p>Opening hours: 9 to 5</p></body>`;

const MIXED_PAGE = `<title>Mixed</title><body>
  <header><h1>Store</h1><nav>Home · Shop</nav></header>
  <form>
    <input type="hidden" name="csrf" value="fixture-csrf-secret">
    <label>Email <input name="email" value="fixture-email-value"></label>
    <label>Password <input type="password" value="fixture-password-secret"></label>
    <textarea data-private>fixture-textarea-secret</textarea>
    <select name="card-expiry"><option>fixture-select-secret</option></select>
  </form>
  <p>Balance: <span data-private>fixture-balance-secret</span> NOK</p>
  <div id="card-number">fixture-card-secret</div>
  <div data-sensitive><p>fixture-nested-secret</p><span>fixture-nested-secret-two</span></div>
  <div style="display: contents">Contents <span style="display: none">fixture-hidden-text</span><span data-private>fixture-contents-secret</span></div>
  <ul><li>First</li><li>Second</li></ul>
  <p style="visibility: hidden">fixture-invisible-text</p>
  <footer>Footer text</footer>
  <section id="inside" data-private><p id="inside-child">fixture-inside-secret</p></section>
</body>`;

e2e(
  "a DOM read of a container withholds only its protected parts",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        html(new URL(request.url).pathname === "/mixed" ? MIXED_PAGE : PUBLIC_PAGE),
    });
    const directory = await mkdtemp("/tmp/ogb-dom-read-redaction-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    const read = async (targetId: string, selector: string, extra: object = {}) => {
      const state = await driver.targetState(targetId);
      return await driver.readDom(targetId, {
        kind: "element",
        locator: { kind: "css", selector },
        expectedTargetGeneration: state.targetGeneration,
        expectedDocumentGeneration: state.documentGeneration!,
        expectedFrameId: state.frameId!,
        ...extra,
      });
    };
    try {
      // A page body whose only protected element is a hidden field reads in
      // full: the field never showed any text.
      const publicPage = await driver.start(`http://127.0.0.1:${server.port}/`);
      const body = await read(publicPage.target.id, "body");
      expect(body).toMatchObject({ redacted: null, truncated: false });
      expect(body.text).toContain("Public page");
      expect(body.text).toContain("Opening hours: 9 to 5");
      expect(JSON.stringify(body)).not.toContain("fixture-csrf-secret");

      const mixed = await driver.openTarget(`http://127.0.0.1:${server.port}/mixed`);
      const mixedBody = await read(mixed.target.id, "body");
      // The first protected element that shows text names the reason.
      expect(mixedBody.redacted).toBe("payment");
      for (const shown of [
        "Store",
        "Home · Shop",
        "Email",
        "Password",
        "Balance:",
        "NOK",
        "Contents",
        "First",
        "Second",
        "Footer text",
      ]) {
        expect(mixedBody.text).toContain(shown);
      }
      expect(JSON.stringify(mixedBody)).not.toMatch(/fixture-/u);

      // Paging through the text never reaches protected text either.
      let offset = 0;
      let paged = "";
      for (;;) {
        const page = await read(mixed.target.id, "body", { maxChars: 7, offset });
        expect(JSON.stringify(page)).not.toMatch(/fixture-/u);
        paged += page.text ?? "";
        if (!page.truncated) break;
        offset += page.text!.length;
      }
      expect(paged).toBe(mixedBody.text!);

      // A protected element, and anything inside one, is still refused whole.
      for (const selector of ["#inside", "#inside-child", "#card-number", "select"]) {
        const refused = await read(mixed.target.id, selector);
        expect(refused).toMatchObject({ text: null, value: null });
        expect(refused.redacted).not.toBeNull();
        expect(JSON.stringify(refused)).not.toMatch(/fixture-/u);
      }
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
