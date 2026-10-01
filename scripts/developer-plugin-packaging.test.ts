import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginName = "opengeni-developer";
const marketplaceName = "opengeni-developer-plugins";
const skillNames = ["opengeni-setup", "opengeni-client"];
const skillPaths = skillNames.map((name) => `./.agents/skills/${name}`);
const manifestDirectories = [".codex-plugin", ".claude-plugin", ".cursor-plugin"];
const identityFields = [
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
];

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function insideRoot(path: string): string {
  expect(path.startsWith("./")).toBe(true);
  expect(isAbsolute(path)).toBe(false);
  expect(path.split("/")).not.toContain("..");
  const target = realpathSync(resolve(root, path));
  const fromRoot = relative(realpathSync(root), target);
  expect(fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)).toBe(false);
  return target;
}

function expectSkillsOnly(value: unknown): void {
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
      "settings",
      "userConfig",
      "variables",
    ]).not.toContain(key);
    expectSkillsOnly(child);
  }
}

describe("skills-only OpenGeni developer plugin", () => {
  test("host manifests share stable identity and select only canonical skills", () => {
    const codex = json(".codex-plugin/plugin.json");
    expect(codex.name).toBe(pluginName);
    expect(codex.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(codex.author.name).toBe("Cloudgeni");
    expect(codex.license).toBe("Apache-2.0");
    expect(codex.repository).toBe("https://github.com/Cloudgeni-ai/opengeni");
    for (const directory of manifestDirectories) {
      const manifest = json(`${directory}/plugin.json`);
      expect(manifest.skills).toEqual(skillPaths);
      for (const field of identityFields) expect(manifest[field]).toEqual(codex[field]);
      expect(Object.keys(manifest).sort()).toEqual(
        [
          ...identityFields,
          ...(directory === ".codex-plugin" ? ["interface", "extensions"] : []),
        ].sort(),
      );
      expectSkillsOnly(manifest);
    }
  });

  test("every declared skill resolves in place with valid frontmatter and references", () => {
    for (const directory of manifestDirectories) {
      const manifest = json(`${directory}/plugin.json`);
      for (const [index, path] of manifest.skills.entries()) {
        const canonical = join(root, ".agents", "skills", skillNames[index]!);
        expect(lstatSync(canonical).isDirectory()).toBe(true);
        expect(lstatSync(canonical).isSymbolicLink()).toBe(false);
        expect(insideRoot(path)).toBe(realpathSync(canonical));
        const entrypoint = join(canonical, "SKILL.md");
        expect(lstatSync(entrypoint).isFile()).toBe(true);
        expect(lstatSync(entrypoint).isSymbolicLink()).toBe(false);
        const text = readFileSync(entrypoint, "utf8");
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        expect(frontmatter).not.toBeNull();
        const metadata = Bun.YAML.parse(frontmatter![1]!) as Record<string, unknown>;
        expect(metadata.name).toBe(skillNames[index]);
        expect(typeof metadata.description).toBe("string");
        expect((metadata.description as string).trim().length).toBeGreaterThan(0);
        for (const match of text.matchAll(/\]\((references\/[^)\s]+\.md)(?:#[^)\s]*)?\)/g)) {
          const reference = join(dirname(entrypoint), match[1]!);
          expect(existsSync(reference)).toBe(true);
          expect(insideRoot(`./${relative(root, reference)}`)).toBe(realpathSync(reference));
        }
      }
    }
  });

  test("Codex presentation and onboarding use the supported compatibility fields", () => {
    const manifest = json(".codex-plugin/plugin.json");
    expect(manifest).not.toHaveProperty("$schema");
    expect(manifest.interface.displayName).toBe("OpenGeni Developer");
    expect(manifest.interface.shortDescription.length).toBeLessThanOrEqual(30);
    expect(manifest.extensions).toEqual({
      "com.openai": { onboardingSkill: `${skillPaths[0]}/SKILL.md` },
    });
    expect(insideRoot(manifest.extensions["com.openai"].onboardingSkill)).toBe(
      realpathSync(join(root, ".agents/skills/opengeni-setup/SKILL.md")),
    );
  });

  test("all marketplaces resolve the plugin from the repo root, not their catalog directory", () => {
    const codex = json(".agents/plugins/marketplace.json");
    expect(codex.interface.displayName).toBe("OpenGeni Developer Plugins");
    for (const directory of [".agents/plugins", ".claude-plugin", ".cursor-plugin"]) {
      const catalog = json(`${directory}/marketplace.json`);
      expect(catalog.name).toBe(marketplaceName);
      expect(catalog.plugins).toHaveLength(1);
      const entry = catalog.plugins[0];
      expect(entry.name).toBe(pluginName);
      const source = directory === ".agents/plugins" ? entry.source.path : entry.source;
      expect(source).toBe("./");
      expect(insideRoot(source)).toBe(realpathSync(root));
      expect(resolve(root, directory, source)).not.toBe(realpathSync(root));
      expectSkillsOnly(catalog);
      if (directory === ".agents/plugins") {
        expect(entry.source).toEqual({ source: "local", path: "./" });
        expect(entry.policy).toEqual({ installation: "AVAILABLE", authentication: "ON_INSTALL" });
        expect(entry.category).toBe("Developer Tools");
      } else {
        expect(catalog.owner).toEqual({ name: "Cloudgeni" });
        expect(entry).not.toHaveProperty("skills");
        expect(entry).not.toHaveProperty("version");
      }
    }
  });

  test("no portable manifest, copied skills, or default executable components are packaged", () => {
    for (const path of [
      "plugin.json",
      "skills",
      ".mcp.json",
      "mcp.json",
      ".app.json",
      ".lsp.json",
      "hooks",
      "commands",
      "agents",
      "rules",
      "settings.json",
      ".codex-plugin/skills",
      ".claude-plugin/skills",
      ".cursor-plugin/skills",
    ]) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });

  test("public install docs are discoverable and cite dated official specifications", () => {
    const navigation = json("docs-site/docs.json");
    expect(
      navigation.navigation.groups.flatMap((group: { pages: string[] }) => group.pages),
    ).toContain("guides/developer-plugin");
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("docs/developer-plugin.md");
    const guide = readFileSync(join(root, "docs/developer-plugin.md"), "utf8");
    for (const token of [
      "October 1, 2026",
      "https://developers.openai.com/plugins/build/plugins",
      "https://developers.openai.com/plugins/deploy/submission",
      "https://code.claude.com/docs/en/plugins/manifest-reference",
      "https://cursor.com/docs/skills",
      "https://cursor.com/docs/reference/plugins",
      "Skills-only plugins are officially supported",
      "does **not** publish",
      "scripts/sync-client-skill.ts",
    ]) {
      expect(guide).toContain(token);
    }
    const page = readFileSync(join(root, "docs-site/guides/developer-plugin.mdx"), "utf8");
    expect(page).toContain("docs/developer-plugin.md");
    expect(page).toContain("has not been published");
  });
});
