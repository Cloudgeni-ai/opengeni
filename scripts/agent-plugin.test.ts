import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FIRST_PARTY_MCP_TOOL_NAMES } from "../packages/contracts/src/index";
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
});
