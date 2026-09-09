import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../.github/actions/playwright-browsers/with-google-feed-isolated.sh", import.meta.url),
);

test("runs normally when no Google feed is installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "playwright-apt-"));
  try {
    await Bun.write(join(dir, "ubuntu.sources"), "URIs: https://archive.ubuntu.com/ubuntu\n");
    const child = Bun.spawn(["bash", script, dir, "true"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await Bun.file(join(dir, "ubuntu.sources")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  ["list", "deb [arch=amd64] https://dl.google.com/linux/chrome-stable/deb/ stable main\n"],
  [
    "sources",
    "Types: deb\nURIs: https://dl.google.com/linux/chrome/deb/\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/google.gpg\n",
  ],
])(
  "isolates %s Google feed and restores exact bytes after command failure",
  async (extension, contents) => {
    const dir = await mkdtemp(join(tmpdir(), "playwright-apt-"));
    const name = `google-chrome.${extension}`;
    try {
      await Bun.write(join(dir, name), contents);
      await Bun.write(join(dir, "ubuntu.sources"), "URIs: https://archive.ubuntu.com/ubuntu\n");
      const child = Bun.spawn(
        [
          "bash",
          script,
          dir,
          "bash",
          "-c",
          'test ! -e "$1/$2" && test -f "$1/ubuntu.sources" || exit 99; exit 7',
          "check",
          dir,
          name,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(7);
      expect(await Bun.file(join(dir, name)).text()).toBe(contents);
      expect(await Bun.file(join(dir, "ubuntu.sources")).text()).toBe(
        "URIs: https://archive.ubuntu.com/ubuntu\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("refuses mixed Google and Ubuntu sources without hiding either feed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "playwright-apt-"));
  const contents =
    "deb https://dl.google.com/linux/chrome/deb/ stable main\ndeb https://archive.ubuntu.com/ubuntu noble main\n";
  try {
    await Bun.write(join(dir, "mixed.list"), contents);
    const child = Bun.spawn(["bash", script, dir, "touch", join(dir, "command-ran")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await Bun.file(join(dir, "mixed.list")).text()).toBe(contents);
    expect(await Bun.file(join(dir, "command-ran")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  [
    "list",
    "deb https://dl.google.com/linux/chrome/deb/ stable main\ndeb file:/srv/packages stable main\n",
  ],
  [
    "sources",
    "Types: deb\nURIs: https://dl.google.com/linux/chrome/deb/ file:/srv/packages\nSuites: stable\n",
  ],
  [
    "sources",
    "Types: deb\nURIs: https://dl.google.com/linux/chrome/deb/\n ftp://example.org/packages\nSuites: stable\n",
  ],
])("preserves mixed non-HTTP %s repositories", async (extension, contents) => {
  const dir = await mkdtemp(join(tmpdir(), "playwright-apt-"));
  const path = join(dir, `mixed.${extension}`);
  try {
    await Bun.write(path, contents);
    const child = Bun.spawn(["bash", script, dir, "touch", join(dir, "command-ran")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await Bun.file(path).text()).toBe(contents);
    expect(await Bun.file(join(dir, "command-ran")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
