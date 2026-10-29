import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserAction,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
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
  <details><summary>More</summary>fixture-closed-loose<p>fixture-closed-details</p><span data-private>fixture-closed-secret</span></details>
  <details><summary>Less</summary>fixture-closed-plain</details>
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
        "More",
        "Less",
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

/** Every way an observation can carry page text: values, names (own text,
 * contents, a wrapping label, aria-labelledby), descriptions, options and
 * states. Two public counters show what the protected fields hold now. */
const OBSERVED_PAGE = `<title>Observed</title><body>
  <form>
    <input type="hidden" name="csrf" value="fixture-csrf-secret">
    <label>Email <input name="email" value="fixture-email-value"></label>
    <label>Password <input type="password" value="fixture-password-secret"
      oninput="document.getElementById('password-length').textContent = 'Password length ' + this.value.length"></label>
    <label>Notes <textarea data-private
      oninput="document.getElementById('notes-length').textContent = 'Notes length ' + this.value.length">fixture-textarea-secret</textarea></label>
    <label>Expiry <select name="card-expiry"><option>fixture-select-secret</option><option>fixture-select-other</option></select></label>
    <label>Agree <input type="checkbox" data-private checked></label>
  </form>
  <p id="password-length">Password length 0</p>
  <p id="notes-length">Notes length 0</p>
  <p>Balance: <span data-private>fixture-balance-secret</span> NOK</p>
  <div id="card-number">fixture-card-secret</div>
  <div data-sensitive><p>fixture-nested-secret</p><a href="/fixture-link-address">fixture-link-secret</a></div>
  <button>Pay <span data-private>fixture-button-secret</span> now</button>
  <span id="private-label" data-private>fixture-labelledby-secret</span>
  <button aria-labelledby="private-label public-label">x</button><span id="public-label">Confirm</span>
  <h2>Heading <span data-private>fixture-heading-secret</span></h2>
  <button aria-describedby="private-hint">Help</button><span id="private-hint" data-private>fixture-description-secret</span>
  <input aria-label="Search" aria-describedby="private-hint public-hint"><span id="public-hint">Press enter</span>
  <div data-private title="fixture-title-secret" role="note">fixture-note-secret</div>
</body>`;

e2e(
  "an observation shows protected fields as present and fillable, never what they hold",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => html(OBSERVED_PAGE),
    });
    const directory = await mkdtemp("/tmp/ogb-observe-redaction-");
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
    const act = async (observation: BrowserObservation, action: BrowserAction) =>
      await driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observation.browserSessionId,
        controllerGeneration: observation.target.controllerGeneration,
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration,
        expectedFrameId: observation.frameId!,
        actor: { kind: "agent", subjectId: "observe-redaction-e2e" },
        action,
      });
    // Nothing protected shows: the only fixture text left is the public
    // email address.
    const expectNothingProtected = (observation: BrowserObservation) => {
      const shown = JSON.stringify(observation.semantic).replaceAll("fixture-email-value", "");
      expect(shown).not.toMatch(/fixture-/u);
    };
    try {
      const started = await driver.start(`http://127.0.0.1:${server.port}/`);
      let page = await driver.observe(started.target.id);
      expectNothingProtected(page);
      expect(JSON.stringify(page.semantic)).toContain("fixture-email-value");

      // Fields stay present, labelled and fillable; what they hold is withheld.
      expect(node(page, "textbox", "Password")).toMatchObject({
        value: { redacted: true, reason: "password" },
        actions: expect.arrayContaining(["fill"]),
      });
      expect(node(page, "textbox", "Notes")).toMatchObject({
        value: { redacted: true, reason: "private" },
        actions: expect.arrayContaining(["fill"]),
      });
      const expiry = node(page, "combobox", "Expiry");
      expect(expiry).toMatchObject({ value: { redacted: true, reason: "payment" } });
      expect(expiry.children ?? []).toEqual([]);
      const agree = node(page, "checkbox", "Agree");
      expect(agree.actions).toContain("check");
      expect(agree.states.some((state) => state.startsWith("checked"))).toBe(false);

      // Text around protected text stays readable.
      expect(node(page, "button", "Pay now")).toBeDefined();
      expect(node(page, "button", "Confirm")).toBeDefined();
      expect(node(page, "heading", "Heading")).toBeDefined();
      for (const text of ["Balance:", "NOK"]) expect(node(page, "text", text)).toBeDefined();

      // A description drawn from protected text keeps only its public part.
      expect(node(page, "button", "Help").description).toBeUndefined();
      expect(node(page, "textbox", "Search").description).toBe("Press enter");

      // A link inside a protected block keeps no address of its own.
      expect(JSON.stringify(page.semantic)).not.toContain("fixture-link-address");

      // Protected fields are filled by label and by ref.
      page = await act(page, {
        type: "fill",
        locator: { kind: "label", text: "Notes" },
        value: "a new note",
      });
      expectNothingProtected(page);
      expect(JSON.stringify(page.semantic)).not.toContain("a new note");
      expect(node(page, "text", "Notes length 10")).toBeDefined();
      page = await act(page, {
        type: "fill",
        locator: { kind: "ref", ref: node(page, "textbox", "Password").ref },
        value: "new-password",
      });
      expect(JSON.stringify(page.semantic)).not.toContain("new-password");
      expect(node(page, "text", "Password length 12")).toBeDefined();

      // Protected text cannot be found by searching for it either.
      for (const locator of [
        { kind: "text", text: "fixture-balance-secret", exact: true },
        { kind: "role", role: "button", name: "fixture-button-secret" },
      ] as const) {
        await expect(act(page, { type: "click", locator })).rejects.toMatchObject({
          code: "locator_not_found",
        });
      }
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

function node(
  observation: BrowserObservation,
  role: string,
  name: string,
): InteractionSemanticNodeValue {
  const found: InteractionSemanticNodeValue[] = [];
  const visit = (entry: InteractionSemanticNodeValue): void => {
    if (entry.role === role && entry.name === name) found.push(entry);
    for (const child of entry.children ?? []) visit(child);
  };
  if (observation.semantic?.kind === "snapshot")
    for (const root of observation.semantic.roots) visit(root);
  if (found.length === 0) throw new Error(`no ${role} named ${name}`);
  return found[0]!;
}
