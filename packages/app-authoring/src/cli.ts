import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  createOgAppSourceManifest,
  createPortableAppArchive,
  encodeOgAppSourceManifest,
  inspectPortableAppArchive,
  normalizePortableAppPath,
  sha256Hex,
  validatePortableAppEntries,
  type PortableAppArchiveEntry,
} from "./index";

export type OgAppCliIo = {
  cwd: string;
  stdout(message: string): void;
  stderr(message: string): void;
};

const DEFAULT_IO: OgAppCliIo = {
  cwd: process.cwd(),
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

function usage(): string {
  return [
    "usage:",
    '  og-app init [directory] --name "My app" [--slug my-app]',
    "  og-app validate <directory-or-archive>",
    "  og-app pack <directory> [--output app.ogapp.tar]",
    "  og-app --help",
  ].join("\n");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

async function collectDirectory(
  root: string,
  excludedAbsolutePath?: string,
): Promise<PortableAppArchiveEntry[]> {
  const entries: PortableAppArchiveEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      if (child.name === ".git" || child.name === "node_modules") continue;
      const absolute = join(directory, child.name);
      if (excludedAbsolutePath && resolve(absolute) === excludedAbsolutePath) continue;
      if (child.isSymbolicLink())
        throw new Error(`App source may not contain symlink ${absolute}.`);
      if (child.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!child.isFile())
        throw new Error(`App source may contain regular files only: ${absolute}.`);
      const info = await lstat(absolute);
      if (!info.isFile()) throw new Error(`App source changed while reading ${absolute}.`);
      const path = normalizePortableAppPath(relative(root, absolute).split(sep).join("/"));
      entries.push({
        path,
        bytes: new Uint8Array(await readFile(absolute)),
        ...((info.mode & 0o111) !== 0 ? { executable: true } : {}),
      });
    }
  }
  await visit(root);
  return entries;
}

async function initialize(args: string[], io: OgAppCliIo): Promise<number> {
  const directory = resolve(io.cwd, positional(args)[0] ?? ".");
  const name = option(args, "--name");
  if (!name) throw new Error("og-app init requires --name.");
  const slug = option(args, "--slug");
  const manifest = createOgAppSourceManifest({
    name,
    ...(slug === undefined ? {} : { slug }),
  });
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, "og-app.json");
  const entryPath = join(directory, manifest.entryPath);
  await writeFile(manifestPath, encodeOgAppSourceManifest(manifest), { flag: "wx", mode: 0o600 });
  await writeFile(
    entryPath,
    `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${manifest.name.replace(/[&<>"']/gu, "")}</title>\n</head>\n<body>\n  <main>\n    <h1>${manifest.name.replace(/[&<>"']/gu, "")}</h1>\n    <p>Your OpenGeni App is ready to build.</p>\n  </main>\n</body>\n</html>\n`,
    { flag: "wx", mode: 0o600 },
  );
  io.stdout(`${JSON.stringify({ directory, manifest: manifestPath, entryPath }, null, 2)}\n`);
  return 0;
}

async function validate(target: string, io: OgAppCliIo): Promise<number> {
  const absolute = resolve(io.cwd, target);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error("og-app validate refuses symlink targets.");
  const result = info.isDirectory()
    ? validatePortableAppEntries(await collectDirectory(absolute))
    : inspectPortableAppArchive(new Uint8Array(await readFile(absolute)));
  io.stdout(
    `${JSON.stringify(
      {
        valid: true,
        target: absolute,
        name: result.sourceManifest.name,
        slug: result.sourceManifest.slug,
        appVersion: result.sourceManifest.appVersion,
        entryPath: result.sourceManifest.entryPath,
        fileCount: result.entries.length,
        totalBytes: result.entries.reduce((total, entry) => total + entry.bytes.byteLength, 0),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function pack(args: string[], io: OgAppCliIo): Promise<number> {
  const directory = resolve(io.cwd, positional(args)[0] ?? ".");
  const requestedOutput = option(args, "--output");
  const output = resolve(io.cwd, requestedOutput ?? `${basename(directory)}.ogapp.tar`);
  const entries = await collectDirectory(directory, output);
  const { sourceManifest } = validatePortableAppEntries(entries);
  const archive = createPortableAppArchive(entries);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, archive, { flag: "wx", mode: 0o600 });
  io.stdout(
    `${JSON.stringify(
      {
        output,
        format: "portable_tar_v1",
        app: sourceManifest.slug,
        appVersion: sourceManifest.appVersion,
        sizeBytes: archive.byteLength,
        sha256: sha256Hex(archive),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

export async function runOgAppCli(args: string[], io: OgAppCliIo = DEFAULT_IO): Promise<number> {
  const command = args[0];
  const rest = args.slice(1);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.stdout(`${usage()}\n`);
    return command ? 0 : 1;
  }
  if (command === "init") return await initialize(rest, io);
  if (command === "validate") {
    const target = positional(rest)[0];
    if (!target) throw new Error("og-app validate requires a directory or archive.");
    return await validate(target, io);
  }
  if (command === "pack") return await pack(rest, io);
  throw new Error(`Unknown og-app command ${command}.\n${usage()}`);
}
