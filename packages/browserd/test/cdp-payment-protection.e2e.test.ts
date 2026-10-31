import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction, BrowserObservation } from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
// Public synthetic fixtures, never a live payment profile.
const PAN = "4000000000000002";
const GROUPED = "4000 0000 0000 0002";
const CVC = "731";

e2e(
  "ordinary hidden metadata and expiry years do not poison later page reads or image eligibility",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-payment-metadata-");
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
    const ordinary = `<h1>Product catalog</h1><input type=hidden name=id value=40123456789012>
    <input type=hidden name=currency value=USD><p>Total 10 USD, ordered 2027-01-05, variant 40123456789012</p>`;
    try {
      const initial = await driver.start(`data:text/html,${encodeURIComponent(ordinary)}`);
      for (const observation of [initial, await driver.observe(initial.target.id)]) {
        expect(JSON.stringify(observation.semantic)).toContain(
          "Total 10 USD, ordered 2027-01-05, variant 40123456789012",
        );
      }
      expect((await driver.captureScreenshot(initial.target.id)).data.byteLength).toBeGreaterThan(
        100,
      );
      const autofilled = await driver.openTarget(
        `data:text/html,${encodeURIComponent(`<div id="credit-card"><label>Expiry year<select autocomplete="cc-exp-year"><option>2027</option></select></label><label>Postal code<input name="credit_card[zip]" value="0150"></label><input name="credit_card[year]" value="2027"><input value="${GROUPED}"><input type="hidden" value="40123456789012"></div><output>${GROUPED}</output>`)}`,
      );
      expect(JSON.stringify(autofilled.semantic)).not.toContain(GROUPED);
      const later = await driver.openTarget(`data:text/html,${encodeURIComponent(ordinary)}`);
      expect(JSON.stringify(later.semantic)).toContain(
        "Total 10 USD, ordered 2027-01-05, variant 40123456789012",
      );
      expect((await driver.captureScreenshot(later.target.id)).data.byteLength).toBeGreaterThan(
        100,
      );
      const yearAndPostal = await driver.openTarget(
        "data:text/html,<h1>Order 2027-01-05 to 0150 Oslo</h1>",
      );
      expect(JSON.stringify(yearAndPostal.semantic)).toContain("Order 2027-01-05 to 0150 Oslo");
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);

e2e(
  "payment values, formatted fills and image refusals share one protection boundary",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-payment-protection-");
    const page = `<title>Checkout fixture</title><h1 id="credit-card-offers">Credit card offers</h1>
    <label>Order <input value="Order 824601"></label>
    <label>Card number <input id="card-number" autocomplete="cc-number"
      oninput="this.value=this.value.replace(/[^0-9]/g,'').replace(/(.{4})/g,'$1 ').trim();document.querySelector('output').textContent=this.value"></label>
    <label>Security code <input autocomplete="cc-csc" value="${CVC}"></label><output></output>
    <label>Changed card <input autocomplete="cc-number" oninput="this.value=this.value+'9'"></label>
    <label>Ordinary digits <input oninput="this.value=this.value.replace(/(.{4})/g,'$1 ').trim()"></label>
    <button onclick="document.querySelector('#card-number').value='1111'">Alter number</button>
    <div id="open"></div><div id="closed"></div>
    <script>for(const mode of ['open','closed']) {
      document.getElementById(mode).attachShadow({mode}).innerHTML=
        '<label>'+mode+' card <input autocomplete="cc-number" value="${GROUPED}"></label>';
    }</script>`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(page, { headers: { "content-type": "text/html" } }),
    });
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
      driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observation.browserSessionId,
        controllerGeneration: observation.target.controllerGeneration,
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration,
        expectedFrameId: observation.frameId!,
        actor: { kind: "agent", subjectId: "payment-fixture" },
        action,
      });
    const safe = (value: unknown) => {
      const text = JSON.stringify((value as BrowserObservation).semantic);
      for (const secret of [PAN, GROUPED, CVC]) expect(text).not.toContain(secret);
      expect(text).toContain("Card number");
      expect(text).toContain("Order 824601");
      expect(text).toContain("Credit card offers");
    };
    try {
      let observation = await driver.start(String(server.url));
      safe(observation);
      observation = await act(observation, {
        type: "fill",
        locator: { kind: "label", text: "Card number", exact: true },
        value: PAN,
      });
      safe(observation);
      const card = JSON.stringify(observation.semantic);
      expect(card).toContain('"reason":"payment"');
      await expect(driver.captureScreenshot(observation.target.id)).rejects.toMatchObject({
        code: "unsupported",
      });
      await expect(
        driver.captureScreenshot(observation.target.id, { fullPage: true }),
      ).rejects.toMatchObject({ code: "unsupported" });
      // The prefilled CVC remains hidden without any secret-reference side map.
      safe(await driver.observe(observation.target.id));
      const state = await driver.targetState(observation.target.id);
      const dom = await driver.readDom(observation.target.id, {
        kind: "element",
        locator: { kind: "css", selector: "#card-number" },
        expectedTargetGeneration: state.targetGeneration,
        expectedDocumentGeneration: state.documentGeneration!,
        expectedFrameId: state.frameId!,
      });
      expect(dom).toMatchObject({ value: null, redacted: "payment" });
      await expect(
        act(observation, {
          type: "fill",
          locator: { kind: "label", text: "Changed card", exact: true },
          value: PAN,
        }),
      ).rejects.toMatchObject({ code: "outcome_unknown" });
      const fresh = await driver.observe(observation.target.id);
      await expect(
        act(fresh, {
          type: "fill",
          locator: { kind: "label", text: "Ordinary digits", exact: true },
          value: "12345678",
        }),
      ).rejects.toMatchObject({ code: "outcome_unknown" });
      const unrelated = await driver.openTarget("data:text/html,<h1>Unrelated work</h1>");
      expect((await driver.captureScreenshot(unrelated.target.id)).data.byteLength).toBeGreaterThan(
        100,
      );
      const echoed = await driver.openTarget(
        `data:text/html,${encodeURIComponent(`<h1>Confirmation</h1><p>${GROUPED}</p>`)}`,
      );
      expect(JSON.stringify(echoed.semantic)).not.toContain(GROUPED);
      await expect(driver.captureScreenshot(echoed.target.id)).rejects.toMatchObject({
        code: "unsupported",
      });
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);

for (const crossOrigin of [false, true]) {
  e2e(
    `payment values in a ${crossOrigin ? "cross-origin" : "same-origin"} frame stay hidden`,
    async () => {
      const directory = await mkdtemp("/tmp/ogb-payment-frame-");
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request): Response {
          const frame = new URL(request.url).pathname === "/frame";
          const page = frame
            ? `<label>Embedded card <input autocomplete="cc-number" value="${GROUPED}"></label>
        <label>Embedded security code <input autocomplete="cc-csc" value="${CVC}"></label>
        <button aria-label="Pay ${GROUPED}" aria-describedby="detail">Pay</button><p id="detail">${GROUPED}</p>`
            : `<title>Embedded checkout</title><h1>Public heading</h1><iframe src="http://${crossOrigin ? "localhost" : "127.0.0.1"}:${server.port}/frame"></iframe>`;
          return new Response(page, { headers: { "content-type": "text/html" } });
        },
      });
      const runner = await ManagedBrowserRunner.create({
        profileDirectory: join(directory, "profile"),
        headed: false,
        launchArguments: ["--site-per-process"],
        ...(process.env.OPENGENI_BROWSER_EXECUTABLE
          ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
          : {}),
      });
      const driver = new AgentBrowserDriver({
        browserSessionId: randomUUID(),
        controllerGeneration: randomUUID(),
        runner,
      });
      try {
        const observation = await driver.start(String(server.url));
        const text = JSON.stringify(observation.semantic);
        for (const secret of [PAN, GROUPED, CVC]) expect(text).not.toContain(secret);
        expect(text).toContain("Embedded card");
        expect(text).toContain("Embedded security code");
        expect(text).toContain("Public heading");
        await expect(driver.captureScreenshot(observation.target.id)).rejects.toMatchObject({
          code: "unsupported",
        });
        await expect(driver.subscribeFrames(observation.target.id)).rejects.toMatchObject({
          code: "unsupported",
        });
        await expect(
          driver.recordFrames(
            observation.target.id,
            () => {
              throw new Error("no payment image may leave the driver");
            },
            () => undefined,
          ),
        ).rejects.toMatchObject({ code: "unsupported" });
      } finally {
        await driver.close();
        server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );
}

e2e(
  "an ordinary screenshot stays usable and an active recording stops when payment fields appear",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-payment-recording-");
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
    let stop: (() => Promise<void>) | undefined;
    try {
      const initial = await driver.start(
        `data:text/html,${encodeURIComponent(`<title>Public page</title><h1>Welcome</h1>
      <button onclick="document.body.style.background='red';const input=document.createElement('input');input.autocomplete='cc-number';input.value='${GROUPED}';document.body.append(input)">Checkout</button>`)}`,
      );
      const screenshot = await driver.captureScreenshot(initial.target.id);
      expect(screenshot.data.byteLength).toBeGreaterThan(100);
      let resolveEnd!: (error: Error | null) => void;
      let resolveFrame!: () => void;
      const ended = new Promise<Error | null>((resolve) => {
        resolveEnd = resolve;
      });
      const firstFrame = new Promise<void>((resolve) => {
        resolveFrame = resolve;
      });
      const colors: Array<Promise<number[]>> = [];
      stop = await driver.recordFrames(
        initial.target.id,
        (jpeg) => {
          colors.push(
            (async () => {
              const sharp = (await import("sharp")).default;
              const { data } = await sharp(jpeg)
                .extract({ left: 0, top: 0, width: 1, height: 1 })
                .raw()
                .toBuffer({ resolveWithObject: true });
              return [...data];
            })(),
          );
          resolveFrame();
        },
        resolveEnd,
      );
      await Promise.race([
        firstFrame,
        Bun.sleep(5_000).then(() => {
          throw new Error("recording did not produce a public frame");
        }),
      ]);
      await driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: initial.browserSessionId,
        controllerGeneration: initial.target.controllerGeneration,
        targetId: initial.target.id,
        expectedTargetGeneration: initial.target.targetGeneration,
        expectedDocumentGeneration: initial.target.documentGeneration,
        expectedFrameId: initial.frameId!,
        actor: { kind: "agent", subjectId: "payment-recording-fixture" },
        action: { type: "click", locator: { kind: "role", role: "button", name: "Checkout" } },
      });
      const error = await Promise.race([
        ended,
        Bun.sleep(5_000).then(() => {
          throw new Error("payment recording was not stopped");
        }),
      ]);
      expect(error).toMatchObject({ code: "unsupported" });
      // No frame painted after the payment transition may escape, including
      // a frame already queued by the compositor when the click occurred.
      for (const [red, green, blue] of await Promise.all(colors)) {
        expect(red! > 200 && green! < 50 && blue! < 50).toBe(false);
      }
    } finally {
      await stop?.();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
