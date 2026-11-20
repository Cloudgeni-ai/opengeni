import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type ConnectDeps, OPENGENI_CONNECT_SKILL, runCli } from "../src/index";
import { parseClients, withCodexServer, withJsonServer } from "../src/connect";

function fakeDeps(
  options: {
    files?: Record<string, string>;
    dirs?: string[];
    commands?: Record<string, (args: readonly string[]) => { status: number; output: string }>;
  } = {},
) {
  const home = "/home/user";
  const files = new Map(Object.entries(options.files ?? {}));
  const dirs = new Set(options.dirs ?? []);
  const runs: string[] = [];
  const deps: ConnectDeps = {
    home,
    platform: "linux",
    env: {},
    exists: (path) => dirs.has(path) || files.has(path),
    read: (path) => files.get(path) ?? null,
    write: (path, content) => {
      files.set(path, content);
    },
    run: (command, args) => {
      runs.push([command, ...args].join(" "));
      const handler = options.commands?.[command];
      return handler ? handler(args) : null;
    },
  };
  return { deps, files, runs, home };
}

async function connect(argv: string[], deps: ConnectDeps) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(["connect", ...argv], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {},
    connectDeps: deps,
  });
  return { exitCode, stdout, stderr };
}

const URL = "https://app.opengeni.ai/v1/mcp";

describe("opengeni connect", () => {
  test("configures the installed agents and installs the skill", async () => {
    const home = "/home/user";
    const { deps, files, runs } = fakeDeps({
      dirs: [join(home, ".codex"), join(home, ".cursor"), join(home, ".config", "Code", "User")],
      files: {
        [join(home, ".cursor", "mcp.json")]: '{"mcpServers":{"other":{"url":"x"}}}',
      },
      commands: { codex: () => ({ status: 0, output: "" }) },
    });
    const result = await connect([], deps);
    expect(result.exitCode).toBe(0);
    expect(files.get(join(home, ".codex", "config.toml"))).toBe(
      `[mcp_servers.opengeni]\nurl = "${URL}"\n`,
    );
    expect(runs).toContain("codex mcp login opengeni");
    expect(JSON.parse(files.get(join(home, ".cursor", "mcp.json"))!)).toEqual({
      mcpServers: { other: { url: "x" }, opengeni: { url: URL } },
    });
    expect(JSON.parse(files.get(join(home, ".config", "Code", "User", "mcp.json"))!)).toEqual({
      servers: { opengeni: { type: "http", url: URL } },
    });
    for (const dir of [".agents", ".cursor", ".copilot"]) {
      expect(files.get(join(home, dir, "skills", "opengeni", "SKILL.md"))).toBe(
        OPENGENI_CONNECT_SKILL,
      );
    }
    expect(result.stdout).toContain("Codex: Added the opengeni server. Signed in.");
  });

  test("uses the claude command and is idempotent", async () => {
    let added = false;
    const { deps, runs } = fakeDeps({
      commands: {
        claude: (args) => {
          if (args[1] === "get")
            return added ? { status: 0, output: `opengeni ${URL}` } : { status: 1, output: "" };
          added = true;
          return { status: 0, output: "" };
        },
      },
    });
    expect((await connect(["--client", "claude"], deps)).exitCode).toBe(0);
    expect(runs).toContain(`claude mcp add --transport http --scope user opengeni ${URL}`);
    const again = await connect(["--client=claude-code", "--no-skill"], deps);
    expect(again.stdout).toContain("Already has the opengeni server.");
    expect(runs.filter((run) => run.includes("mcp add"))).toHaveLength(1);
  });

  test("reports when nothing is installed and rejects unknown clients", async () => {
    const { deps } = fakeDeps();
    expect((await connect([], deps)).exitCode).toBe(1);
    const bad = await connect(["--client", "emacs"], deps);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("unknown client emacs");
  });

  test("helpers keep existing configuration", () => {
    expect(parseClients("copilot,all")).toHaveLength(4);
    expect(
      withJsonServer(`{"servers":{"opengeni":{"type":"http","url":"${URL}"}}}`, "servers", {
        type: "http",
        url: URL,
      }).changed,
    ).toBe(false);
    expect(
      withCodexServer(`[mcp_servers.opengeni]\nurl = "https://other/v1/mcp"\n`, URL).conflict,
    ).toBe(true);
    expect(withCodexServer(`model = "x"\n`, URL).content).toBe(
      `model = "x"\n\n[mcp_servers.opengeni]\nurl = "${URL}"\n`,
    );
    expect(() => withJsonServer("[1]", "servers", {})).toThrow();
  });
});
