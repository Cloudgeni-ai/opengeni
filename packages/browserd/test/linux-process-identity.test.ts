import { describe, expect, test } from "bun:test";
import {
  matchLinuxBrowserArguments,
  readLinuxManagedBrowserIdentity,
  type LinuxProcessReader,
} from "../src/linux-process-identity";

const executablePath = "/opt/example/chromium";
const profileDirectory = "/tmp/example-browser/profile";
const profileArgument = `--user-data-dir=${profileDirectory}`;
const pid = 41000;
const encoder = new TextEncoder();

function processStat(startTime = "123456", state = "S", processId = pid): string {
  const fields = [state, "1", ...Array<string>(17).fill("0"), startTime, "0"];
  return `${processId} (fixture ) browser) ${fields.join(" ")}\n`;
}

function fixture(
  options: {
    argv?: string[];
    title?: string;
    executable?: string;
    lock?: string;
    stats?: string[];
    unreadable?: string;
    malformedCommand?: Uint8Array;
    commands?: string[];
    executables?: string[];
    locks?: string[];
    missingLock?: boolean;
  } = {},
) {
  const stats = options.stats ?? [processStat(), processStat()];
  let statReads = 0;
  let commandReads = 0;
  let executableReads = 0;
  let lockReads = 0;
  const reads: string[] = [];
  const reader: LinuxProcessReader = {
    async readFile(path) {
      reads.push(path);
      if (options.unreadable)
        throw Object.assign(new Error("fixture read failed"), { code: options.unreadable });
      if (path.endsWith("/stat"))
        return encoder.encode(stats[Math.min(statReads++, stats.length - 1)]!);
      if (options.malformedCommand) return options.malformedCommand;
      if (options.commands)
        return encoder.encode(
          options.commands[Math.min(commandReads++, options.commands.length - 1)]!,
        );
      return encoder.encode(
        (options.title ?? (options.argv ?? [executablePath, profileArgument]).join("\0")) + "\0",
      );
    },
    async readlink(path) {
      reads.push(path);
      if (path.endsWith("/exe"))
        return (
          options.executables?.[Math.min(executableReads++, options.executables.length - 1)] ??
          options.executable ??
          executablePath
        );
      if (options.missingLock)
        throw Object.assign(new Error("fixture lock absent"), { code: "ENOENT" });
      return (
        options.locks?.[Math.min(lockReads++, options.locks.length - 1)] ??
        options.lock ??
        `fixture-host-${pid}`
      );
    },
    async realpath(path) {
      return path;
    },
    hostname: () => "fixture-host",
  };
  const input = { pid, profileDirectory, executablePath };
  return { reader, input, reads };
}

describe("Linux managed browser argument identity", () => {
  test("accepts exact NUL arguments and a conservative rewritten Chromium title", () => {
    expect(
      matchLinuxBrowserArguments({
        argv: [executablePath, "--no-first-run", profileArgument],
        profileDirectory,
        executablePath,
      }),
    ).toBe("arguments");
    expect(
      matchLinuxBrowserArguments({
        argv: [`${executablePath} --no-first-run ${profileArgument} --restore-last-session`],
        profileDirectory,
        executablePath,
      }),
    ).toBe("title");
    const spacedProfile = "/tmp/example browser/profile";
    expect(
      matchLinuxBrowserArguments({
        argv: [executablePath, `--user-data-dir=${spacedProfile}`],
        profileDirectory: spacedProfile,
        executablePath,
      }),
    ).toBe("arguments");
    expect(
      matchLinuxBrowserArguments({
        argv: [`${executablePath} --user-data-dir=${spacedProfile}`],
        profileDirectory: spacedProfile,
        executablePath,
      }),
    ).toBeNull();
  });

  for (const flags of [
    `${profileArgument}-other`,
    `${profileArgument}/other`,
    `--user-data-dir=/tmp/other ${profileArgument}`,
    `${profileArgument} ${profileArgument}`,
    `${profileArgument} --user-data-dir`,
    `${profileArgument} -user-data-dir=/tmp/other`,
    `--user-data-dir ${profileDirectory}`,
    `--note=${profileArgument}`,
    `${profileArgument} --type=renderer`,
    `${profileArgument} --type=zygote`,
    `${profileArgument} --type=`,
    `${profileArgument} --type`,
    `${profileArgument} -type=renderer`,
    `${profileArgument} --type= --type=renderer`,
    `-- ${profileArgument}`,
    `"${profileArgument}"`,
    `${profileArgument} --note='two words'`,
    `${profileArgument} --note=two\\ words`,
    `${profileArgument}\t--type=renderer`,
    `${profileArgument}\n--type=renderer`,
    `${profileArgument}  --no-first-run`,
  ]) {
    test(`rejects ambiguous rewritten flags: ${JSON.stringify(flags)}`, () => {
      expect(
        matchLinuxBrowserArguments({
          argv: [`${executablePath} ${flags}`],
          profileDirectory,
          executablePath,
        }),
      ).toBeNull();
    });
  }

  test("checks all protected NUL arguments and never treats argv[0] as a switch", () => {
    for (const argv of [
      [profileArgument, "--no-first-run"],
      [executablePath, profileArgument, profileArgument],
      [executablePath, profileArgument, "--type="],
      [executablePath, profileArgument, "-user-data-dir=/tmp/other"],
      [executablePath, "--", profileArgument],
      [executablePath, `--note=${profileArgument}`],
      [executablePath, profileArgument, " --user-data-dir=/tmp/other"],
      [executablePath, profileArgument, " --type=renderer"],
      [executablePath, profileArgument, "--type=renderer "],
    ])
      expect(matchLinuxBrowserArguments({ argv, profileDirectory, executablePath })).toBeNull();
    expect(
      matchLinuxBrowserArguments({
        argv: [`/opt/other/chromium ${profileArgument}`],
        profileDirectory,
        executablePath,
      }),
    ).toBeNull();
  });
});

describe("Linux managed browser process fences", () => {
  test("binds exact executable and start time through consistent procfs reads", async () => {
    const f = fixture();
    expect(await readLinuxManagedBrowserIdentity(f.input, f.reader)).toEqual({
      pid,
      startTime: "123456",
      executablePath,
    });
    expect(f.reads.filter((path) => path.endsWith("/stat"))).toHaveLength(2);
    expect(f.reads.some((path) => path.endsWith("SingletonLock"))).toBe(false);
  });

  test("requires a same-host same-PID private profile lock for lossy titles", async () => {
    const title = `${executablePath} --no-first-run ${profileArgument}`;
    const f = fixture({ title });
    expect(await readLinuxManagedBrowserIdentity(f.input, f.reader)).toEqual({
      pid,
      startTime: "123456",
      executablePath,
    });
    expect(f.reads).toContain(`${profileDirectory}/SingletonLock`);
    const padded = fixture({ commands: [title + "\0".repeat(128)] });
    expect(await readLinuxManagedBrowserIdentity(padded.input, padded.reader)).not.toBeNull();
    for (const lock of [
      "fixture-host-41001",
      `other-host-${pid}`,
      `fixture-host-${pid}-other`,
      `/tmp/fixture-host-${pid}`,
    ]) {
      const wrong = fixture({ title, lock });
      expect(await readLinuxManagedBrowserIdentity(wrong.input, wrong.reader)).toBeNull();
    }
    const missing = fixture({ title, missingLock: true });
    expect(await readLinuxManagedBrowserIdentity(missing.input, missing.reader)).toBeNull();
  });

  test("an embedded title flag cannot confer ownership of another profile", async () => {
    const f = fixture({
      title: `${executablePath} --note=embedded ${profileArgument}`,
      lock: "fixture-host-41001",
    });
    expect(await readLinuxManagedBrowserIdentity(f.input, f.reader)).toBeNull();
  });

  test("preserves configured-executable and recognized recovery ceilings", async () => {
    const wrong = fixture({ executable: "/opt/other/chromium" });
    expect(await readLinuxManagedBrowserIdentity(wrong.input, wrong.reader)).toBeNull();
    const recovery = fixture();
    expect(
      await readLinuxManagedBrowserIdentity(
        { ...recovery.input, executablePath: null },
        recovery.reader,
      ),
    ).not.toBeNull();
    const unrelated = fixture({ executable: "/opt/example/other-process" });
    expect(
      await readLinuxManagedBrowserIdentity(
        { ...unrelated.input, executablePath: null },
        unrelated.reader,
      ),
    ).toBeNull();
    const foreignTitle = fixture({
      executable: "/opt/example/other-process",
      title: `/opt/example/other-process ${profileArgument}`,
    });
    expect(
      await readLinuxManagedBrowserIdentity(
        { ...foreignTitle.input, executablePath: "/opt/example/other-process" },
        foreignTitle.reader,
      ),
    ).toBeNull();
  });

  test("rejects PID reuse during reads and before later signal revalidation", async () => {
    const raced = fixture({ stats: [processStat("123456"), processStat("123457")] });
    expect(await readLinuxManagedBrowserIdentity(raced.input, raced.reader)).toBeNull();
    const first = fixture();
    const identity = await readLinuxManagedBrowserIdentity(first.input, first.reader);
    const reused = fixture({ stats: [processStat("123457")] });
    expect(
      await readLinuxManagedBrowserIdentity(
        { ...reused.input, expectedStartTime: identity!.startTime },
        reused.reader,
      ),
    ).toBeNull();
    expect(reused.reads).toEqual([`/proc/${pid}/stat`]);
    const same = fixture();
    expect(
      await readLinuxManagedBrowserIdentity(
        { ...same.input, expectedStartTime: identity!.startTime },
        same.reader,
      ),
    ).toEqual(identity);
  });

  test("rejects argv, executable and private lock changes within one process lifetime", async () => {
    const commands = [
      `${executablePath}\0${profileArgument}\0`,
      `${executablePath}\0${profileArgument}\0--type=renderer\0`,
    ];
    const argvRace = fixture({ commands });
    expect(await readLinuxManagedBrowserIdentity(argvRace.input, argvRace.reader)).toBeNull();
    const execRace = fixture({ executables: [executablePath, "/opt/other/chromium"] });
    expect(await readLinuxManagedBrowserIdentity(execRace.input, execRace.reader)).toBeNull();
    const lockRace = fixture({
      title: `${executablePath} ${profileArgument}`,
      locks: [`fixture-host-${pid}`, "fixture-host-41001"],
    });
    expect(await readLinuxManagedBrowserIdentity(lockRace.input, lockRace.reader)).toBeNull();
  });

  test("rejects dead, mismatched, malformed and invalid UTF-8 process records", async () => {
    for (const stat of [
      processStat("123456", "Z"),
      processStat("123456", "X"),
      processStat("bad"),
      processStat("123456", "S", pid + 1),
      "invalid",
    ]) {
      const f = fixture({ stats: [stat] });
      expect(await readLinuxManagedBrowserIdentity(f.input, f.reader)).toBeNull();
    }
    const f = fixture({ malformedCommand: new Uint8Array([0xff, 0x00]) });
    expect(await readLinuxManagedBrowserIdentity(f.input, f.reader)).toBeNull();
  });

  for (const code of ["EACCES", "EINVAL", "ENOENT", "EPERM", "ESRCH"]) {
    test(`does not select an unreadable or vanished process (${code})`, async () => {
      const f = fixture({ unreadable: code });
      expect(await readLinuxManagedBrowserIdentity(f.input, f.reader)).toBeNull();
    });
  }

  test("surfaces an unexpected procfs failure without claiming process ownership", async () => {
    const f = fixture({ unreadable: "EIO" });
    await expect(readLinuxManagedBrowserIdentity(f.input, f.reader)).rejects.toThrow(
      "fixture read failed",
    );
  });
});
