import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FIRST_PARTY_MCP_TOOL_NAMES } from "../packages/contracts/src/index";
import { Permission } from "../packages/contracts/src/permissions";
import { parseSkillFrontmatter } from "../packages/contracts/src/skill-metadata";

const root = new URL("..", import.meta.url).pathname;
const pluginRoot = join(root, "plugins/opengeni");
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

const marketplace = readJson(".claude-plugin/marketplace.json") as {
  name: string;
  plugins: Array<{ name: string; source: string }>;
};
const manifest = readJson("plugins/opengeni/.claude-plugin/plugin.json") as {
  name: string;
  version: string;
  userConfig: Record<string, { type: string; required?: boolean; default?: string }>;
};
const mcp = readJson("plugins/opengeni/.mcp.json") as {
  mcpServers: Record<string, { type: string; url: string }>;
};
const skillNames = readdirSync(join(pluginRoot, "skills")).sort();
const skillText = (name: string) =>
  readFileSync(join(pluginRoot, "skills", name, "SKILL.md"), "utf8");

const buildSkillDir = join(pluginRoot, "skills/build-with-opengeni");
const demoRecipe = readFileSync(join(buildSkillDir, "local-demo-app.md"), "utf8");
/** The recipe's files: fenced blocks whose info string names a path, e.g. ```ts server.ts. */
const demoFiles = new Map(
  [...demoRecipe.matchAll(/^```[\w-]+ ([^\s`]+)\n([\s\S]*?)^```$/gmu)].map(
    (match) => [match[1]!, match[2]!] as const,
  ),
);

/** Resolve `@opengeni/<pkg>[/<subpath>]` through the workspace package's exports map. */
function workspaceExport(specifier: string): string {
  const match = /^@opengeni\/([a-z-]+)(\/.+)?$/u.exec(specifier);
  if (!match) throw new Error(`not an @opengeni import: ${specifier}`);
  const packageDir = join(root, "packages", match[1]!);
  const exports = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))
    .exports as Record<string, Record<string, string>>;
  const entry = exports[match[2] ? `.${match[2]}` : "."];
  if (!entry) throw new Error(`${specifier} is not exported`);
  return join(packageDir, entry.default ?? entry.import ?? entry.style!);
}

function substitute(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\$\{user_config\.([a-z_]+)\}/gu, (_, key: string) => {
    if (!(key in values)) throw new Error(`undeclared user_config key ${key}`);
    return values[key]!;
  });
}

describe("coding-agent plugin", () => {
  test("the repository marketplace lists exactly this plugin by its manifest name", () => {
    expect(marketplace.name).toBe("opengeni");
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry!.name).toBe(manifest.name);
    expect(join(root, entry!.source)).toBe(pluginRoot);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  test("the bundled MCP server resolves to the exact workspace MCP resource path", () => {
    const server = mcp.mcpServers.opengeni!;
    expect(server.type).toBe("http");
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const url = new URL(
      substitute(server.url, {
        base_url: manifest.userConfig.base_url!.default!,
        workspace_id: workspaceId,
      }),
    );
    expect(url.origin).toBe("https://app.opengeni.ai");
    // apps/api/src/mcp-oauth.ts WORKSPACE_MCP_PATH: no trailing slash, query, or hash.
    expect(url.pathname).toBe(`/v1/workspaces/${workspaceId}/mcp`);
    expect(url.search + url.hash).toBe("");
    for (const key of ["base_url", "workspace_id"]) {
      expect(manifest.userConfig[key]).toMatchObject({ type: "string", required: true });
    }
  });

  test("every Skill has portable frontmatter and references only declared settings", () => {
    expect(skillNames).toEqual(["build-with-opengeni", "offload-to-opengeni"]);
    for (const name of skillNames) {
      const text = skillText(name);
      const metadata = parseSkillFrontmatter(text);
      expect(metadata.name).toBe(name);
      expect(metadata.description!.length).toBeGreaterThan(0);
      expect(metadata.description!.length).toBeLessThanOrEqual(1024);
      for (const match of text.matchAll(/\$\{user_config\.([a-z_]+)\}/gu)) {
        expect(Object.keys(manifest.userConfig)).toContain(match[1]!);
      }
    }
  });

  test("the offload Skill names only real first-party gateway tools", () => {
    const referenced = new Set(
      [...skillText("offload-to-opengeni").matchAll(/\bopengeni__([a-z_]+)\b/gu)].map(
        (match) => match[1]!,
      ),
    );
    expect(referenced.size).toBeGreaterThan(5);
    const catalog = new Set<string>(FIRST_PARTY_MCP_TOOL_NAMES);
    expect([...referenced].filter((name) => !catalog.has(name))).toEqual([]);
  });

  test("plugin files are real files so installers that skip symlinks copy everything", () => {
    const visit = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? visit(path) : [path];
      });
    const files = visit(pluginRoot);
    expect(files.filter((path) => lstatSync(path).isSymbolicLink())).toEqual([]);
    const build = skillText("build-with-opengeni");
    for (const match of build.matchAll(/\]\((opengeni-client\/[^)#]+)\)/gu)) {
      expect(existsSync(join(pluginRoot, "skills/build-with-opengeni", match[1]!))).toBe(true);
    }
    for (const match of build.matchAll(/`(opengeni-client\/references\/[^`]+\.md)`/gu)) {
      expect(existsSync(join(pluginRoot, "skills/build-with-opengeni", match[1]!))).toBe(true);
    }
  });

  test("the local demo recipe is linked and lists every file it runs", () => {
    expect(skillText("build-with-opengeni")).toContain("](local-demo-app.md)");
    expect([...demoFiles.keys()].sort()).toEqual([
      ".env",
      ".gitignore",
      "index.html",
      "server.ts",
      "src/main.tsx",
      "tsconfig.json",
    ]);
    expect(demoFiles.get("index.html")).toContain('src="/src/main.tsx"');
    expect(demoRecipe).toContain(
      'npm pkg set type=module scripts.dev="tsx --env-file=.env server.ts"',
    );
    expect(demoRecipe).toContain("npm install @opengeni/sdk@latest @opengeni/react@latest");
  });

  test("the local demo recipe imports only real @opengeni exports", async () => {
    const imports = [...demoFiles.entries()]
      .filter(([path]) => /\.tsx?$/u.test(path))
      .flatMap(([, code]) => [
        ...code.matchAll(/^import (?:\{([^}]*)\} from )?"(@opengeni\/[^"]+)";$/gmu),
      ]);
    expect(imports.map((match) => match[2]).sort()).toEqual([
      "@opengeni/react",
      "@opengeni/react/compiled.css",
      "@opengeni/sdk",
      "@opengeni/sdk",
      "@opengeni/sdk/express",
    ]);
    for (const [, names, specifier] of imports) {
      const file = workspaceExport(specifier!);
      expect(existsSync(file)).toBe(true);
      if (!names) continue;
      const module = (await import(file)) as Record<string, unknown>;
      for (const name of names.split(",").map((part) => part.trim())) {
        expect(`${specifier}:${name}:${typeof module[name]}`).toBe(`${specifier}:${name}:function`);
      }
    }
  });

  test("the local demo server reads exactly the documented .env settings and real permissions", () => {
    const server = demoFiles.get("server.ts")!;
    const read = new Set(
      [...server.matchAll(/(?:process\.env\.|required\(")([A-Z_]+)/gu)].map((match) => match[1]!),
    );
    read.delete("PORT");
    const documented = new Set(
      [...demoFiles.get(".env")!.matchAll(/^(?:# )?([A-Z_]+)=/gmu)].map((match) => match[1]!),
    );
    expect([...read].sort()).toEqual([...documented].sort());
    expect([...documented]).toEqual(
      expect.arrayContaining([
        "OPENGENI_API_KEY",
        "OPENGENI_BASE_URL",
        "OPENGENI_ORGANIZATION_ID",
        "OPENGENI_WORKSPACE_ID",
      ]),
    );
    expect(demoFiles.get(".gitignore")!.split("\n")).toContain(".env");
    const permissions = /permissions: \[([^\]]+)\]/u.exec(server)![1]!;
    for (const match of permissions.matchAll(/"([^"]+)"/gu)) {
      expect(Permission.safeParse(match[1]).success).toBe(true);
    }
    expect(server).toContain('sandboxBackend: "none"');
    expect(server).toContain('http.listen(port, "127.0.0.1"');
  });

  test("agent setup snippets parse and point at the real Skill folders", () => {
    const pages = {
      readme: readFileSync(join(pluginRoot, "README.md"), "utf8"),
      docs: readFileSync(join(root, "docs-site/guides/coding-agents.mdx"), "utf8"),
    };
    for (const [page, text] of Object.entries(pages)) {
      const blocks = [...text.matchAll(/^( *)```json\n([\s\S]*?)^\1```$/gmu)];
      expect(`${page}:${blocks.length > 4}`).toBe(`${page}:true`);
      for (const [, , body] of blocks) expect(() => JSON.parse(body!)).not.toThrow();
      const skillPaths = [...text.matchAll(/\.agents\/skills\/([a-z-]+)\/SKILL\.md/gu)];
      expect([...new Set(skillPaths.map((match) => match[1]))].sort()).toEqual(skillNames);
      expect(text).toContain("sparse-checkout set plugins/opengeni/skills");
      for (const client of ["Cursor", "VS Code", "Devin", "Zed", "Gemini CLI", "mcp-remote"]) {
        expect(`${page}:${text.includes(client)}`).toBe(`${page}:true`);
      }
    }
  });
});
