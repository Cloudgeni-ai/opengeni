import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const expectedSkills = ["build-with-opengeni", "offload-to-opengeni", "opengeni-setup"].sort();
const scratch = await mkdtemp(join(tmpdir(), "opengeni-plugin-hosts-"));
const claudeConfig = join(scratch, "claude");
const codexConfig = join(scratch, "codex");
const bun = process.execPath;
const claude = [bun, "x", "--package", "@anthropic-ai/claude-code@2.1.286", "claude"];
const codex = [bun, "x", "--package", "@openai/codex@0.159.3", "codex"];
await mkdir(claudeConfig, { mode: 0o700 });
await mkdir(codexConfig, { mode: 0o700 });

async function command(argv: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn(argv, {
    cwd: scratch,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(status, 0, `${argv.slice(-4).join(" ")} failed: ${stdout}\n${stderr}`);
  return stdout;
}

async function readCodexPlugin(marketplacePath: string, config: string) {
  const server = Bun.spawn([...codex, "app-server", "--stdio"], {
    cwd: scratch,
    env: { ...process.env, CODEX_HOME: config },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let nextId = 0;
  const decoder = new TextDecoder();
  const stderr = new Response(server.stderr).text();
  const reader = (async () => {
    let buffer = "";
    for await (const chunk of server.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const result = JSON.parse(line);
        const pending = waiting.get(result.id);
        if (!pending) continue;
        waiting.delete(result.id);
        if (result.error) pending.reject(new Error(JSON.stringify(result.error)));
        else pending.resolve(result.result);
      }
    }
  })();
  function request(method: string, params: unknown) {
    const id = ++nextId;
    return new Promise<any>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, 30_000);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveResult(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      server.stdin.flush();
    });
  }
  try {
    await request("initialize", {
      clientInfo: { name: "opengeni-packaging-check", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
    );
    server.stdin.flush();
    return (
      await request("plugin/read", {
        marketplacePath: join(marketplacePath, ".agents/plugins/marketplace.json"),
        pluginName: "opengeni",
      })
    ).plugin;
  } finally {
    server.kill();
    await Promise.all([server.exited, reader, stderr]);
  }
}

const claudeEnv = { CLAUDE_CONFIG_DIR: claudeConfig, DISABLE_AUTOUPDATER: "1" };
const validation = await command([...claude, "plugin", "validate", root, "--strict"], claudeEnv);
await command([...claude, "plugin", "marketplace", "add", root], claudeEnv);
const installed = await command(
  [...claude, "plugin", "install", "opengeni@opengeni", "--scope", "user"],
  claudeEnv,
);
const details = await command([...claude, "plugin", "details", "opengeni@opengeni"], claudeEnv);
assert.match(details, /Skills \(3\)\s+build-with-opengeni, offload-to-opengeni, opengeni-setup/);
for (const component of ["Agents", "Hooks", "MCP servers", "LSP servers"])
  assert.match(details, new RegExp(`${component} \\(0\\)`));
const configuration = JSON.parse(
  await command([...claude, "plugin", "configure", "opengeni@opengeni", "--json"], claudeEnv),
);
assert.deepEqual(configuration.configured, []);
assert.deepEqual(configuration.unconfigured.sort(), ["base_url", "workspace_id"]);
assert.equal(configuration.schema.base_url.required, true);
assert.equal(configuration.schema.workspace_id.required, true);
assert.equal(configuration.inputs.base_url, "");
assert.equal(configuration.inputs.workspace_id, "");

const codexEnv = { CODEX_HOME: codexConfig };
const marketplace = JSON.parse(
  await command([...codex, "plugin", "marketplace", "add", root, "--json"], codexEnv),
);
assert.equal(marketplace.marketplaceName, "opengeni");
const codexInstall = JSON.parse(
  await command([...codex, "plugin", "add", "opengeni@opengeni", "--json"], codexEnv),
);
assert.equal(codexInstall.pluginId, "opengeni@opengeni");
const nativePlugin = await readCodexPlugin(root, codexConfig);
assert.deepEqual(
  nativePlugin.skills.map((skill: { name: string }) => skill.name).sort(),
  expectedSkills.map((name) => `opengeni:${name}`),
);
assert.deepEqual(nativePlugin.mcpServers, []);
assert.deepEqual(nativePlugin.hooks, []);

// Empirical counterexample: the same package under the legacy manifest recursively registers the guide.
const legacyRoot = join(scratch, "legacy-marketplace");
await cp(join(root, ".agents/plugins"), join(legacyRoot, ".agents/plugins"), { recursive: true });
await cp(join(root, "plugins/opengeni"), join(legacyRoot, "plugins/opengeni"), { recursive: true });
await rm(join(legacyRoot, "plugins/opengeni/plugin.json"));
const legacyConfig = join(scratch, "codex-legacy");
await mkdir(legacyConfig, { mode: 0o700 });
await command([...codex, "plugin", "marketplace", "add", legacyRoot, "--json"], {
  CODEX_HOME: legacyConfig,
});
await command([...codex, "plugin", "add", "opengeni@opengeni", "--json"], {
  CODEX_HOME: legacyConfig,
});
const legacy = await readCodexPlugin(legacyRoot, legacyConfig);
assert.deepEqual(
  legacy.skills.map((skill: { name: string }) => skill.name).sort(),
  [...expectedSkills, "opengeni-client"].sort().map((name) => `opengeni:${name}`),
);

const schemaPath = join(root, "scripts/fixtures/agent-plugin-1.0.0.schema.json");
await command(
  [
    bun,
    "x",
    "--package",
    "ajv-cli@5.0.0",
    "ajv",
    "validate",
    "--spec=draft2020",
    "-s",
    schemaPath,
    "-d",
    join(root, "plugins/opengeni/plugin.json"),
  ],
  {},
);

const receipt = {
  checkedAt: new Date().toISOString(),
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirtyFiles: execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  versions: { claude: "2.1.286", codex: "0.159.3" },
  packageRoot: resolve(root, "plugins/opengeni"),
  claude: { validation, installed, details, configuration },
  codex: {
    install: codexInstall,
    skills: nativePlugin.skills,
    mcpServers: nativePlugin.mcpServers,
    hooks: nativePlugin.hooks,
  },
  legacyComparison: { skills: legacy.skills.map((skill: { name: string }) => skill.name).sort() },
  schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  isolatedConfiguration: scratch,
};
await mkdir(join(root, ".opengeni"), { recursive: true, mode: 0o700 });
const receiptPath = join(root, ".opengeni/native-loader-evidence.json");
await Bun.write(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      receiptPath,
      claudeSkills: expectedSkills,
      codexSkills: expectedSkills,
      legacySkills: receipt.legacyComparison.skills,
      mcpServers: 0,
      requiredUserConfigUnset: configuration.unconfigured,
    },
    null,
    2,
  ),
);
