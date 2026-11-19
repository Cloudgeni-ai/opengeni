import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import {
  canonicalOrgAgentDefinitionJson,
  OrgAgentFile,
  type OrgAgentDefinition,
  orgAgentFileToDefinition,
} from "@opengeni/contracts/organization-agents";
import { parseDocument } from "yaml";

/** One agent file that parsed and validated. */
export type LoadedAgentFile = {
  /** Path shown to the person (relative to the working directory). */
  path: string;
  key: string;
  definition: OrgAgentDefinition;
  /** `sha256:` + hex of the canonical definition; the server computes the same. */
  configHash: string;
  /** Markdown file the instructions were read from, if any. */
  instructionsFile?: string;
};

export type LoadAgentDirectoryResult = {
  agents: LoadedAgentFile[];
  /** Path-qualified problems; deploy nothing while any exist. */
  errors: string[];
  warnings: string[];
};

const AGENT_FILE_EXTENSIONS = new Set([".yaml", ".yml"]);

/** `sha256:` + hex sha256 of {@link canonicalOrgAgentDefinitionJson}. */
export function orgAgentConfigHash(definition: OrgAgentDefinition): string {
  return `sha256:${createHash("sha256").update(canonicalOrgAgentDefinitionJson(definition)).digest("hex")}`;
}

function issuePath(path: readonly PropertyKey[]): string {
  let text = "";
  for (const segment of path) {
    if (typeof segment === "number") text += `[${segment}]`;
    else text += text ? `.${String(segment)}` : String(segment);
  }
  return text;
}

/**
 * `instructions` that name a `.md` file are read from that file next to the
 * YAML file; a missing one is an error. Any other value is the instructions
 * text itself.
 */
function resolveInstructions(
  value: unknown,
  yamlPath: string,
  displayPath: string,
  errors: string[],
): { text: unknown; file?: string } {
  if (typeof value !== "string") return { text: value };
  const candidate = value.trim();
  if (!candidate.toLowerCase().endsWith(".md") || candidate.includes("\n")) return { text: value };
  const filePath = resolve(yamlPath, "..", candidate);
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return { text: readFileSync(filePath, "utf8"), file: filePath };
  }
  errors.push(
    `${displayPath}: instructions: '${candidate}' is not a file next to this agent file.`,
  );
  return { text: value };
}

/** Reads, validates and converts one agent file. */
export function loadAgentFile(
  filePath: string,
  options: { cwd?: string } = {},
): { agent?: LoadedAgentFile; errors: string[]; warnings: string[] } {
  const displayPath = relative(options.cwd ?? process.cwd(), filePath) || filePath;
  const errors: string[] = [];
  const warnings: string[] = [];
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      errors: [`${displayPath}: cannot read the file (${(error as Error).message}).`],
      warnings,
    };
  }
  const document = parseDocument(text, { prettyErrors: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const line = error.linePos?.[0];
      errors.push(
        `${displayPath}${line ? `:${line.line}:${line.col}` : ""}: ${error.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/u, "")}`,
      );
    }
    return { errors, warnings };
  }
  const raw: unknown = document.toJS();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: [`${displayPath}: expected a mapping with at least key and name.`], warnings };
  }
  const record = { ...(raw as Record<string, unknown>) };
  let instructionsFile: string | undefined;
  if ("instructions" in record) {
    const resolved = resolveInstructions(record.instructions, filePath, displayPath, errors);
    record.instructions = resolved.text;
    instructionsFile = resolved.file;
  }
  const parsed = OrgAgentFile.safeParse(record);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issuePath(issue.path);
      errors.push(`${displayPath}: ${at ? `${at}: ` : ""}${issue.message}`);
    }
    return { errors, warnings };
  }
  const expectedKey = basename(filePath, extname(filePath));
  if (parsed.data.key !== expectedKey) {
    errors.push(
      `${displayPath}: key: '${parsed.data.key}' does not match the file name; rename the file to ${parsed.data.key}${extname(filePath)} or set key: ${expectedKey}.`,
    );
    return { errors, warnings };
  }
  let converted: ReturnType<typeof orgAgentFileToDefinition>;
  try {
    converted = orgAgentFileToDefinition(parsed.data);
  } catch (error) {
    const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    if (!issues) throw error;
    for (const issue of issues) {
      const at = issuePath(issue.path[0] === "config" ? issue.path.slice(1) : issue.path);
      errors.push(`${displayPath}: ${at ? `${at}: ` : ""}${issue.message}`);
    }
    return { errors, warnings };
  }
  if (errors.length > 0) return { errors, warnings };
  return {
    agent: {
      path: displayPath,
      key: converted.key,
      definition: converted.definition,
      configHash: orgAgentConfigHash(converted.definition),
      ...(instructionsFile ? { instructionsFile } : {}),
    },
    errors,
    warnings,
  };
}

/**
 * Reads every `*.yaml`/`*.yml` file directly in `directory` (one agent per
 * file). Every file is checked, so all problems are reported at once.
 */
export function loadAgentDirectory(
  directory: string,
  options: { cwd?: string } = {},
): LoadAgentDirectoryResult {
  const cwd = options.cwd ?? process.cwd();
  const absolute = resolve(cwd, directory);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    return { agents: [], errors: [`${directory}: not a directory.`], warnings: [] };
  }
  const files = readdirSync(absolute)
    .filter((name) => AGENT_FILE_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort();
  if (files.length === 0) {
    return {
      agents: [],
      errors: [`${directory}: no agent files (*.yaml or *.yml) found.`],
      warnings: [],
    };
  }
  const result: LoadAgentDirectoryResult = { agents: [], errors: [], warnings: [] };
  const seen = new Map<string, string>();
  for (const name of files) {
    const filePath = join(absolute, name);
    if (!statSync(filePath).isFile()) continue;
    const loaded = loadAgentFile(filePath, { cwd });
    result.errors.push(...loaded.errors);
    result.warnings.push(...loaded.warnings);
    if (!loaded.agent) continue;
    const previous = seen.get(loaded.agent.key);
    if (previous) {
      result.errors.push(
        `${loaded.agent.path}: key: '${loaded.agent.key}' is also defined in ${previous}.`,
      );
      continue;
    }
    seen.set(loaded.agent.key, loaded.agent.path);
    result.agents.push(loaded.agent);
  }
  return result;
}
