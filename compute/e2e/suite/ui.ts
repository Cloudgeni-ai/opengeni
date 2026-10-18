// The web UI pass: opens the suite's session in Opengeni's web app with
// Playwright, opens its workspace (the session header's "Open workspace")
// and uses the Files, Terminal and Desktop tabs as a person would.
// Writes $OUT/ui.json ({ files, terminal, desktop } → "pass: ..." or
// "fail: ...") and a screenshot per tab.
import { writeFileSync } from "node:fs";

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const OPENGENI_URL = need("OPENGENI_URL");
const API_CONTRACT = need("API_CONTRACT");
const OUT = need("OUT");
const WORKSPACE = need("WORKSPACE");
const SESSION = need("SESSION");
const MARKER = need("MARKER");
const { chromium } = await import(need("PLAYWRIGHT_MODULE"));

const results: Record<string, string> = {};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(60_000);

/** Opens the workspace dock if it is closed, then the tab `name` in it. */
async function tab(name: string) {
  const open = page.getByRole("button", { name: "Open workspace", exact: true });
  if (await open.first().isVisible().catch(() => false)) await open.first().click();
  const panels = page.getByRole("tablist", { name: "Workspace panels" });
  await panels.first().waitFor();
  // A tab's name may carry a count after its label.
  await panels.getByRole("tab", { name: new RegExp(`^${name}\\b`) }).first().click();
}

async function step(name: string, run: () => Promise<string>) {
  try {
    results[name] = `pass: ${await run()}`;
  } catch (error) {
    results[name] = `fail: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
  await page.screenshot({ path: `${OUT}/ui-${name}.png` }).catch(() => undefined);
}

await page.goto(`${OPENGENI_URL}/workspaces/${WORKSPACE}/sessions/${SESSION}`);
await page.waitForLoadState("networkidle").catch(() => undefined);

await step("files", async () => {
  await tab("Files");
  await page.getByText("e2e", { exact: true }).first().click();
  await page.getByText("hello.txt", { exact: true }).first().waitFor();
  return "the file browser lists e2e/hello.txt";
});

await step("terminal", async () => {
  await tab("Terminal");
  const terminal = page.locator(".xterm").first();
  await terminal.waitFor();
  await terminal.click();
  const typed = `ui-${MARKER}`;
  await page.keyboard.type(`echo ${typed} > e2e/ui-terminal.txt\n`, { delay: 20 });
  // The terminal may draw with WebGL, so read the effect back through the API.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${OPENGENI_URL}/v1/workspaces/${WORKSPACE}/sessions/${SESSION}/fs/read`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opengeni-api-contract": API_CONTRACT },
      body: JSON.stringify({ path: "e2e/ui-terminal.txt" }),
    });
    if (response.ok && String((await response.json()).content).includes(typed)) {
      return "a command typed into the terminal ran in the sandbox";
    }
    await page.waitForTimeout(2000);
  }
  throw new Error("the typed command left no file");
});

await step("desktop", async () => {
  await tab("Desktop");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    for (const canvas of await page.locator("canvas").all()) {
      const box = await canvas.boundingBox().catch(() => null);
      if (box && box.width >= 400 && box.height >= 300) {
        return `a ${Math.round(box.width)}x${Math.round(box.height)} desktop view is drawn`;
      }
    }
    await page.waitForTimeout(2000);
  }
  throw new Error("no desktop view within 3 minutes");
});

await browser.close();
writeFileSync(`${OUT}/ui.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
