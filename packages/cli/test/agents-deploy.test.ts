import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApplyOrgAgentRequest,
  type ApplyOrgAgentResponse,
  canonicalOrgAgentDefinitionJson,
  OrgAgentDefinition,
  type OrgAgentResponse,
} from "@opengeni/contracts/organization-agents";
import { loadAgentDirectory, loadAgentFile } from "../src/agent-files";
import { CLI_EXIT, runCli } from "../src/index";

const fixtures = join(import.meta.dir, "fixtures");
const ORG = "1f0e2d3c-4b5a-4968-8776-655443322110";

type Recorded = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** An in-memory `PUT .../agents/by-key/:key/apply` and `GET .../agents/:key`. */
function fakeApi(options: { managedInConsole?: string[] } = {}) {
  const requests: Recorded[] = [];
  const agents = new Map<string, { versions: { hash: string; definition: unknown }[]; published: number | null }>();
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({
      method: init?.method ?? "GET",
      url: input,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    const apply = url.pathname.match(/^\/v1\/organizations\/([^/]+)\/agents\/by-key\/([^/]+)\/apply$/u);
    if (apply && init?.method === "PUT") {
      const key = decodeURIComponent(apply[2]!);
      if (options.managedInConsole?.includes(key)) {
        return Response.json(
          { error: { code: "agent_managed_in_console", message: "This agent is managed in Console." } },
          { status: 409 },
        );
      }
      const request = ApplyOrgAgentRequest.parse(body);
      const { publish, moveRunningChats: _move, dryRun, expectedVersion: _expected, ...definition } = request;
      const hash = `sha256:${createHash("sha256").update(canonicalOrgAgentDefinitionJson(definition)).digest("hex")}`;
      const existing = agents.get(key);
      const same = existing?.versions.findIndex((version) => version.hash === hash) ?? -1;
      const outcome = !existing ? "created" : same >= 0 ? "unchanged" : "updated";
      let version: number | null = same >= 0 ? same + 1 : (existing?.versions.length ?? 0) + 1;
      if (!dryRun) {
        const record = existing ?? { versions: [], published: null };
        if (same < 0) record.versions.push({ hash, definition });
        if (publish) record.published = version;
        agents.set(key, record);
      } else if (outcome !== "unchanged") {
        version = null;
      }
      const response: ApplyOrgAgentResponse = {
        outcome,
        dryRun,
        configHash: hash,
        version,
        published: dryRun ? false : agents.get(key)?.published === version,
        agent: null,
        operation: null,
      };
      return Response.json(response);
    }
    const get = url.pathname.match(/^\/v1\/organizations\/([^/]+)\/agents\/([^/]+)$/u);
    if (get) {
      const key = decodeURIComponent(get[2]!);
      const record = agents.get(key);
      if (!record) return Response.json({ error: { code: "agent_not_found", message: "Not found." } }, { status: 404 });
      const latest = record.versions.length;
      const versionOf = (number: number) => {
        const definition = OrgAgentDefinition.parse(record.versions[number - 1]!.definition);
        return {
          version: number,
          ...definition,
          toolCatalog: null,
          source: "deploy" as const,
          configHash: record.versions[number - 1]!.hash,
          createdBySubjectId: null,
          createdAt: "2026-11-19T10:00:00.000Z",
          publishedAt: record.published === number ? "2026-11-19T10:00:00.000Z" : null,
        };
      };
      const response: OrgAgentResponse = {
        agent: {
          id: "5d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a",
          key,
          name: "x",
          description: "",
          managedBy: "code",
          publishedVersion: record.published,
          latestVersion: latest,
          rowVersion: 1,
          archivedAt: null,
          createdAt: "2026-11-19T10:00:00.000Z",
          updatedAt: "2026-11-19T10:00:00.000Z",
          published: record.published ? versionOf(record.published) : null,
          draft: record.published === latest ? null : versionOf(latest),
          workspaceIds: [],
        },
      };
      return Response.json(response);
    }
    return Response.json({ error: { code: "not_found", message: "No route." } }, { status: 404 });
  };
  return { fetch, requests, agents };
}

async function cli(argv: string[], api: ReturnType<typeof fakeApi>, cwd = fixtures) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {
      OPENGENI_API_KEY: "og_test_key",
      OPENGENI_ORGANIZATION_ID: ORG,
      OPENGENI_BASE_URL: "https://opengeni.test/",
    },
    cwd,
    fetch: api.fetch,
  });
  return { exitCode, stdout, stderr };
}

describe("agent files", () => {
  test("reads Markdown instructions next to the file and converts to a definition", () => {
    const { agent, errors, warnings } = loadAgentFile(join(fixtures, "agents", "support.yaml"), {
      cwd: fixtures,
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(agent?.path).toBe(join("agents", "support.yaml"));
    expect(agent?.key).toBe("support");
    expect(agent?.definition.instructions).toBe(readFileSync(join(fixtures, "agents", "support.md"), "utf8").trim());
    expect(agent?.definition.config.model).toBe("gpt-5.5");
    expect(agent?.definition.config.toolServers.map((server) => server.server)).toEqual(["helpdesk", "billing"]);
    expect(agent?.definition.config.workers).toEqual({ shareInstructions: true });
    expect(agent?.configHash).toBe(
      `sha256:${createHash("sha256").update(canonicalOrgAgentDefinitionJson(agent!.definition)).digest("hex")}`,
    );
  });

  test("reports every problem in every file with its path", () => {
    const result = loadAgentDirectory("invalid-agents", { cwd: fixtures });
    expect(result.agents).toEqual([]);
    const errors = result.errors.join("\n");
    expect(errors).toContain(
      `${join("invalid-agents", "broken.yaml")}:3:1: Flow sequence in block collection must be sufficiently indented and end with a ]\n`,
    );
    expect(errors).toContain(
      `${join("invalid-agents", "duplicate.yaml")}: toolServers[1].server: Tool server 'helpdesk' is listed twice.`,
    );
    expect(errors).toContain(`${join("invalid-agents", "fields.yaml")}: name:`);
    expect(errors).toContain("temperature");
    expect(errors).toContain(`${join("invalid-agents", "fields.yaml")}: toolServers[0].tools`);
    expect(errors).toContain(
      `${join("invalid-agents", "renamed.yaml")}: key: 'support' does not match the file name`,
    );
    expect(result.warnings.join("\n")).toContain("'./missing.md' is not a file next to this agent file");
  });

  test("a missing directory or one without agent files is an error", () => {
    expect(loadAgentDirectory("nope", { cwd: fixtures }).errors).toEqual(["nope: not a directory."]);
    const empty = mkdtempSync(join(tmpdir(), "opengeni-agents-empty-"));
    try {
      expect(loadAgentDirectory(empty).errors[0]).toContain("no agent files");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("opengeni agents deploy", () => {
  test("applies each agent and prints one line per agent", async () => {
    const api = fakeApi();
    const result = await cli(["agents", "deploy", "agents", "--publish"], api);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(CLI_EXIT.ok);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^support\tcreated\tv1\tpublished\tsha256:[0-9a-f]{12}$/u);
    expect(lines[1]).toMatch(/^triage\tcreated\tv1\tpublished\tsha256:[0-9a-f]{12}$/u);

    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `PUT https://opengeni.test/v1/organizations/${ORG}/agents/by-key/support/apply`,
      `PUT https://opengeni.test/v1/organizations/${ORG}/agents/by-key/triage/apply`,
    ]);
    const [first] = api.requests;
    expect(first!.headers.authorization).toBe("Bearer og_test_key");
    expect(first!.headers["content-type"]).toBe("application/json");
    expect(first!.headers["user-agent"]).toStartWith("opengeni-cli/");
    expect(first!.body).toMatchObject({ publish: true, moveRunningChats: false, dryRun: false, name: "Customer support" });
    expect(ApplyOrgAgentRequest.safeParse(first!.body).success).toBe(true);

    // Deploying the same files again is a no-op.
    const again = await cli(["agents", "deploy", "agents"], api);
    expect(again.exitCode).toBe(CLI_EXIT.ok);
    expect(again.stdout).toContain("support\tunchanged\tv1\tpublished");
  });

  test("--dry-run and --move-running-chats are sent, and nothing is saved on a dry run", async () => {
    const api = fakeApi();
    const result = await cli(["agents", "deploy", "agents", "--dry-run", "--publish", "--move-running-chats"], api);
    expect(result.exitCode).toBe(CLI_EXIT.ok);
    expect(result.stdout).toContain("support\tcreated (dry run)\tv-\tnot published");
    expect(api.requests[0]!.body).toMatchObject({ dryRun: true, publish: true, moveRunningChats: true });
    expect(api.agents.size).toBe(0);
  });

  test("--json prints machine-readable results", async () => {
    const api = fakeApi();
    const result = await cli(["agents", "deploy", "agents", "--json"], api);
    expect(result.exitCode).toBe(CLI_EXIT.ok);
    const parsed = JSON.parse(result.stdout) as { dryRun: boolean; agents: { key: string; outcome: string; configHash: string }[] };
    expect(parsed.dryRun).toBe(false);
    expect(parsed.agents.map((agent) => [agent.key, agent.outcome])).toEqual([
      ["support", "created"],
      ["triage", "created"],
    ]);
  });

  test("an agent managed in Console fails with a clear message and a non-zero exit", async () => {
    const api = fakeApi({ managedInConsole: ["support"] });
    const result = await cli(["agents", "deploy", "agents"], api);
    expect(result.exitCode).toBe(CLI_EXIT.failed);
    expect(result.stdout).toContain("support\tfailed\t'support' is managed in Console");
    expect(result.stdout).toContain("triage\tcreated");
    expect(result.stderr).toContain("1 of 2 agents failed.");
  });

  test("invalid files are all reported and nothing is sent", async () => {
    const api = fakeApi();
    const result = await cli(["agents", "deploy", "invalid-agents"], api);
    expect(result.exitCode).toBe(CLI_EXIT.failed);
    expect(api.requests).toEqual([]);
    expect(result.stderr).toContain("broken.yaml");
    expect(result.stderr).toContain("fields.yaml");
    expect(result.stderr).toContain("renamed.yaml");
    expect(result.stderr).toContain("nothing was deployed");
  });

  test("an unreachable API fails each agent without throwing", async () => {
    const api = {
      ...fakeApi(),
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const result = await cli(["agents", "deploy", "agents"], api);
    expect(result.exitCode).toBe(CLI_EXIT.failed);
    expect(result.stdout).toContain("cannot reach https://opengeni.test/");
  });
});

describe("opengeni agents export", () => {
  let outDirectory: string | undefined;
  afterEach(() => {
    if (outDirectory) rmSync(outDirectory, { recursive: true, force: true });
    outDirectory = undefined;
  });

  test("an exported agent deploys back to the same config hash", async () => {
    const api = fakeApi();
    expect((await cli(["agents", "deploy", "agents", "--publish"], api)).exitCode).toBe(0);
    const deployedHash = api.agents.get("support")!.versions[0]!.hash;

    outDirectory = mkdtempSync(join(tmpdir(), "opengeni-agents-export-"));
    const exported = await cli(["agents", "export", "support", "--out", outDirectory], api);
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain("support\texported v1");
    const yaml = readFileSync(join(outDirectory, "support.yaml"), "utf8");
    expect(yaml).toStartWith("# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/opengeni/schemas/agent.schema.json\n");
    expect(yaml).toContain("instructions: ./support.md");
    expect(readFileSync(join(outDirectory, "support.md"), "utf8")).toContain("Search the help center");

    const reloaded = loadAgentFile(join(outDirectory, "support.yaml"));
    expect(reloaded.errors).toEqual([]);
    expect(reloaded.agent?.configHash).toBe(deployedHash);

    const redeploy = await cli(["agents", "deploy", outDirectory], api);
    expect(redeploy.stdout).toContain("support\tunchanged\tv1");
  });

  test("prints YAML to stdout without --out, and reports an unknown agent", async () => {
    const api = fakeApi();
    await cli(["agents", "deploy", "agents"], api);
    const printed = await cli(["agents", "export", "triage"], api);
    expect(printed.exitCode).toBe(0);
    expect(printed.stdout).toContain("key: triage\nname: Triage\ninstructions: Sort incoming requests by urgency.\n");
    const missing = await cli(["agents", "export", "nobody"], api);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("agent 'nobody' was not found");
  });
});

describe("end to end", () => {
  test("the executable dry-runs a directory against an HTTP API", async () => {
    const received: { path: string; body: { dryRun: boolean; name: string } }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as { dryRun: boolean; name: string };
        received.push({ path: new URL(request.url).pathname, body });
        const parsed = ApplyOrgAgentRequest.parse(body);
        const { publish: _p, moveRunningChats: _m, dryRun, expectedVersion: _e, ...definition } = parsed;
        return Response.json({
          outcome: "updated",
          dryRun,
          configHash: `sha256:${createHash("sha256").update(canonicalOrgAgentDefinitionJson(definition)).digest("hex")}`,
          version: null,
          published: false,
          agent: null,
          operation: null,
        } satisfies ApplyOrgAgentResponse);
      },
    });
    try {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "..", "src", "bin.ts"), "agents", "deploy", "agents", "--dry-run"],
        {
          cwd: fixtures,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            OPENGENI_API_KEY: "og_test_key",
            OPENGENI_ORGANIZATION_ID: ORG,
            OPENGENI_BASE_URL: `http://127.0.0.1:${server.port}`,
          },
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).toMatch(/^support\tupdated \(dry run\)\tv-\tnot published\tsha256:[0-9a-f]{12}\ntriage\t/u);
      expect(received.map((entry) => entry.path)).toEqual([
        `/v1/organizations/${ORG}/agents/by-key/support/apply`,
        `/v1/organizations/${ORG}/agents/by-key/triage/apply`,
      ]);
      expect(received.every((entry) => entry.body.dryRun)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
