import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");
const script = join(repository, "docker/distrust-embedded-roots.ts");
const roots = join(repository, "docker/distrusted-roots.pem");

async function rootDers(): Promise<Buffer[]> {
  const pem = await readFile(roots, "utf8");
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g)].map(
    (match) => Buffer.from(match[1]!.replace(/\s+/g, ""), "base64"),
  );
}

function run(...args: string[]) {
  const child = Bun.spawnSync([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: child.exitCode, output: `${child.stdout}${child.stderr}` };
}

async function withBinary(contents: Buffer, check: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "distrust-embedded-roots-"));
  try {
    // Not named `bun` or `node` and not an ELF file, so the script never runs it.
    const path = join(directory, "program");
    await writeFile(path, contents, { mode: 0o755 });
    await check(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("distrust-embedded-roots", () => {
  test("pins exactly the four emSign roots", async () => {
    const ders = await rootDers();
    expect(ders).toHaveLength(4);
    for (const der of ders) expect(der.includes(Buffer.from("emSign"))).toBe(true);
  });

  test("rewrites each embedded root in place, idempotently, and leaves other bytes alone", async () => {
    const ders = await rootDers();
    const filler = Buffer.alloc(64, 0x5a);
    const original = Buffer.concat(ders.flatMap((der) => [filler, der]).concat(filler));
    await withBinary(original, async (path) => {
      expect(run("--check", roots, path).exitCode).not.toBe(0);

      expect(run(roots, path).exitCode).toBe(0);
      const patched = await readFile(path);
      expect(patched.length).toBe(original.length);
      for (const der of ders) expect(patched.includes(der)).toBe(false);
      const changed = [...patched.keys()].filter((index) => patched[index] !== original[index]);
      // Only the "em" of each "emSign" occurrence changes.
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.every((index) => patched[index] === "x".charCodeAt(0))).toBe(true);

      expect(run(roots, path).exitCode).toBe(0);
      expect((await readFile(path)).equals(patched)).toBe(true);
      expect(run("--check", roots, path).exitCode).toBe(0);
    });
  });

  test("rewrites roots embedded as PEM text, keeping its line breaks", async () => {
    const ders = await rootDers();
    // Node embeds its roots as PEM, wrapped at a width of its own choosing.
    const pem = (der: Buffer) =>
      `-----BEGIN CERTIFICATE-----\n${der
        .toString("base64")
        .match(/.{1,72}/g)!
        .join("\n")}\n-----END CERTIFICATE-----\n`;
    const original = Buffer.from(ders.map((der) => `\0${pem(der)}\0`).join(""), "latin1");
    await withBinary(original, async (path) => {
      expect(run("--check", roots, path).exitCode).not.toBe(0);
      expect(run(roots, path).exitCode).toBe(0);
      const patched = (await readFile(path)).toString("latin1");
      expect(patched.length).toBe(original.length);
      const blocks = [
        ...patched.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g),
      ];
      expect(blocks).toHaveLength(ders.length);
      for (const [index, block] of blocks.entries()) {
        const der = Buffer.from(block[1]!.replace(/\s+/g, ""), "base64");
        expect(der.equals(ders[index]!)).toBe(false);
        expect(der.toString("latin1")).toBe(
          ders[index]!.toString("latin1").replaceAll("emSign", "xxSign"),
        );
      }
      // Every byte that is not base64 text, including each line break, is unchanged.
      const layout = (text: string) => text.replace(/[A-Za-z0-9+/=]/g, "*");
      expect(layout(patched)).toBe(layout(original.toString("latin1")));
      expect(run("--check", roots, path).exitCode).toBe(0);
      expect(run(roots, path).exitCode).toBe(0);
      expect((await readFile(path)).toString("latin1")).toBe(patched);
    });
  });

  test("passes a binary without the roots and rejects ambiguous duplicates", async () => {
    await withBinary(Buffer.from("no certificates here"), async (path) => {
      expect(run(roots, path).exitCode).toBe(0);
      expect(run("--check", roots, path).exitCode).toBe(0);
    });
    const [first] = await rootDers();
    await withBinary(Buffer.concat([first!, first!]), async (path) => {
      expect(run(roots, path).exitCode).not.toBe(0);
    });
  });
});

// Every image stage that runs or ships Bun for the target uses the distrusted
// binary. Build-machine stages (--platform=$BUILDPLATFORM) ship no Bun.
describe("image Bun stages use the distrusted Bun", () => {
  for (const [file, stage] of [
    ["docker/opengeni.Dockerfile", "bun-distrusted"],
    ["docker/sandbox.Dockerfile", "bun-runtime"],
    ["docker/desktop.Dockerfile", "bun-runtime"],
    ["docker/backup.Dockerfile", "bun"],
  ] as const) {
    test(file, async () => {
      const dockerfile = await readFile(join(repository, file), "utf8");
      expect(dockerfile).toContain(
        "FROM oven/bun:${BUN_VERSION} AS bun-target\n" +
          `FROM --platform=$BUILDPLATFORM oven/bun:\${BUN_VERSION} AS ${stage}\n` +
          "COPY --from=bun-target /usr/local/bin/bun /out/bun\n" +
          "RUN --mount=type=bind,source=docker,target=/opt/opengeni-docker \\\n" +
          "  bun /opt/opengeni-docker/distrust-embedded-roots.ts /opt/opengeni-docker/distrusted-roots.pem /out/bun\n",
      );
      const targetBunStages = [
        ...dockerfile.matchAll(/^FROM oven\/bun:\$\{BUN_VERSION\}\S* AS (\S+)\n(.*)$/gmu),
      ].filter((match) => match[1] !== "bun-target");
      for (const [, name, firstLine] of targetBunStages) {
        expect({ name, firstLine }).toEqual({
          name,
          firstLine: `COPY --from=${stage} /out/bun /usr/local/bin/bun`,
        });
      }
      expect(dockerfile).not.toMatch(
        /COPY --from=\S+ \/usr\/local\/bin\/bun \/usr\/local\/bin\/bun/u,
      );
    });
  }
});

describe("image Node stages use the distrusted Node", () => {
  for (const file of ["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"]) {
    test(file, async () => {
      const dockerfile = await readFile(join(repository, file), "utf8");
      expect(dockerfile).toContain(
        "FROM node:22.22.0-bookworm-slim AS node-target\n" +
          "FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS node-runtime\n" +
          "COPY --from=node-target /usr/local/bin/node /out/node\n" +
          "RUN --mount=type=bind,source=docker,target=/opt/opengeni-docker \\\n" +
          "  bun /opt/opengeni-docker/distrust-embedded-roots.ts /opt/opengeni-docker/distrusted-roots.pem /out/node\n",
      );
      expect(dockerfile).toContain("COPY --from=node-runtime /out/node /usr/local/bin/node");
      expect(dockerfile).not.toMatch(
        /COPY --from=\S+ \/usr\/local\/bin\/node \/usr\/local\/bin\/node/u,
      );
      expect(dockerfile.match(/^FROM node:/gmu)).toHaveLength(1);
    });
  }
});
