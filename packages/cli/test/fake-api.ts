import { createHash } from "node:crypto";
import { ErrorEnvelope } from "@opengeni/contracts";
import {
  ApplyOrgAgentRequest,
  type ApplyOrgAgentResponse,
  canonicalOrgAgentDefinitionJson,
  OrgAgentDefinition,
  type OrgAgentResponse,
} from "@opengeni/contracts/organization-agents";

/**
 * The organization agent routes the fake serves, written exactly as the API
 * registers them (`apps/api/src/routes/organization-agents.ts`, base
 * `/v1/organizations/:organizationId/agents`). A test checks each one is
 * still registered there, so a CLI call to a route the API does not have
 * fails here as it would in production.
 */
export const ORG_AGENTS_BASE = "/v1/organizations/:organizationId/agents";
export const FAKE_API_ROUTES = [
  { method: "GET", suffix: "/by-key/:key" },
  { method: "PUT", suffix: "/by-key/:key/apply" },
  { method: "GET", suffix: "/:agentId" },
] as const;

type Recorded = { method: string; url: string; headers: Record<string, string>; body: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STATUS_CODES: Record<number, string> = {
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation_failed",
};

/** The API's error envelope (`ErrorEnvelope`), with the specific code in `details.code`. */
export function apiError(status: number, detailCode: string | null, message: string): Response {
  const envelope = ErrorEnvelope.parse({
    error: {
      status,
      code: STATUS_CODES[status] ?? "internal_error",
      message,
      retryable: false,
      requestId: "req_fake",
      ...(detailCode ? { details: { code: detailCode } } : {}),
    },
  });
  return Response.json(envelope, { status });
}

function match(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/");
  const have = pathname.split("/");
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of want.entries()) {
    const actual = have[index]!;
    if (segment.startsWith(":")) {
      if (!actual) return null;
      params[segment.slice(1)] = decodeURIComponent(actual);
    } else if (segment !== actual) return null;
  }
  return params;
}

type StoredAgent = {
  id: string;
  versions: { hash: string; definition: unknown }[];
  published: number | null;
};

/** An in-memory organization agents API with the real routes and error envelope. */
export function fakeApi(options: { managedInConsole?: string[] } = {}) {
  const requests: Recorded[] = [];
  const agents = new Map<string, StoredAgent>();

  const agentResponse = (key: string, record: StoredAgent): OrgAgentResponse => {
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
    return {
      agent: {
        id: record.id,
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
    } as OrgAgentResponse;
  };

  const handlers: Record<
    (typeof FAKE_API_ROUTES)[number]["suffix"],
    (params: Record<string, string>, body: unknown) => Response
  > = {
    "/by-key/:key": (params) => {
      const record = agents.get(params.key!);
      if (!record) return apiError(404, "agent_not_found", "Agent not found.");
      return Response.json(agentResponse(params.key!, record));
    },
    "/by-key/:key/apply": (params, body) => {
      const key = params.key!;
      if (options.managedInConsole?.includes(key))
        return apiError(
          409,
          "agent_managed_in_console",
          "This agent is managed in Console; code deploys are refused.",
        );
      const parsed = ApplyOrgAgentRequest.safeParse(body);
      if (!parsed.success) return apiError(422, null, "Request validation failed.");
      const {
        publish,
        moveRunningChats: _move,
        dryRun,
        expectedVersion: _expected,
        ...definition
      } = parsed.data;
      const hash = `sha256:${createHash("sha256").update(canonicalOrgAgentDefinitionJson(definition)).digest("hex")}`;
      const existing = agents.get(key);
      const same = existing?.versions.findIndex((version) => version.hash === hash) ?? -1;
      const outcome = !existing ? "created" : same >= 0 ? "unchanged" : "updated";
      const version: number = same >= 0 ? same + 1 : (existing?.versions.length ?? 0) + 1;
      if (!dryRun) {
        const record = existing ?? { id: crypto.randomUUID(), versions: [], published: null };
        if (same < 0) record.versions.push({ hash, definition });
        if (publish) record.published = version;
        agents.set(key, record);
      }
      const response: ApplyOrgAgentResponse = {
        outcome,
        dryRun,
        configHash: hash,
        version,
        // Like the API: a dry run reports what a real deploy would publish.
        published: dryRun
          ? publish || existing?.published === version
          : agents.get(key)?.published === version,
        agent: null,
        operation: null,
      };
      return Response.json(response, { status: outcome === "created" && !dryRun ? 201 : 200 });
    },
    // Like the API, an agent key here is not an id: 422 `validation_failed`.
    "/:agentId": (params) => {
      if (!UUID.test(params.agentId!)) return apiError(422, "validation_failed", "invalid agentId");
      const found = [...agents].find(([, record]) => record.id === params.agentId!.toLowerCase());
      if (!found) return apiError(404, "agent_not_found", "Agent not found.");
      return Response.json(agentResponse(found[0], found[1]));
    },
  };

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({
      method,
      url: input,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    for (const route of FAKE_API_ROUTES) {
      if (route.method !== method) continue;
      const params = match(`${ORG_AGENTS_BASE}${route.suffix}`, url.pathname);
      if (params) return handlers[route.suffix](params, body);
    }
    return apiError(404, null, "Not found.");
  };
  return { fetch, requests, agents };
}
