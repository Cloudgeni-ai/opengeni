import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Playwright apt isolation removes only exact Chrome sources and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "playwright-apt-"));
  const directory = join(root, "sources.list.d");
  await mkdir(directory);
  const other = "deb [signed-by=/keys/ubuntu.gpg] https://archive.ubuntu.com/ubuntu noble main\n";
  const deceptive = [
    "https://dl.google.com.evil/linux/chrome/deb",
    "https://dl.google.com/linux/other/deb",
    "https://dl.google.com/linux/chrome/deb?keep=1",
  ];
  const list =
    other +
    "# deb https://dl.google.com/linux/chrome/deb stable main\n" +
    "deb [arch=amd64 signed-by=/keys/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main\n" +
    "deb-src http://dl.google.com/linux/chrome-stable/deb stable main\n" +
    deceptive.map((uri) => `deb ${uri} stable main\n`).join("");
  const ubuntuStanza =
    "Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main\nSigned-By: /keys/ubuntu.gpg\n";
  const mixed =
    "Types: deb deb-src\nURIs: https://dl.google.com/linux/chrome-stable/deb\n https://archive.ubuntu.com/ubuntu\n# preserve comment\nSuites: noble\nComponents: main\nSigned-By: /keys/ubuntu.gpg\n";
  const google =
    "Types: deb\nURIs: https://dl.google.com/linux/chrome/deb\nSuites: stable\nSigned-By: /keys/google.gpg\n";
  try {
    await writeFile(join(root, "sources.list"), list);
    await writeFile(join(directory, "mixed.sources"), mixed + "\n" + google + "\n" + ubuntuStanza);
    await writeFile(join(directory, "untouched.list"), other);
    const run = async () => {
      const child = Bun.spawn(
        ["python3", ".github/actions/playwright-browsers/exclude-google-chrome-apt.py", root],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(0);
    };
    await run();
    const actualList = await readFile(join(root, "sources.list"), "utf8");
    expect(actualList).toContain(other);
    for (const uri of deceptive) expect(actualList).toContain(`\ndeb ${uri} stable main\n`);
    expect(actualList.split("\n").filter((line) => /^deb(?:-src)? /.test(line))).toHaveLength(4);
    expect(await readFile(join(directory, "untouched.list"), "utf8")).toBe(other);
    const actualSources = await readFile(join(directory, "mixed.sources"), "utf8");
    expect(actualSources).toBe(
      "Types: deb deb-src\nURIs: https://archive.ubuntu.com/ubuntu\n# preserve comment\nSuites: noble\nComponents: main\nSigned-By: /keys/ubuntu.gpg\n\n" +
        google
          .split("\n")
          .map((line) => (line ? "# Disabled for Playwright: " + line : line))
          .join("\n") +
        "\n" +
        ubuntuStanza,
    );
    await run();
    expect(await readFile(join(root, "sources.list"), "utf8")).toBe(actualList);
    expect(await readFile(join(directory, "mixed.sources"), "utf8")).toBe(actualSources);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  [
    "continuation",
    "Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\n https://dl.google.com/linux/chrome/deb/\nSuites: noble\nSigned-By:\n -----BEGIN PGP PUBLIC KEY BLOCK-----\n .\n signature\n -----END PGP PUBLIC KEY BLOCK-----\n",
    "Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble\nSigned-By:\n -----BEGIN PGP PUBLIC KEY BLOCK-----\n .\n signature\n -----END PGP PUBLIC KEY BLOCK-----\n",
  ],
  [
    "unrelated",
    "Types: deb\nURIs: https://dl.google.com/linux/chrome/deb// https://dl.google.com:443/linux/chrome/deb https://packages.microsoft.com/repos/code\nSuites: stable\nEnabled: no\n",
    null,
  ],
  [
    "crlf",
    "Types: deb\r\nURIs: https://dl.google.com/linux/chrome/deb https://archive.ubuntu.com/ubuntu\r\nSigned-By: /keys/key.gpg\r\n",
    "Types: deb\r\nURIs: https://archive.ubuntu.com/ubuntu\r\nSigned-By: /keys/key.gpg\r\n",
  ],
])("deb822 %s preserves other source configuration", async (_label, source, expected) => {
  const root = await mkdtemp(join(tmpdir(), "playwright-apt-"));
  await mkdir(join(root, "sources.list.d"));
  const path = join(root, "sources.list.d", "fixture.sources");
  try {
    await writeFile(path, source!);
    const child = Bun.spawn(
      ["python3", ".github/actions/playwright-browsers/exclude-google-chrome-apt.py", root],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect(await readFile(path, "utf8")).toBe(expected ?? source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
