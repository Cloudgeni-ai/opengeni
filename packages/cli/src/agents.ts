import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ApplyOrgAgentRequest,
  type ApplyOrgAgentResponse,
  ORG_AGENT_FILE_JSON_SCHEMA_URL,
  OrgAgentDefinition,
  orgAgentDefinitionToFile,
  type OrgAgentResponse,
} from "@opengeni/contracts/organization-agents";
import { stringify } from "yaml";
import { type LoadedAgentFile, loadAgentDirectory } from "./agent-files";
import { type ApiClientOptions, CliApiError, requestJson } from "./api";

export type DeployOptions = {
  directory: string;
  organizationId: string;
  publish: boolean;
  moveRunningChats: boolean;
  dryRun: boolean;
  json: boolean;
  cwd: string;
};

type Output = { stdout(text: string): void; stderr(text: string): void };

export type DeployResult =
  | { key: string; path: string; ok: true; response: ApplyOrgAgentResponse; localHash: string }
  | { key: string; path: string; ok: false; error: string; code?: string; status?: number };

function apiErrorMessage(error: unknown, key: string): { message: string; code?: string; status?: number } {
  if (!(error instanceof CliApiError)) return { message: (error as Error).message ?? String(error) };
  const base = { code: error.code, status: error.status };
  if (error.code === "agent_managed_in_console") {
    return {
      ...base,
      message: `'${key}' is managed in Console, so code deploys are refused. Move it back to code in Console (Agent settings) or remove this file.`,
    };
  }
  if (error.status === 401) return { ...base, message: "the API key was not accepted (401). Check OPENGENI_API_KEY." };
  if (error.status === 403) {
    return {
      ...base,
      message: `the API key may not manage agents in this organization (403${error.code ? ` ${error.code}` : ""}). It needs the agents:manage permission.`,
    };
  }
  return { ...base, message: `${error.message}${error.code ? ` (${error.code})` : ""}${error.status ? ` [HTTP ${error.status}]` : ""}` };
}

function shortHash(hash: string): string {
  return hash.startsWith("sha256:") ? `sha256:${hash.slice(7, 19)}` : hash;
}

function resultLine(result: DeployResult, dryRun: boolean): string {
  if (!result.ok) return `${result.key}\tfailed\t${result.error}`;
  const { response } = result;
  const outcome = dryRun ? `${response.outcome} (dry run)` : response.outcome;
  const version = response.version === null ? "v-" : `v${response.version}`;
  const published = response.published ? "published" : "not published";
  return `${result.key}\t${outcome}\t${version}\t${published}\t${shortHash(response.configHash)}`;
}

/** `opengeni agents deploy <dir>`: validate every file, then apply each agent. */
export async function deployAgents(
  api: ApiClientOptions,
  options: DeployOptions,
  out: Output,
): Promise<{ exitCode: number; results: DeployResult[] }> {
  const loaded = loadAgentDirectory(options.directory, { cwd: options.cwd });
  for (const warning of loaded.warnings) out.stderr(`warning: ${warning}\n`);
  if (loaded.errors.length > 0) {
    for (const error of loaded.errors) out.stderr(`error: ${error}\n`);
    out.stderr(
      `${loaded.errors.length} problem${loaded.errors.length === 1 ? "" : "s"} found; nothing was deployed.\n`,
    );
    return { exitCode: 1, results: [] };
  }
  const results: DeployResult[] = [];
  for (const agent of loaded.agents) {
    const result = await applyAgent(api, options, agent);
    results.push(result);
    if (!options.json) out.stdout(`${resultLine(result, options.dryRun)}\n`);
    if (result.ok && result.response.configHash !== result.localHash) {
      out.stderr(
        `warning: ${agent.path}: the server's config hash ${shortHash(result.response.configHash)} differs from the local ${shortHash(result.localHash)}; update the opengeni package.\n`,
      );
    }
  }
  const failed = results.filter((result) => !result.ok).length;
  if (options.json) {
    out.stdout(
      `${JSON.stringify(
        {
          dryRun: options.dryRun,
          agents: results.map((result) =>
            result.ok
              ? {
                  key: result.key,
                  file: result.path,
                  outcome: result.response.outcome,
                  version: result.response.version,
                  published: result.response.published,
                  configHash: result.response.configHash,
                  operation: result.response.operation,
                }
              : { key: result.key, file: result.path, error: result.error, code: result.code ?? null },
          ),
        },
        null,
        2,
      )}\n`,
    );
  }
  if (failed > 0) out.stderr(`${failed} of ${results.length} agent${results.length === 1 ? "" : "s"} failed.\n`);
  return { exitCode: failed > 0 ? 1 : 0, results };
}

async function applyAgent(
  api: ApiClientOptions,
  options: DeployOptions,
  agent: LoadedAgentFile,
): Promise<DeployResult> {
  const body: ApplyOrgAgentRequest = {
    ...agent.definition,
    publish: options.publish,
    moveRunningChats: options.moveRunningChats,
    dryRun: options.dryRun,
  };
  try {
    const response = await requestJson<ApplyOrgAgentResponse>(
      api,
      "PUT",
      `/v1/organizations/${encodeURIComponent(options.organizationId)}/agents/by-key/${encodeURIComponent(agent.key)}/apply`,
      body,
    );
    return { key: agent.key, path: agent.path, ok: true, response, localHash: agent.configHash };
  } catch (error) {
    const decoded = apiErrorMessage(error, agent.key);
    return {
      key: agent.key,
      path: agent.path,
      ok: false,
      error: decoded.message,
      ...(decoded.code ? { code: decoded.code } : {}),
      ...(decoded.status ? { status: decoded.status } : {}),
    };
  }
}

/** Instructions longer than this, or with several lines, go to `<key>.md`. */
const INLINE_INSTRUCTIONS_MAX = 200;

/**
 * The YAML text (and optional Markdown instructions) for an agent definition,
 * with the schema header editors use for completion and checks.
 */
export function renderAgentFile(
  key: string,
  definition: OrgAgentDefinition,
  options: { splitInstructions?: boolean } = {},
): { yaml: string; markdown?: string } {
  const file = orgAgentDefinitionToFile(key, definition) as Record<string, unknown>;
  let markdown: string | undefined;
  const instructions = file.instructions;
  if (
    options.splitInstructions &&
    typeof instructions === "string" &&
    (instructions.includes("\n") || instructions.length > INLINE_INSTRUCTIONS_MAX)
  ) {
    markdown = instructions.endsWith("\n") ? instructions : `${instructions}\n`;
    file.instructions = `./${key}.md`;
  }
  const yaml = `# yaml-language-server: $schema=${ORG_AGENT_FILE_JSON_SCHEMA_URL}\n${stringify(file, { lineWidth: 0 })}`;
  return markdown === undefined ? { yaml } : { yaml, markdown };
}

/** `opengeni agents export <key> [--out <dir>]`: write `<key>.yaml` from the published (else newest) version. */
export async function exportAgent(
  api: ApiClientOptions,
  options: { key: string; organizationId: string; outDirectory: string | undefined; cwd: string },
  out: Output,
): Promise<number> {
  let response: OrgAgentResponse;
  try {
    response = await requestJson<OrgAgentResponse>(
      api,
      "GET",
      `/v1/organizations/${encodeURIComponent(options.organizationId)}/agents/${encodeURIComponent(options.key)}`,
    );
  } catch (error) {
    const message =
      error instanceof CliApiError && error.status === 404
        ? `agent '${options.key}' was not found in this organization.`
        : apiErrorMessage(error, options.key).message;
    out.stderr(`error: ${message}\n`);
    return 1;
  }
  const { agent } = response;
  const version = agent.published ?? agent.draft;
  if (!version) {
    out.stderr(`error: agent '${agent.key}' has no versions to export.\n`);
    return 1;
  }
  const definition = OrgAgentDefinition.parse({
    name: version.name,
    description: version.description,
    instructions: version.instructions,
    config: version.config,
  });
  if (options.outDirectory === undefined) {
    out.stdout(renderAgentFile(agent.key, definition).yaml);
    return 0;
  }
  const rendered = renderAgentFile(agent.key, definition, { splitInstructions: true });
  const directory = resolve(options.cwd, options.outDirectory);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const yamlPath = join(directory, `${agent.key}.yaml`);
  writeFileSync(yamlPath, rendered.yaml, "utf8");
  if (rendered.markdown !== undefined) writeFileSync(join(directory, `${agent.key}.md`), rendered.markdown, "utf8");
  out.stdout(
    `${agent.key}\texported v${version.version}${agent.published ? "" : " (draft)"}\t${yamlPath}${rendered.markdown !== undefined ? ` (+ ${agent.key}.md)` : ""}\n`,
  );
  return 0;
}
