import { expect, test } from "bun:test";

import { guideHtml, placeGuide } from "../src/permission-guide";

const base = {
  appName: "Acme",
  appIcon: "",
  listName: "Files & Folders",
  step: { title: "Turn on Acme's folders", body: "Open Acme in the list." },
  progress: "Step 3 of 3",
  done: "Done",
  systemPrompt: { title: "t", body: "b", open: "Open System Settings", deny: "Deny" },
  quitOffer: { title: "t", body: "b", quit: "Quit & Reopen", later: "Later" },
  close: "Close",
  dark: false,
  side: "right" as const,
};

test("the folders step pictures the app's row opened, with a switch under it", () => {
  const folders = guideHtml({ ...base, disclosure: true });
  expect(folders).toContain('class="chev"');
  expect(folders).toContain('class="row sub"');
  const screen = guideHtml(base);
  expect(screen).not.toContain('class="chev"');
  expect(screen).toContain('class="switch"');
});

test("a taller guide still stays inside the screen", () => {
  const placed = placeGuide(
    { x: 100, y: 600, width: 700, height: 500 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    { width: 320, height: 276 },
  );
  expect(placed.y + placed.height).toBeLessThanOrEqual(1080 - 8);
  expect(placed.side).toBe("right");
});
