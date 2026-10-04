import { readFile, readlink, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";

export type LinuxManagedBrowserIdentity = {
  pid: number;
  startTime: string;
  executablePath: string;
};

export type LinuxProcessReader = {
  readFile(path: string): Promise<Uint8Array>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  hostname(): string;
};

const procfs: LinuxProcessReader = {
  readFile: async (path) => await readFile(path),
  readlink: async (path) => await readlink(path),
  realpath: async (path) => await realpath(path),
  hostname,
};

/** Match switches, never profile substrings or a shell interpretation of argv. */
export function matchLinuxBrowserArguments(input: {
  argv: readonly string[];
  profileDirectory: string;
  executablePath: string;
}): "arguments" | "title" | null {
  if (input.argv.length === 0) return null;
  let argumentsList = input.argv.slice(1);
  let representation: "arguments" | "title" = "arguments";
  if (input.argv.length === 1) {
    // Chromium rewrites argv as an unquoted, space-joined process title. Its
    // lossy representation additionally requires the exact profile PID lock.
    const title = input.argv[0]!;
    if (/[\u0000-\u001f\u007f'"\\]/u.test(title)) return null;
    const words = title.split(" ");
    if (words.some((word) => word.length === 0) || words[0] !== input.executablePath) {
      return null;
    }
    argumentsList = words.slice(1);
    representation = "title";
  }

  const profileArgument = `--user-data-dir=${resolve(input.profileDirectory)}`;
  let profiles = 0;
  for (const argument of argumentsList) {
    if (argument !== argument.trim() || argument === "--" || /\0/u.test(argument)) return null;
    if (/^--?type(?:=|$)/u.test(argument)) return null;
    if (/^--?user-data-dir(?:=|$)/u.test(argument)) {
      if (argument !== profileArgument || ++profiles !== 1) return null;
    }
  }
  return profiles === 1 ? representation : null;
}

/** A birth-time fence spans the procfs reads and every later signal check. */
export async function readLinuxManagedBrowserIdentity(
  input: {
    pid: number;
    profileDirectory: string;
    executablePath: string | null;
    expectedStartTime?: string;
  },
  reader: LinuxProcessReader = procfs,
): Promise<LinuxManagedBrowserIdentity | null> {
  if (!Number.isSafeInteger(input.pid) || input.pid < 2 || input.pid > 2_147_483_647) {
    return null;
  }
  const processDirectory = `/proc/${input.pid}`;
  try {
    const startTime = liveProcessStartTime(
      await reader.readFile(`${processDirectory}/stat`),
      input.pid,
    );
    if (
      !startTime ||
      (input.expectedStartTime !== undefined && startTime !== input.expectedStartTime)
    ) {
      return null;
    }
    const commandLine = decode(await reader.readFile(`${processDirectory}/cmdline`));
    if (commandLine === null) return null;
    const argv = commandLine.split("\0");
    // Rewritten titles can leave the original argv storage padded with NULs.
    while (argv.length > 1 && argv[argv.length - 1] === "") argv.pop();
    const executablePath = await reader.realpath(await reader.readlink(`${processDirectory}/exe`));
    if (input.executablePath) {
      if (executablePath !== (await reader.realpath(input.executablePath))) return null;
    } else if (!isRecognizedLinuxBrowserExecutable(executablePath)) {
      return null;
    }
    const representation = matchLinuxBrowserArguments({ ...input, argv, executablePath });
    if (representation === null) return null;
    let profileLock: string | null = null;
    if (representation === "title") {
      if (!isRecognizedLinuxBrowserExecutable(executablePath)) return null;
      profileLock = await reader.readlink(join(resolve(input.profileDirectory), "SingletonLock"));
      if (profileLock !== `${reader.hostname()}-${input.pid}`) return null;
    }
    // An exec or argv/lock change can retain the PID's original birth time.
    if (
      decode(await reader.readFile(`${processDirectory}/cmdline`)) !== commandLine ||
      (await reader.realpath(await reader.readlink(`${processDirectory}/exe`))) !==
        executablePath ||
      (profileLock !== null &&
        (await reader.readlink(join(resolve(input.profileDirectory), "SingletonLock"))) !==
          profileLock)
    ) {
      return null;
    }
    if (
      liveProcessStartTime(await reader.readFile(`${processDirectory}/stat`), input.pid) !==
      startTime
    ) {
      return null;
    }
    return { pid: input.pid, startTime, executablePath };
  } catch (error) {
    if (
      ["EACCES", "EINVAL", "ENOENT", "EPERM", "ESRCH"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return null;
    }
    throw error;
  }
}

function liveProcessStartTime(raw: Uint8Array, pid: number): string | null {
  const stat = decode(raw);
  if (stat === null || !stat.startsWith(`${pid} (`)) return null;
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTime = fields[19];
  return /^[RSDTtWI]$/u.test(fields[0] ?? "") && /^\d+$/u.test(startTime ?? "") ? startTime! : null;
}

function decode(raw: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

function isRecognizedLinuxBrowserExecutable(executablePath: string): boolean {
  return [
    "chrome",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "chrome-headless-shell",
  ].includes(basename(executablePath));
}
