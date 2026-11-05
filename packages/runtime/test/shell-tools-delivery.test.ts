import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { managedCodemodeClientEnvironment } from "../src/sandbox/codemode-client";
import {
  buildManagedShellToolsBundle,
  installManagedShellTools,
  loadManagedShellTools,
  MANAGED_SHELL_TOOLS_DIRECTORY,
  managedShellToolsPathEnvironment,
  resetManagedShellToolsForTest,
  type ManagedShellTools,
} from "../src/sandbox/shell-tools";
import { managedShellToolsBackend, runManagedShellToolsHook } from "../src/index";

// A private host directory stands in for the box. The box's PATH is a copy of
// the host's executables without rg and jq, so each test decides which the
// "image" has.
const root = mkdtempSync(resolve(tmpdir(), "opengeni-shell-tools-"));
const imageBin = join(root, "image-bin");
const systemTools = join(root, "system-tools");
let counter = 0;

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeAll(async () => {
  await mkdir(imageBin, { recursive: true });
  for (const directory of ["/usr/local/bin", "/usr/bin", "/bin"]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (name === "rg" || name === "jq" || existsSync(join(imageBin, name))) continue;
      await symlink(join(directory, name), join(imageBin, name));
    }
  }
  await mkdir(systemTools, { recursive: true });
  for (const name of ["rg", "jq"]) {
    await writeFile(join(systemTools, name), `#!/bin/sh\necho system-${name}\n`);
    await chmod(join(systemTools, name), 0o755);
  }
});

const bundle = buildManagedShellToolsBundle({
  rg: new TextEncoder().encode("#!/bin/sh\necho 'ripgrep 15.2.0 (bundled)'\n"),
  jq: new TextEncoder().encode("#!/bin/sh\necho jq-1.8.2-bundled\n"),
  notices: new TextEncoder().encode("notices\n"),
});
// Both architectures carry the same portable scripts, so any host runs them.
const tools: ManagedShellTools = { x86_64: bundle, aarch64: bundle };

function box() {
  return join(root, `box-${++counter}`, ".opengeni/shell-tools/rg-15.2.0-jq-1.8.2");
}

async function shell(cmd: string, path: string) {
  const child = Bun.spawn(["/bin/sh", "-c", cmd], {
    env: { PATH: path, TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function runner(path: string, commands: string[] = []) {
  return async (cmd: string) => {
    commands.push(cmd);
    const result = await shell(cmd, path);
    return { exitCode: result.exitCode, output: result.stdout + result.stderr };
  };
}

function editorSession(staged: string[] = [], deleted: string[] = [], corrupt = false) {
  return {
    createEditor: () => ({
      createFile: async ({ path, diff }: { path: string; diff: string }) => {
        staged.push(path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, (corrupt ? "AAAA" : "") + diff.slice(1) + "\n");
      },
      deleteFile: async ({ path }: { path: string }) => {
        deleted.push(path);
        await rm(path, { force: true });
      },
    }),
  } as never;
}

describe("managed shell tools PATH", () => {
  test("is appended once, after everything the box already has", async () => {
    const directory = box();
    const line = managedShellToolsPathEnvironment(directory);
    const result = await shell(`${line}\n${line}\nprintf '%s' "$PATH"`, `/usr/bin:${imageBin}`);
    expect(result.stdout).toBe(`/usr/bin:${imageBin}:${directory}`);
  });

  test("a system rg and jq win over the bundled ones", async () => {
    const directory = box();
    await installManagedShellTools(editorSession(), tools, runner(imageBin), undefined, undefined, directory);
    const line = managedShellToolsPathEnvironment(directory);
    const bundled = await shell(`${line}\nrg --version; jq --version`, imageBin);
    expect(bundled.stdout).toBe("ripgrep 15.2.0 (bundled)\njq-1.8.2-bundled\n");
    const system = await shell(`${line}\nrg --version; jq --version`, `${systemTools}:${imageBin}`);
    expect(system.stdout).toBe("system-rg\nsystem-jq\n");
  });

  test("a missing directory changes nothing else", async () => {
    const line = managedShellToolsPathEnvironment(join(root, "never-installed"));
    const result = await shell(`${line}\ncommand -v rg || echo no-rg; echo ok`, imageBin);
    expect(result.stdout).toBe("no-rg\nok\n");
  });

  test("rides with the managed Codemode client environment, after ogtool", () => {
    const lines = managedCodemodeClientEnvironment("/workspace/.opengeni/codemode-clients/x");
    const ogtool = lines.findIndex((line) => line.includes("export PATH='/workspace/.opengeni/codemode-clients/x'"));
    const shellTools = lines.findIndex((line) => line.includes(MANAGED_SHELL_TOOLS_DIRECTORY));
    expect(ogtool).toBeGreaterThanOrEqual(0);
    expect(shellTools).toBeGreaterThan(ogtool);
    // A Connected Machine behind the routing proxy uses its agent's own tools.
    expect(lines.indexOf("else")).toBeGreaterThan(shellTools);
  });
});

describe("managed shell tools delivery", () => {
  test("downloads once, then finds the installed tools", async () => {
    const directory = box();
    const server = Bun.serve({ port: 0, fetch: () => new Response(bundle.bytes) });
    try {
      const url = `http://127.0.0.1:${server.port}/bundle`;
      const download = { x86_64: url, aarch64: url };
      const staged: string[] = [];
      const first = await installManagedShellTools(
        editorSession(staged), tools, runner(imageBin), undefined, download, directory,
      );
      if (!existsSync(join(imageBin, "curl")) && !existsSync(join(imageBin, "wget"))) {
        expect(first).toBe("installed"); // staged instead
        return;
      }
      expect(first).toBe("installed");
      expect(staged).toEqual([]);
      expect((await readFile(join(directory, ".complete"), "utf8")).trim()).toBe(bundle.sha256);
      expect(await readFile(join(directory, "THIRD-PARTY-NOTICES.txt"), "utf8")).toBe("notices\n");
      const commands: string[] = [];
      expect(
        await installManagedShellTools(
          editorSession(), tools, runner(imageBin, commands), undefined, download, directory,
        ),
      ).toBe("present");
      expect(commands).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("stages through the file API when the box cannot fetch (offline)", async () => {
    const directory = box();
    const staged: string[] = [];
    const deleted: string[] = [];
    const result = await installManagedShellTools(
      editorSession(staged, deleted), tools, runner(imageBin), undefined, undefined, directory,
    );
    expect(result).toBe("installed");
    expect(staged).toHaveLength(1);
    expect(deleted).toEqual(staged);
    expect(existsSync(staged[0]!)).toBe(false);
    expect((await shell(`${join(directory, "rg")} --version`, imageBin)).stdout).toContain("bundled");
  });

  test("a box whose image has rg and jq receives nothing", async () => {
    const directory = box();
    const staged: string[] = [];
    const result = await installManagedShellTools(
      editorSession(staged), tools, runner(`${systemTools}:${imageBin}`), undefined, undefined, directory,
    );
    expect(result).toBe("system");
    expect(staged).toEqual([]);
    expect(existsSync(directory)).toBe(false);
  });

  test("an architecture without a pinned build is left alone", async () => {
    const fake = join(root, "riscv-bin");
    await mkdir(fake, { recursive: true });
    await writeFile(join(fake, "uname"), "#!/bin/sh\necho riscv64\n");
    await chmod(join(fake, "uname"), 0o755);
    const directory = box();
    expect(
      await installManagedShellTools(
        editorSession(), tools, runner(`${fake}:${imageBin}`), undefined, undefined, directory,
      ),
    ).toBe("unsupported");
    expect(existsSync(directory)).toBe(false);
  });

  test("corrupted bytes install nothing and claim nothing", async () => {
    const directory = box();
    const result = await installManagedShellTools(
      editorSession([], [], true), tools, runner(imageBin), undefined, undefined, directory,
    );
    expect(result).toBe("failed");
    expect(existsSync(join(directory, ".complete"))).toBe(false);
    expect(existsSync(join(directory, "rg"))).toBe(false);
  });

  test("a provider without file ingress reports a failed delivery", async () => {
    const result = await installManagedShellTools(
      {} as never, tools, runner(imageBin), undefined, undefined, box(),
    );
    expect(result).toBe("failed");
  });
});

describe("managed shell tools setup hook", () => {
  test("runs only for backends whose boxes the worker sets up itself", () => {
    for (const backend of ["docker", "modal", "daytona", "e2b", "runloop", "blaxel", "cloudflare", "vercel", "opensandbox"] as const) {
      expect(managedShellToolsBackend(backend)).toBe(true);
    }
    // The machine agent carries its own rg and jq on these.
    for (const backend of ["compute", "selfhosted", "local", "none", undefined] as const) {
      expect(managedShellToolsBackend(backend)).toBe(false);
    }
  });

  test("a release without bundles does nothing", async () => {
    const previous = process.env.OPENGENI_SHELL_TOOLS_DIR;
    delete process.env.OPENGENI_SHELL_TOOLS_DIR;
    resetManagedShellToolsForTest();
    try {
      expect(await loadManagedShellTools()).toBeNull();
      const commands: string[] = [];
      await runManagedShellToolsHook({ exec: async () => commands.push("exec") } as never, {
        environment: {},
      });
      expect(commands).toEqual([]);
    } finally {
      if (previous !== undefined) process.env.OPENGENI_SHELL_TOOLS_DIR = previous;
      resetManagedShellToolsForTest();
    }
  });

  test("never fails setup when the bundles cannot be loaded", async () => {
    const previous = process.env.OPENGENI_SHELL_TOOLS_DIR;
    process.env.OPENGENI_SHELL_TOOLS_DIR = join(root, "no-such-fetch-output");
    resetManagedShellToolsForTest();
    try {
      await expect(
        runManagedShellToolsHook({} as never, { environment: {} }),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OPENGENI_SHELL_TOOLS_DIR;
      else process.env.OPENGENI_SHELL_TOOLS_DIR = previous;
      resetManagedShellToolsForTest();
    }
  });
});
