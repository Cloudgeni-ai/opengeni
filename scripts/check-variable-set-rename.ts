import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".agent"]);
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".md",
  ".sql",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
]);

type Rule = {
  name: string;
  pattern: RegExp;
  allow: RegExp[];
};

const aliasAllow = [
  /^test\//,
  /^apps\/api\/test\//,
  /^packages\/react\/test\//,
  /^packages\/react\/demo\//,
  /^apps\/api\/src\/routes\/environments\.ts$/,
  /^apps\/api\/src\/mcp\/server\.ts$/,
  /^apps\/web\/src\/lib\/permissions\.ts$/,
  /^packages\/contracts\/src\/index\.ts$/,
  /^packages\/core\/src\/access\/index\.ts$/,
  /^packages\/core\/src\/domain\/environments\.ts$/,
  /^packages\/db\/drizzle\/0004_workspace_environments\.sql$/,
  /^packages\/db\/drizzle\/0046_variable_sets_rename\.sql$/,
  /^packages\/db\/src\/environment-crypto\.ts$/,
  /^packages\/db\/test\/environment-crypto\.test\.ts$/,
  /^packages\/sdk\/src\/client\.ts$/,
  /^packages\/sdk\/src\/types\.ts$/,
  /^packages\/react\/src\/hooks\/use-environments\.ts$/,
  /^packages\/react\/test\/hooks\.test\.tsx$/,
  /^scripts\/check-variable-set-rename\.ts$/,
];

const rules: Rule[] = [
  {
    name: "old DB table/column names",
    pattern: /\b(workspace_environments|workspace_environment_variables|environment_id|sessions_environment_idx|scheduled_tasks_environment_idx)\b/,
    allow: [
      /^packages\/db\/drizzle\/0004_workspace_environments\.sql$/,
      /^packages\/db\/drizzle\/0046_variable_sets_rename\.sql$/,
      /^packages\/db\/drizzle\/0024_codex_subscription_credentials\.sql$/,
      /^packages\/db\/src\/environment-crypto\.ts$/,
      /^packages\/db\/test\/environment-crypto\.test\.ts$/,
      /^test\//,
      /^apps\/api\/test\//,
      /^scripts\/check-variable-set-rename\.ts$/,
    ],
  },
  {
    name: "old permission strings outside aliases",
    pattern: /\benvironments:(use|manage)\b/,
    allow: aliasAllow,
  },
  {
    name: "old MCP tool names outside aliases",
    pattern: /\benvironment_(list|set_variable)\b/,
    allow: [
      /^apps\/api\/src\/mcp\/server\.ts$/,
      /^test\//,
      /^apps\/api\/test\//,
      /^packages\/react\/src\/timeline\/tool-renderers\.tsx$/,
      /^packages\/react\/test\//,
      /^packages\/react\/demo\//,
      /^scripts\/check-variable-set-rename\.ts$/,
    ],
  },
  {
    name: "web user-facing Environment copy",
    pattern: /\bEnvironments?\b/,
    allow: [
      /^apps\/web\/src\/routes\/environments\.tsx$/,
      /^apps\/web\/src\/components\/rail\/workspace-nav\.tsx$/,
      /^scripts\/check-variable-set-rename\.ts$/,
    ],
  },
];

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        await walk(join(dir, entry.name), files);
      }
      continue;
    }
    const path = join(dir, entry.name);
    if (textExtensions.has(path.slice(path.lastIndexOf(".")))) {
      files.push(path);
    }
  }
  return files;
}

const failures: string[] = [];
for (const file of await walk(root)) {
  const rel = relative(root, file);
  const text = await readFile(file, "utf8");
  for (const rule of rules) {
    if (rule.name === "web user-facing Environment copy" && !rel.startsWith("apps/web/src/")) {
      continue;
    }
    if (!rule.pattern.test(text)) {
      continue;
    }
    if (rule.allow.some((allowed) => allowed.test(rel))) {
      continue;
    }
    failures.push(`${rel}: ${rule.name}`);
  }
}

if (failures.length > 0) {
  console.error("Variable Set rename guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Variable Set rename guard passed.");
