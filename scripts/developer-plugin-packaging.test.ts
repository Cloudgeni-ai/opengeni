import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClientSkill, renderPluginSetupSkillFile } from "./sync-client-skill";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = join(root, "plugins/opengeni");
const names = ["build-with-opengeni", "offload-to-opengeni", "opengeni-setup"];
function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}
function contained(path: string): string {
  const target = realpathSync(path);
  const fromRoot = relative(realpathSync(pluginRoot), target);
  expect(fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)).toBe(false);
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
  return target;
}
function files(directory: string): Map<string, string> {
  const result = new Map<string, string>();
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      expect(entry.isSymbolicLink()).toBe(false);
      if (entry.isDirectory()) visit(child);
      else result.set(relative(directory, child), readFileSync(child, "utf8"));
    }
  }
  visit(directory);
  return result;
}
function noTransport(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect([
      "mcpServers",
      "mcp_servers",
      "apps",
      "hooks",
      "commands",
      "agents",
      "rules",
      "lspServers",
    ]).not.toContain(key);
    noTransport(child);
  }
}

describe("shared skills-only OpenGeni package", () => {
  test("one identity uses default contained skills and compatible manifests", () => {
    const claude = json("plugins/opengeni/.claude-plugin/plugin.json");
    const portable = json("plugins/opengeni/plugin.json");
    for (const manifest of [claude, portable]) {
      expect(manifest.name).toBe("opengeni");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest).not.toHaveProperty("skills");
      noTransport(manifest);
    }
    for (const field of [
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
    ])
      expect(portable[field]).toEqual(claude[field]);
    expect(portable.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    const schema = json("scripts/fixtures/agent-plugin-1.0.0.schema.json");
    expect(schema.$id).toBe(portable.$schema);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["$schema", "name"]);
    for (const key of Object.keys(portable)) expect(Object.keys(schema.properties)).toContain(key);
    expect(portable.extensions["com.openai"].onboardingSkill).toBe(
      "./skills/opengeni-setup/SKILL.md",
    );
    expect(contained(join(pluginRoot, portable.extensions["com.openai"].onboardingSkill))).toBe(
      realpathSync(join(pluginRoot, "skills/opengeni-setup/SKILL.md")),
    );
  });

  test("plugin metadata is shared and needs no install-time settings", () => {
    const manifest = json("plugins/opengeni/.claude-plugin/plugin.json");
    expect(manifest.displayName).toBe("OpenGeni");
    expect(manifest.author).toEqual({
      name: "OpenGeni",
      url: "https://opengeni.ai",
    });
    expect(manifest.homepage).toBe("https://docs.opengeni.ai/guides/coding-agents");
    // The skills read OPENGENI_* from the project's env; no plugin settings are required.
    expect(manifest.userConfig).toBeUndefined();
  });

  test("all catalogs use the same identity and nested repository-relative source", () => {
    for (const directory of [".agents/plugins", ".claude-plugin", ".cursor-plugin"]) {
      const catalog = json(`${directory}/marketplace.json`);
      expect(catalog.name).toBe("opengeni");
      expect(catalog.plugins).toHaveLength(1);
      const entry = catalog.plugins[0];
      expect(entry.name).toBe("opengeni");
      const source = directory === ".agents/plugins" ? entry.source.path : entry.source;
      expect(source).toBe("./plugins/opengeni");
      expect(source.split("/")).not.toContain("..");
      expect(resolve(root, source)).toBe(pluginRoot);
      expect(resolve(root, directory, source)).not.toBe(pluginRoot);
      expect(entry).not.toHaveProperty("skills");
      noTransport(catalog);
    }
  });

  test("only three immediate skill folders are public and every local entrypoint link stays inside the package", () => {
    expect(readdirSync(join(pluginRoot, "skills")).sort()).toEqual([...names].sort());
    for (const name of names) {
      const path = join(pluginRoot, "skills", name, "SKILL.md");
      contained(path);
      const text = readFileSync(path, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      expect(frontmatter).not.toBeNull();
      const metadata = Bun.YAML.parse(frontmatter![1]!) as Record<string, string>;
      expect(metadata.name).toBe(name);
      expect(metadata.description.trim().length).toBeGreaterThan(0);
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(?:https?:|#)/.test(match[1]!)) continue;
        contained(resolve(dirname(path), match[1]!.split("#")[0]!));
      }
    }
    expect(existsSync(join(pluginRoot, "skills/opengeni-client"))).toBe(false);
    expect(
      existsSync(join(pluginRoot, "skills/build-with-opengeni/opengeni-client/SKILL.md")),
    ).toBe(true);
  });

  test("canonical client/setup mirrors have complete deterministic parity without weakening setup semantics", async () => {
    await checkClientSkill();
    const client = files(join(root, ".agents/skills/opengeni-client"));
    expect(files(join(pluginRoot, "skills/build-with-opengeni/opengeni-client"))).toEqual(client);
    expect(
      files(join(root, "packages/runtime/src/bundled_default_skills/opengeni-client")),
    ).toEqual(client);
    const setup = files(join(root, ".agents/skills/opengeni-setup"));
    const packaged = files(join(pluginRoot, "skills/opengeni-setup"));
    expect([...packaged.keys()].sort()).toEqual([...setup.keys()].sort());
    for (const [path, text] of setup) {
      expect(packaged.get(path)).toBe(renderPluginSetupSkillFile(path, text));
      expect(
        packaged.get(path)!.replaceAll("build-with-opengeni/opengeni-client", "opengeni-client"),
      ).toBe(text);
    }
    const handoff = join(pluginRoot, "skills/opengeni-setup/references/setup-api.md");
    contained(resolve(dirname(handoff), "../../build-with-opengeni/opengeni-client/SKILL.md"));
  });

  test.each([
    ".agents/skills/opengeni-client/SKILL.md",
    "packages/runtime/src/bundled_default_skills/opengeni-client/SKILL.md",
    "docs-site/reference/opengeni-client-skill.mdx",
    "plugins/opengeni/skills/build-with-opengeni/opengeni-client/SKILL.md",
  ])("client setup handoff stays portable in %s", (path) => {
    const text = readFileSync(join(root, path), "utf8");
    const handoffs = [...text.matchAll(/\[OpenGeni developer setup\]\(([^)\s]+)\)/g)];
    expect(handoffs).toHaveLength(1);
    expect(new URL(handoffs[0]![1]!).href).toBe("https://docs.opengeni.ai/guides/developer-plugin");
  });

  test("the package contains no transport, executable components, symlinks or competing root plugins", () => {
    for (const path of [
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
      "plugin.json",
    ])
      expect(existsSync(join(root, path))).toBe(false);
    for (const path of [
      ".mcp.json",
      "mcp.json",
      ".app.json",
      ".lsp.json",
      "hooks",
      "commands",
      "agents",
      "rules",
      "settings.json",
      ".codex-plugin",
      ".cursor-plugin",
    ])
      expect(existsSync(join(pluginRoot, path))).toBe(false);
    for (const path of files(pluginRoot).keys())
      expect(path).not.toMatch(/(?:^|[\\/])(?:\.mcp\.json|mcp\.json|hooks\.json)$/);
  });

  test("docs describe the current selector, three skills, optional transport and native verification", () => {
    const guide = readFileSync(join(root, "docs/developer-plugin.md"), "utf8");
    for (const token of [
      "opengeni@opengeni",
      "./plugins/opengeni",
      "build-with-opengeni",
      "offload-to-opengeni",
      "opengeni-setup",
      "October 1, 2026",
      "required",
      "skills-only",
      "check-developer-plugin-hosts.ts",
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    ])
      expect(guide).toContain(token);
    expect(guide).not.toContain("opengeni-developer@");
    const page = readFileSync(join(root, "docs-site/guides/developer-plugin.mdx"), "utf8");
    expect(page).toContain("opengeni@opengeni");
    expect(page).toContain("has not been published");
    expect(
      json("docs-site/docs.json").navigation.groups.flatMap(
        (group: { pages: string[] }) => group.pages,
      ),
    ).toContain("guides/developer-plugin");
  });
});
