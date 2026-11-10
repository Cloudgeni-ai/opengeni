// Run with Electron after bundling (external: electron), not with the Bun unit runner:
//   bun build test/electron/meeting-card.ts --target=node --format=cjs --external electron --outfile /tmp/meeting-card.cjs
//   xvfb-run -a electron --no-sandbox /tmp/meeting-card.cjs
// The real meeting card in a real window: Not now hides it at once, and the
// next card still times out although Chromium replays the pointer onto it.
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { MeetingPromptCard } from "../../src/main/meeting-detection/card";
import type { MeetingPrompt, MeetingPromptOutcome } from "../../src/main/meeting-detection";

app.on("window-all-closed", () => {});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const call: MeetingPrompt = {
  kind: "record",
  app: { id: "zoom", name: "Zoom", browser: false, title: "Zoom meeting" },
};

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(20);
  return check();
}

async function main() {
  const card = new MeetingPromptCard({
    platform: process.platform,
    icon: () => null,
    timeoutMs: 1_500,
  });
  try {
    await app.whenReady();
    const outcomes: MeetingPromptOutcome[] = [];
    card.show(call, (outcome) => outcomes.push(outcome));
    const shown = () => BrowserWindow.getAllWindows().filter((window) => window.isVisible());
    assert.ok(await until(() => shown().length === 1, 5_000), "the card shows");
    const window = shown()[0]!;
    const button = JSON.parse(
      await window.webContents.executeJavaScript(
        `JSON.stringify(document.getElementById("dismiss").getBoundingClientRect())`,
      ),
    ) as { x: number; y: number; width: number; height: number };
    const x = Math.round(button.x + button.width / 2);
    const y = Math.round(button.y + button.height / 2);
    window.webContents.sendInputEvent({ type: "mouseMove", x, y });
    window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    assert.ok(await until(() => outcomes.length === 1, 3_000), "Not now answers");
    assert.deepEqual(outcomes, ["dismissed"]);
    assert.equal(shown().length, 0, "Not now hides the card at once");

    // The next card shows in the same window, where the page last saw the pointer.
    card.show(call, (outcome) => outcomes.push(outcome));
    assert.ok(await until(() => shown().length === 1, 5_000), "the next card shows");
    assert.ok(
      await until(() => outcomes.length === 2, 6_000),
      "the next card times out: the pointer replayed onto it doesn't hold it",
    );
    assert.deepEqual(outcomes, ["dismissed", "expired"]);
    assert.equal(shown().length, 0);
    console.log("PASS: Not now hides the real card at once, and the next card still times out");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    card.destroy();
    app.exit(Number(process.exitCode ?? 0));
  }
}
void main();
