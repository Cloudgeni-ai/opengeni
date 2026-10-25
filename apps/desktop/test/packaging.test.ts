// What the packaged app keeps of Electron.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

test("the app ships Chromium's language files", () => {
  // electron-builder keeps only the listed languages, matched against file
  // names: "en" keeps macOS's en.lproj but deletes every locales/*.pak on Linux
  // and Windows, whose English file is en-US.pak. Chromium's own strings are
  // then empty there: libnotify drops a notification's default action, whose
  // label is one of them, so clicking a notification ("Record this
  // meeting?") does nothing. And app.getLocale() and navigator.language fall
  // back to English whatever the computer's language is.
  const config = Bun.YAML.parse(readFileSync(join(root, "electron-builder.yml"), "utf8")) as {
    electronLanguages?: unknown;
    linux?: { electronLanguages?: unknown };
    win?: { electronLanguages?: unknown };
    mac?: { electronLanguages?: unknown };
  };
  expect(config.electronLanguages).toBeUndefined();
  for (const platform of [config.linux, config.win, config.mac]) {
    expect(platform?.electronLanguages).toBeUndefined();
  }
});
