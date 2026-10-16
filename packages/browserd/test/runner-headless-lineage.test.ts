import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentBrowserJsonRunner,
  inspectOwnedManagedBrowserProcess,
  type AgentBrowserRunnerOptions,
  type OwnedManagedBrowserProcess,
} from "../src/runner";

const native = process.platform === "linux" || process.platform === "darwin";

async function fixture() {
  const directory = await mkdtemp("/tmp/og-headless-lineage-");
  const profileDirectory = join(directory, "profile");
  const socketDirectory = join(directory, "socket");
  const runDirectory = join(socketDirectory, "namespaces", "og", "run");
  await mkdir(profileDirectory, { mode: 0o700 });
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const pidFile = join(runDirectory, "initial.pid");
  const script = join(directory, "daemon.ts");
  const endpoint = `ws://127.0.0.1:12345/devtools/browser/${randomUUID()}`;
  const endpointUrl = new URL(endpoint);
  await writeFile(
    join(profileDirectory, "DevToolsActivePort"),
    `12345\n${endpointUrl.pathname}\n`,
    { mode: 0o600 },
  );
  const childScript = `import {readFile,writeFile} from "node:fs/promises";
    process.on("SIGTERM",async()=>{
      try { const fault=JSON.parse(await readFile(${JSON.stringify(join(directory, "corrupt-on-stop.json"))},"utf8"));
        await writeFile(${JSON.stringify(pidFile)},String(fault.pid)+"\\n"); } catch {}
      process.exit(0);
    }); setInterval(()=>{},60000);`;
  const daemonScript = `import {writeFile,symlink} from "node:fs/promises";
    const browser=Bun.spawn([process.execPath,"--no-env-file","-e",${JSON.stringify(childScript)},${JSON.stringify(`--user-data-dir=${profileDirectory}`)}],{stdout:"ignore",stderr:"ignore"});
    browser.exited.then(exitCode=>console.log(JSON.stringify({exitedBrowserPid:browser.pid,exitCode})));
    await writeFile(${JSON.stringify(pidFile)},String(process.pid)+"\\n",{mode:0o600});
    await symlink("synthetic-host-"+browser.pid,${JSON.stringify(join(profileDirectory, "SingletonLock"))});
    console.log(JSON.stringify({browserPid:browser.pid}));setInterval(()=>{},60000);`;
  await writeFile(script, daemonScript, { mode: 0o600 });
  // The synthetic launcher stands in for agent-browser's native daemon, whose
  // browser outlives it. `bun test --no-orphans` (CI) exports this flag to nested
  // Bun processes, which would take the synthetic browser down with its launcher.
  const { BUN_FEATURE_FLAG_NO_ORPHANS: _noOrphans, ...daemonEnv } = process.env;
  const daemon = Bun.spawn([process.execPath, "--no-env-file", script], {
    env: daemonEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = daemon.stdout.getReader();
  let output = "";
  let browserPid = 0;
  const deadline = setTimeout(() => daemon.kill("SIGKILL"), 5_000);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("synthetic daemon exited before its browser receipt");
      output += new TextDecoder().decode(chunk.value);
      if (output.includes("\n")) {
        browserPid = (JSON.parse(output.slice(0, output.indexOf("\n"))) as { browserPid: number })
          .browserPid;
        break;
      }
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  const options = {
    namespace: "og",
    sessionName: "initial",
    socketDirectory,
    profileDirectory,
    downloadDirectory: join(directory, "downloads"),
    screenshotDirectory: join(directory, "screenshots"),
    headed: false,
    browserExecutablePath: process.execPath,
    binary: {
      path: process.execPath,
      name: "agent-browser-darwin-arm64" as const,
      version: "0.33.2" as const,
      sha256: "synthetic",
    },
  };
  const runner = await AgentBrowserJsonRunner.create(options);
  const extras: ReturnType<typeof Bun.spawn>[] = [];
  return {
    directory,
    profileDirectory,
    runDirectory,
    pidFile,
    browserPid,
    daemon,
    endpoint,
    options,
    runner,
    async attest() {
      return await runner.ownedProcessIdentity(endpoint, browserPid);
    },
    async reattach(receipt: OwnedManagedBrowserProcess) {
      return await AgentBrowserJsonRunner.create({
        ...options,
        sessionName: "replacement",
        recoverOwnedProcess: receipt,
      });
    },
    async browserExited() {
      // The runner proves exit, including a Linux zombie; only this synthetic
      // parent can acknowledge reaping before the stricter PID-absence check.
      const exitReader = daemon.stdout.getReader();
      let exitOutput = "";
      try {
        for (;;) {
          const chunk = await exitReader.read();
          if (chunk.done) throw new Error("synthetic daemon exited before reaping its browser");
          exitOutput += new TextDecoder().decode(chunk.value);
          if (exitOutput.includes("\n")) {
            return JSON.parse(exitOutput.slice(0, exitOutput.indexOf("\n"))) as {
              exitedBrowserPid: number;
              exitCode: number;
            };
          }
        }
      } finally {
        exitReader.releaseLock();
      }
    },
    otherProcess() {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "-e", "setInterval(()=>{},60000)"],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      extras.push(child);
      return child;
    },
    async close() {
      try {
        process.kill(browserPid, "SIGKILL");
      } catch {}
      if (daemon.exitCode === null) daemon.kill("SIGKILL");
      await daemon.exited;
      for (const child of extras) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.skipIf(!native)(
  "headless PID/CDP/parent proof needs no browser PID sidecar and retires both original processes",
  async () => {
    const f = await fixture();
    try {
      const receipt = await f.attest();
      expect(receipt?.pid).toBe(f.browserPid);
      expect(await inspectOwnedManagedBrowserProcess(receipt!)).toBe("live");
      if (process.platform === "darwin") {
        const defaultOptions: AgentBrowserRunnerOptions = { ...f.options };
        delete defaultOptions.browserExecutablePath;
        const defaultExecutable = await AgentBrowserJsonRunner.create(defaultOptions);
        expect(
          (await defaultExecutable.ownedProcessIdentity(f.endpoint, f.browserPid))?.executablePath,
        ).toBe(receipt!.executablePath);
      }
      await expect(readFile(join(f.directory, "browser.pid"))).rejects.toThrow();
      const replacement = await f.reattach(receipt!);
      expect(await replacement.daemonPid()).toBe(f.daemon.pid);
      expect(await replacement.run<{ cdpUrl: string }>(["get", "cdp-url"])).toEqual({
        cdpUrl: f.endpoint,
      });
      await expect(replacement.run(["open", "https://example.test/"])).rejects.toThrow(
        "only its CDP transport",
      );
      await replacement.terminate();
      await f.daemon.exited;
      expect(() => process.kill(f.browserPid, 0)).toThrow();
      expect(() => process.kill(f.daemon.pid, 0)).toThrow();
      await expect(readFile(f.pidFile)).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
  15_000,
);

test.skipIf(!native)(
  "headless attestation rejects CDP, executable, profile lock and missing parent witness",
  async () => {
    const f = await fixture();
    try {
      await expect(f.runner.ownedProcessIdentity(f.endpoint, f.daemon.pid)).rejects.toThrow();
      const wrongExecutable = await AgentBrowserJsonRunner.create({
        ...f.options,
        browserExecutablePath: "/bin/sh",
      });
      if (process.platform === "linux") {
        // Discovery returns no candidate when the actual executable mismatches.
        expect(await wrongExecutable.ownedProcessIdentity(f.endpoint, f.browserPid)).toBeNull();
      }
      // A recorded PID exercises explicit identity rejection, not discovery's
      // no-match result. Retire this witness before the sidecar-free checks.
      const browserPidFile = join(f.directory, "browser.pid");
      await writeFile(browserPidFile, String(f.browserPid), { mode: 0o600 });
      try {
        await expect(
          wrongExecutable.ownedProcessIdentity(f.endpoint, f.browserPid),
        ).rejects.toThrow("executable");
      } finally {
        await rm(browserPidFile);
      }
      const lock = join(f.profileDirectory, "SingletonLock");
      await rm(lock);
      await symlink(`synthetic-host-${f.daemon.pid}`, lock);
      await expect(f.attest()).rejects.toThrow();
      await rm(lock);
      await symlink(`synthetic-host-${f.browserPid}`, lock);
      await rm(f.pidFile);
      await expect(f.attest()).rejects.toThrow();
      expect(() => process.kill(f.browserPid, 0)).not.toThrow();
      expect(() => process.kill(f.daemon.pid, 0)).not.toThrow();
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!native)(
  "reattachment refuses duplicate, foreign and symlinked daemon records without process input",
  async () => {
    const f = await fixture();
    try {
      const receipt = (await f.attest())!;
      await expect(
        f.reattach({ ...receipt, birth: "synthetic-reused-browser-pid" }),
      ).rejects.toThrow("birth");
      const extraFile = join(f.runDirectory, "other.pid");
      await writeFile(extraFile, String(f.daemon.pid), { mode: 0o600 });
      await expect(f.reattach(receipt)).rejects.toThrow("lineage");
      await rm(extraFile);
      const other = f.otherProcess();
      await writeFile(extraFile, String(other.pid), { mode: 0o600 });
      await expect(f.reattach(receipt)).rejects.toThrow("lineage");
      await rm(extraFile);
      const pid = await readFile(f.pidFile);
      await rm(f.pidFile);
      await writeFile(join(f.directory, "pid-copy"), pid, { mode: 0o600 });
      await symlink(join(f.directory, "pid-copy"), f.pidFile);
      await expect(f.reattach(receipt)).rejects.toThrow();
      expect(() => process.kill(f.browserPid, 0)).not.toThrow();
      expect(() => process.kill(f.daemon.pid, 0)).not.toThrow();
      expect(() => process.kill(other.pid, 0)).not.toThrow();
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!native)(
  "a headed browser from an earlier controller release is adopted with its exact launcher",
  async () => {
    const f = await fixture();
    try {
      const receipt = (await f.attest())!;
      const otherRelease = await AgentBrowserJsonRunner.create({
        ...f.options,
        sessionName: "replacement",
        headed: true,
        binary: { ...f.options.binary, path: "/bin/sh", version: "0.33.2" as const },
        recoverOwnedProcess: receipt,
      });
      expect(await otherRelease.daemonPid()).toBe(f.daemon.pid);
      expect(await otherRelease.run<{ cdpUrl: string }>(["get", "cdp-url"])).toEqual({
        cdpUrl: f.endpoint,
      });
      await otherRelease.terminate();
      await f.daemon.exited;
      expect(() => process.kill(f.browserPid, 0)).toThrow();
    } finally {
      await f.close();
    }
  },
  15_000,
);

test.skipIf(!native)(
  "a proven browser whose launcher was killed is adopted and retired on its own",
  async () => {
    const f = await fixture();
    try {
      const receipt = (await f.attest())!;
      // A service stop kills the launcher but not the browser; its pid file stays behind.
      f.daemon.kill("SIGKILL");
      await f.daemon.exited;
      expect(await inspectOwnedManagedBrowserProcess(receipt)).toBe("live");
      const replacement = await f.reattach(receipt);
      expect(await replacement.daemonPid()).toBeNull();
      expect(await replacement.run<{ cdpUrl: string }>(["get", "cdp-url"])).toEqual({
        cdpUrl: f.endpoint,
      });
      const bystander = f.otherProcess();
      await expect(replacement.terminate(bystander.pid)).rejects.toThrow("lineage");
      expect(() => process.kill(f.browserPid, 0)).not.toThrow();
      await replacement.terminate();
      expect(() => process.kill(f.browserPid, 0)).toThrow();
      expect(() => process.kill(bystander.pid, 0)).not.toThrow();
    } finally {
      await f.close();
    }
  },
  15_000,
);

test.skipIf(!native)(
  "a killed launcher's pid reused by an unrelated process refuses adoption",
  async () => {
    const f = await fixture();
    try {
      const receipt = (await f.attest())!;
      f.daemon.kill("SIGKILL");
      await f.daemon.exited;
      const reused = f.otherProcess();
      await writeFile(f.pidFile, String(reused.pid), { mode: 0o600 });
      await expect(f.reattach(receipt)).rejects.toThrow("lineage");
      expect(() => process.kill(f.browserPid, 0)).not.toThrow();
      expect(() => process.kill(reused.pid, 0)).not.toThrow();
    } finally {
      await f.close();
    }
  },
  15_000,
);

for (const holdReaper of [false, true]) {
  test.skipIf(!native || (holdReaper && process.platform !== "linux"))(
    "cleanup birth mismatch preserves both processes; proved browser stop permits exact daemon cleanup retry" +
      (holdReaper ? " with parent reaping held" : ""),
    async () => {
      const f = await fixture();
      try {
        const receipt = (await f.attest())!;
        const replacement = await f.reattach(receipt);
        const other = f.otherProcess();
        const extraFile = join(f.runDirectory, "appeared-after-attachment.pid");
        await writeFile(extraFile, String(other.pid), { mode: 0o600 });
        await expect(replacement.terminate()).rejects.toThrow("lineage");
        expect(() => process.kill(f.browserPid, 0)).not.toThrow();
        expect(() => process.kill(f.daemon.pid, 0)).not.toThrow();
        expect(() => process.kill(other.pid, 0)).not.toThrow();
        await rm(extraFile);
        const daemonIdentity = (replacement as unknown as { predecessorDaemon: { birth: string } })
          .predecessorDaemon;
        const birth = daemonIdentity.birth;
        daemonIdentity.birth = "synthetic-reused-pid-birth";
        await expect(replacement.terminate()).rejects.toThrow("birth");
        expect(() => process.kill(f.browserPid, 0)).not.toThrow();
        expect(() => process.kill(f.daemon.pid, 0)).not.toThrow();
        daemonIdentity.birth = birth;
        // Keep the parent alive but unable to reap, deterministically exercising
        // the exit/reap gap that made the original immediate kill(pid, 0) flaky.
        if (holdReaper) f.daemon.kill("SIGSTOP");
        await writeFile(
          join(f.directory, "corrupt-on-stop.json"),
          JSON.stringify({ pid: other.pid }),
          {
            mode: 0o600,
          },
        );
        await expect(replacement.terminate()).rejects.toThrow("lineage");
        if (holdReaper) {
          const stat = await readFile(`/proc/${f.browserPid}/stat`, "utf8");
          expect(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]).toBe("Z");
          expect(() => process.kill(f.browserPid, 0)).not.toThrow();
          f.daemon.kill("SIGCONT");
        }
        expect(await f.browserExited()).toEqual({ exitedBrowserPid: f.browserPid, exitCode: 0 });
        expect(() => process.kill(f.browserPid, 0)).toThrow();
        expect(() => process.kill(f.daemon.pid, 0)).not.toThrow();
        expect(() => process.kill(other.pid, 0)).not.toThrow();
        await writeFile(f.pidFile, String(f.daemon.pid), { mode: 0o600 });
        await replacement.terminate();
        await f.daemon.exited;
        expect(() => process.kill(f.daemon.pid, 0)).toThrow();
        expect(() => process.kill(other.pid, 0)).not.toThrow();
      } finally {
        if (holdReaper && f.daemon.exitCode === null) f.daemon.kill("SIGCONT");
        await f.close();
      }
    },
    15_000,
  );
}
