import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction, BrowserObservation } from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

// Phone fields that format the number as it is typed hold the requested
// number in another form: the fill is done, not of unknown outcome. A field
// that changed the number itself still is. Synthetic numbers only.
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const page = `<!doctype html><title>Phone</title>
<label for="country">Country phone</label><input id="country" type="tel">
<label for="area">Area phone</label><input id="area" type="tel">
<label for="short">Short phone</label><input id="short" type="tel">
<label for="amount">Amount</label><input id="amount">
<p id="log">Formatted</p>
<script>
const on = (id, format) => document.getElementById(id).addEventListener("input", (event) => {
  event.target.value = format(event.target.value);
  document.getElementById("log").textContent = "Formatted " + id + " " + event.target.value;
});
// Puts the country code in front and groups the digits.
on("country", (value) => {
  const digits = value.replace(/\\D/g, "").replace(/^0/, "");
  return digits ? "+47 " + digits.replace(/(\\d{3})(\\d{2})(\\d+)/, "$1 $2 $3") : "";
});
// Brackets around the area code.
on("area", (value) => {
  const digits = value.replace(/\\D/g, "");
  return digits.length === 10 ? "(" + digits.slice(0, 3) + ") " + digits.slice(3, 6) + "-" + digits.slice(6) : value;
});
// Keeps only the first eight digits: the number changed.
on("short", (value) => value.replace(/\\D/g, "").slice(0, 8));
// Brackets mean a negative amount here, not formatting.
on("amount", (value) => (value === "15" ? "(15)" : value));
</script>`;

e2e(
  "a fill that a phone field formats is done; a changed number stays unknown",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(page, { headers: { "content-type": "text/html" } }),
    });
    const directory = await mkdtemp("/tmp/ogb-fill-formatted-");
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
        actor: { kind: "agent", subjectId: "fill-formatted" },
        action,
      });
    const fill = (label: string, value: string): BrowserAction => ({
      type: "fill",
      locator: { kind: "label", text: label, exact: true },
      value,
    });
    try {
      const started = await driver.start(`http://127.0.0.1:${server.port}/`);
      const targetId = started.target.id;

      expect(
        JSON.stringify(
          await act(await driver.observe(targetId), fill("Country phone", "41234567")),
        ),
      ).toContain("Formatted country +47 412 34 567");
      expect(
        JSON.stringify(
          await act(await driver.observe(targetId), fill("Country phone", "041234567")),
        ),
      ).toContain("Formatted country +47 412 34 567");
      expect(
        JSON.stringify(await act(await driver.observe(targetId), fill("Area phone", "4155551234"))),
      ).toContain("Formatted area (415) 555-1234");

      for (const [label, value] of [
        ["Short phone", "4123456789"],
        ["Amount", "15"],
      ] as const) {
        const failure = await act(await driver.observe(targetId), fill(label, value)).then(
          () => null,
          (error: unknown) => error,
        );
        expect(String(failure)).toContain("did not keep the requested value");
      }
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
